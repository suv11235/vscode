/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256, splitLines } from './anchors';
import { EditRecord, EditSpan } from './model';
import { ReadFile } from './status';

/**
 * Where kept agent edits are now, and whether a person reviewed them. Spans are followed line
 * by line: a line counts while its text is unchanged, so editing part of a kept hunk leaves the
 * rest tracked. Changed lines drop out; a person wrote them, or an agent did and they were kept
 * again under a new record.
 */

export type EditStatus = 'unreviewed' | 'reviewed';

export interface EditReport {
	readonly file: string;
	/** Current lines, 1-based and inclusive. */
	readonly startLine: number;
	readonly endLine: number;
	readonly status: EditStatus;
	/** The record that kept these lines. */
	readonly kept: EditRecord;
	/** The review of these lines, when they were reviewed. */
	readonly review?: EditRecord;
}

/** How far from its recorded place a partly changed span is looked for. */
const SEARCH_WINDOW = 200;
/** Long spans are followed in chunks, which keeps line matching cheap. */
const CHUNK = 64;

export function lineHash(line: string): string {
	return sha256(line).slice(0, 16);
}

export function createEditSpan(file: string, content: string, startLine: number, endLine: number): EditSpan {
	const lines = splitLines(content);
	if (startLine < 1 || endLine < startLine || endLine > lines.length) {
		throw new Error(`Lines ${startLine}-${endLine} are outside ${file}, which has ${lines.length} lines.`);
	}
	return { file, startLine, endLine, lines: lines.slice(startLine - 1, endLine).map(lineHash) };
}

function isTrivial(line: string): boolean {
	return line.trim().length <= 2;
}

/**
 * Current line numbers of the span's lines that are still in the file. The whole span is
 * looked for first, nearest to where it was; failing that, lines are matched in order
 * (longest common subsequence) near where it was. Short lines such as `}` count only where
 * they keep their place next to a matched neighbor, so they do not match stray braces.
 */
export function locateSpan(span: EditSpan, fileLines: readonly string[], fileHashes: readonly string[]): number[] {
	if (span.lines.length > CHUNK) {
		const located = new Set<number>();
		for (let offset = 0; offset < span.lines.length; offset += CHUNK) {
			const lines = span.lines.slice(offset, offset + CHUNK);
			const startLine = span.startLine + offset;
			locateSpan({ ...span, startLine, endLine: startLine + lines.length - 1, lines }, fileLines, fileHashes).forEach(line => located.add(line));
		}
		return [...located].sort((a, b) => a - b);
	}

	const count = span.lines.length;
	const matchesAt = (start: number) => {
		if (start < 1 || start + count - 1 > fileHashes.length) {
			return false;
		}
		return span.lines.every((hash, index) => fileHashes[start - 1 + index] === hash);
	};
	const whole = (start: number) => Array.from({ length: count }, (_, index) => start + index);
	if (matchesAt(span.startLine)) {
		return whole(span.startLine);
	}
	for (let distance = 1; distance < fileHashes.length; distance++) {
		for (const start of [span.startLine - distance, span.startLine + distance]) {
			if (matchesAt(start)) {
				// Blank lines and lone braces turn up everywhere; they only count where they were.
				return whole(start).some(line => !isTrivial(fileLines[line - 1])) ? whole(start) : [];
			}
		}
	}

	const from = Math.max(1, span.startLine - SEARCH_WINDOW);
	const to = Math.min(fileHashes.length, span.endLine + SEARCH_WINDOW);
	const width = to - from + 1;
	if (width <= 0) {
		return [];
	}
	// common[i][j]: longest common subsequence of span lines i.. and file lines from + j..
	const common = Array.from({ length: count + 1 }, () => new Uint16Array(width + 1));
	for (let i = count - 1; i >= 0; i--) {
		for (let j = width - 1; j >= 0; j--) {
			common[i][j] = span.lines[i] === fileHashes[from - 1 + j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
		}
	}
	const matched: { index: number; line: number }[] = [];
	for (let i = 0, j = 0; i < count && j < width;) {
		if (span.lines[i] === fileHashes[from - 1 + j]) {
			matched.push({ index: i, line: from + j });
			i++;
			j++;
		} else if (common[i + 1][j] >= common[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	const shift = (k: number) => matched[k] && matched[k].line - matched[k].index;
	return matched
		.filter((match, k) => !isTrivial(fileLines[match.line - 1]) || shift(k) === shift(k - 1) || shift(k) === shift(k + 1))
		.map(match => match.line);
}

/** Kept agent lines in each file, grouped into runs with the same keep and review. */
export function evaluateEdits(records: readonly EditRecord[], readFile: ReadFile): EditReport[] {
	const byFile = new Map<string, { record: EditRecord; span: EditSpan }[]>();
	for (const record of records) {
		for (const span of record.spans) {
			byFile.set(span.file, [...(byFile.get(span.file) ?? []), { record, span }]);
		}
	}

	const reports: EditReport[] = [];
	for (const [file, entries] of byFile) {
		const content = readFile(file);
		if (content === undefined) {
			continue;
		}
		const fileLines = splitLines(content);
		const fileHashes = fileLines.map(lineHash);
		const kept = new Map<number, EditRecord>();
		const reviewed = new Map<number, EditRecord>();
		for (const { record, span } of entries) {
			for (const line of locateSpan(span, fileLines, fileHashes)) {
				// A later review does not change who kept the lines; keeping them again does.
				if (!record.reviewOf || !kept.has(line)) {
					kept.set(line, record);
				}
				if (record.decision === 'reviewed') {
					reviewed.set(line, record);
				}
			}
		}

		let current: { startLine: number; endLine: number; kept: EditRecord; review?: EditRecord } | undefined;
		const flush = () => {
			if (current) {
				reports.push({ file, ...current, status: current.review ? 'reviewed' : 'unreviewed' });
			}
		};
		for (const line of [...kept.keys()].sort((a, b) => a - b)) {
			const keptBy = kept.get(line)!;
			const review = reviewed.get(line);
			if (current && line === current.endLine + 1 && current.kept === keptBy && current.review === review) {
				current.endLine = line;
			} else {
				flush();
				current = { startLine: line, endLine: line, kept: keptBy, review };
			}
		}
		flush();
	}
	return reports.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
}

/** Who wrote and kept the lines, for people and CI annotations. */
export function describeEdit(report: EditReport): string {
	const lines = report.startLine === report.endLine ? `line ${report.startLine}` : `lines ${report.startLine}-${report.endLine}`;
	const writer = report.kept.model ?? report.kept.agent ?? 'an agent';
	const kept = `kept by ${report.kept.by.name} on ${report.kept.at.slice(0, 10)}`;
	const review = report.review ? `, reviewed by ${report.review.by.name} on ${report.review.at.slice(0, 10)}` : ', not reviewed';
	return `${report.file} ${lines}: written by ${writer}, ${kept}${review}`;
}
