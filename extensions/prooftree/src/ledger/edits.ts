/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256, splitLines } from './anchors';
import { EditRecord, EditSpan } from './model';
import { ClaimReport, ClaimStatus, ReadFile } from './status';

/**
 * Where agent-written lines are now, and what evidence covers them. Spans are followed line
 * by line: a line counts while its text is unchanged, so editing part of an agent's edit
 * leaves the rest tracked. Changed lines drop out; a person wrote them, or an agent did and
 * they were recorded again under a new record.
 */

/**
 * - `reviewed`: a person reviewed these exact lines.
 * - `covered`: nobody reviewed the lines, but they are in the code of a claim that is
 *   checked or approved as the code is now.
 * - `unverified`: only the agent vouches for them.
 */
export type EditStatus = 'unverified' | 'covered' | 'reviewed';

export interface EditReport {
	readonly file: string;
	/** Current lines, 1-based and inclusive. */
	readonly startLine: number;
	readonly endLine: number;
	readonly status: EditStatus;
	/** The record that wrote or kept these lines. */
	readonly source: EditRecord;
	/** The review of these lines, when they were reviewed. */
	readonly review?: EditRecord;
	/** Claims with current evidence whose code includes these lines. */
	readonly claims: readonly string[];
}

/** Claim statuses whose own evidence vouches for the anchored code: a passing check or a person's approval. */
const EVIDENCE: readonly ClaimStatus[] = ['checked', 'reviewed'];

/** How far from its recorded place a partly changed span is looked for. */
const SEARCH_WINDOW = 200;
/** Long spans are followed in chunks, which keeps line matching cheap. */
const CHUNK = 64;
/** Above this many line pairs, a rewrite is not diffed line by line and all of it counts as changed. */
const MAX_DIFF_CELLS = 4_000_000;

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

/** Pairs of indexes of equal lines in `a` and `b`, in order: a longest common subsequence. */
function commonLines(a: readonly string[], b: readonly string[]): { a: number; b: number }[] {
	// common[i][j]: longest common subsequence of a[i..] and b[j..]
	const common = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			common[i][j] = a[i] === b[j] ? common[i + 1][j + 1] + 1 : Math.max(common[i + 1][j], common[i][j + 1]);
		}
	}
	const pairs: { a: number; b: number }[] = [];
	for (let i = 0, j = 0; i < a.length && j < b.length;) {
		if (a[i] === b[j]) {
			pairs.push({ a: i++, b: j++ });
		} else if (common[i + 1][j] >= common[i][j + 1]) {
			i++;
		} else {
			j++;
		}
	}
	return pairs;
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
	if (to < from) {
		return [];
	}
	const matched = commonLines(span.lines, fileHashes.slice(from - 1, to)).map(pair => ({ index: pair.a, line: from + pair.b }));
	const shift = (k: number) => matched[k] && matched[k].line - matched[k].index;
	return matched
		.filter((match, k) => !isTrivial(fileLines[match.line - 1]) || shift(k) === shift(k - 1) || shift(k) === shift(k + 1))
		.map(match => match.line);
}

/**
 * Lines of `after` that are not in `before`, as runs of 1-based inclusive line numbers. Runs
 * of blank lines alone are left out.
 */
export function changedLines(before: string, after: string): { startLine: number; endLine: number }[] {
	const old = splitLines(before);
	const lines = splitLines(after);
	let prefix = 0;
	while (prefix < old.length && prefix < lines.length && old[prefix] === lines[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < old.length - prefix && suffix < lines.length - prefix && old[old.length - 1 - suffix] === lines[lines.length - 1 - suffix]) {
		suffix++;
	}
	const removed = old.slice(prefix, old.length - suffix);
	const added = lines.slice(prefix, lines.length - suffix);
	const kept = new Set(removed.length * added.length <= MAX_DIFF_CELLS ? commonLines(removed, added).map(pair => pair.b) : []);

	const runs: { startLine: number; endLine: number }[] = [];
	let run: { startLine: number; endLine: number; blank: boolean } | undefined;
	const flush = () => {
		if (run && !run.blank) {
			runs.push({ startLine: run.startLine, endLine: run.endLine });
		}
		run = undefined;
	};
	added.forEach((line, index) => {
		if (kept.has(index)) {
			flush();
			return;
		}
		const lineNumber = prefix + index + 1;
		if (run) {
			run.endLine = lineNumber;
			run.blank &&= !line.trim();
		} else {
			run = { startLine: lineNumber, endLine: lineNumber, blank: !line.trim() };
		}
	});
	flush();
	return runs;
}

/** Lines of each file that claims with current evidence are about. Whole-file anchors cover every line. */
function coverage(claims: Iterable<ClaimReport>): Map<string, { startLine: number; endLine: number; claim: string }[]> {
	const byFile = new Map<string, { startLine: number; endLine: number; claim: string }[]>();
	for (const report of claims) {
		if (!EVIDENCE.includes(report.status)) {
			continue;
		}
		for (const anchor of report.anchors) {
			if (anchor.kind === 'intact' || anchor.kind === 'moved') {
				const range = { startLine: anchor.startLine ?? 1, endLine: anchor.endLine ?? Number.MAX_SAFE_INTEGER, claim: report.claim.id };
				byFile.set(anchor.anchor.file, [...(byFile.get(anchor.anchor.file) ?? []), range]);
			}
		}
	}
	return byFile;
}

/**
 * Agent-written lines in each file, grouped into runs with the same source, review and
 * covering claims. `claims` are the evaluated claims, whose evidence can cover the lines.
 */
export function evaluateEdits(records: readonly EditRecord[], readFile: ReadFile, claims: Iterable<ClaimReport> = []): EditReport[] {
	const byFile = new Map<string, { record: EditRecord; span: EditSpan }[]>();
	for (const record of records) {
		for (const span of record.spans) {
			byFile.set(span.file, [...(byFile.get(span.file) ?? []), { record, span }]);
		}
	}
	const covered = coverage(claims);

	const reports: EditReport[] = [];
	for (const [file, entries] of byFile) {
		const content = readFile(file);
		if (content === undefined) {
			continue;
		}
		const fileLines = splitLines(content);
		const fileHashes = fileLines.map(lineHash);
		const source = new Map<number, EditRecord>();
		const reviewed = new Map<number, EditRecord>();
		for (const { record, span } of entries) {
			for (const line of locateSpan(span, fileLines, fileHashes)) {
				// A later review does not change who wrote or kept the lines; writing or keeping them again does.
				if (!record.reviewOf || !source.has(line)) {
					source.set(line, record);
				}
				if (record.decision === 'reviewed') {
					reviewed.set(line, record);
				}
			}
		}

		const ranges = covered.get(file) ?? [];
		let current: { startLine: number; endLine: number; source: EditRecord; review?: EditRecord; claims: string[] } | undefined;
		const flush = () => {
			if (current) {
				reports.push({ file, ...current, status: current.review ? 'reviewed' : current.claims.length ? 'covered' : 'unverified' });
			}
		};
		for (const line of [...source.keys()].sort((a, b) => a - b)) {
			const sourceRecord = source.get(line)!;
			const review = reviewed.get(line);
			const claimIds = [...new Set(ranges.filter(range => range.startLine <= line && line <= range.endLine).map(range => range.claim))];
			if (current && line === current.endLine + 1 && current.source === sourceRecord && current.review === review && current.claims.join() === claimIds.join()) {
				current.endLine = line;
			} else {
				flush();
				current = { startLine: line, endLine: line, source: sourceRecord, review, claims: claimIds };
			}
		}
		flush();
	}
	return reports.sort((a, b) => a.file.localeCompare(b.file) || a.startLine - b.startLine);
}

/** `12` or `12-18`. */
export function editLines(report: EditReport): string {
	return report.startLine === report.endLine ? `${report.startLine}` : `${report.startLine}-${report.endLine}`;
}

/** The model or agent that wrote the lines. */
export function writerOf(record: EditRecord): string {
	return record.model ?? record.agent ?? (record.by.kind === 'agent' ? record.by.name : 'an agent');
}

/** How the lines got into the code: written by an agent's tool, or kept by a person in the editor. */
export function describeSource(record: EditRecord): string {
	const date = record.at.slice(0, 10);
	return record.decision === 'written'
		? `written by ${writerOf(record)}${record.tool ? ` (${record.tool})` : ''} on ${date}`
		: `written by ${writerOf(record)}, kept by ${record.by.name} on ${date}`;
}

/** Where the lines are, how they got there and what covers them, for people and CI annotations. */
export function describeEdit(report: EditReport): string {
	const lines = report.startLine === report.endLine ? `line ${report.startLine}` : `lines ${report.startLine}-${report.endLine}`;
	const evidence = report.review
		? `reviewed by ${report.review.by.name} on ${report.review.at.slice(0, 10)}`
		: report.claims.length ? `covered by ${report.claims.join(', ')}` : 'no review and no passing check';
	return `${report.file} ${lines}: ${describeSource(report.source)}; ${evidence}`;
}
