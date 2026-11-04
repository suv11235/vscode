/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'crypto';
import { Anchor } from './model';

export function sha256(text: string): string {
	return createHash('sha256').update(text, 'utf8').digest('hex');
}

function splitLines(content: string): string[] {
	return content.replace(/\r\n?/g, '\n').split('\n');
}

function hashLines(lines: readonly string[], startLine: number, endLine: number): string {
	return sha256(lines.slice(startLine - 1, endLine).join('\n'));
}

/**
 * - `intact`: the anchored text is where it was.
 * - `moved`: the same text is elsewhere in the file (lines were inserted or removed above it).
 * - `changed`: the anchored text no longer exists; the claim must be re-anchored.
 * - `missing`: the file is gone.
 */
export type AnchorStateKind = 'intact' | 'moved' | 'changed' | 'missing';

export interface AnchorState {
	readonly anchor: Anchor;
	readonly kind: AnchorStateKind;
	/** Where the anchor is now (1-based, inclusive). Whole-file and missing anchors have none. */
	readonly startLine?: number;
	readonly endLine?: number;
	/** Hash of the covered text now; equals `anchor.hash` unless the text changed. */
	readonly currentHash: string;
}

export function createAnchor(file: string, content: string, startLine?: number, endLine?: number): Anchor {
	if (startLine === undefined) {
		return { file, hash: sha256(splitLines(content).join('\n')) };
	}
	const lines = splitLines(content);
	const end = endLine ?? startLine;
	if (startLine < 1 || end < startLine || end > lines.length) {
		throw new Error(`Lines ${startLine}-${end} are outside ${file}, which has ${lines.length} lines.`);
	}
	return { file, startLine, endLine: end, hash: hashLines(lines, startLine, end) };
}

export function resolveAnchor(anchor: Anchor, content: string | undefined): AnchorState {
	if (content === undefined) {
		return { anchor, kind: 'missing', currentHash: 'missing' };
	}
	const lines = splitLines(content);
	if (anchor.startLine === undefined || anchor.endLine === undefined) {
		const currentHash = sha256(lines.join('\n'));
		return { anchor, kind: currentHash === anchor.hash ? 'intact' : 'changed', currentHash };
	}

	const length = anchor.endLine - anchor.startLine + 1;
	const here = anchor.endLine <= lines.length ? hashLines(lines, anchor.startLine, anchor.endLine) : undefined;
	if (here === anchor.hash) {
		return { anchor, kind: 'intact', startLine: anchor.startLine, endLine: anchor.endLine, currentHash: here };
	}

	// Look for the same block nearest to where it was.
	for (let distance = 1; distance < lines.length; distance++) {
		for (const start of [anchor.startLine - distance, anchor.startLine + distance]) {
			const end = start + length - 1;
			if (start >= 1 && end <= lines.length && hashLines(lines, start, end) === anchor.hash) {
				return { anchor, kind: 'moved', startLine: start, endLine: end, currentHash: anchor.hash };
			}
		}
	}

	const startLine = Math.min(anchor.startLine, lines.length);
	const endLine = Math.min(anchor.endLine, lines.length);
	return { anchor, kind: 'changed', startLine, endLine, currentHash: here ?? hashLines(lines, startLine, endLine) };
}
