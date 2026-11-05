/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from './anchors';
import { CheckConfig } from './config';

const SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules']);

/** `**` matches any number of path segments, `*` and `?` stay within one segment. */
export function globToRegExp(glob: string): RegExp {
	let source = '';
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === '*' && glob[i + 1] === '*') {
			source += glob[i + 2] === '/' ? '(?:.*/)?' : '.*';
			i += glob[i + 2] === '/' ? 2 : 1;
		} else if (char === '*') {
			source += '[^/]*';
		} else if (char === '?') {
			source += '[^/]';
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp(`^${source}$`);
}

function walk(root: string, directory: string, files: string[]): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(path.join(root, directory), { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const relative = directory ? `${directory}/${entry.name}` : entry.name;
		if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) {
			walk(root, relative, files);
		} else if (entry.isFile()) {
			files.push(relative);
		}
	}
}

/** Workspace-relative files matching any of `globs`, sorted. */
export function listInputs(root: string, globs: readonly string[]): string[] {
	const matched = new Set<string>();
	for (const glob of globs) {
		const segments = glob.split('/');
		const firstWild = segments.findIndex(segment => /[*?]/.test(segment));
		if (firstWild === -1) {
			if (fs.existsSync(path.join(root, glob))) {
				matched.add(glob);
			}
			continue;
		}
		const files: string[] = [];
		walk(root, segments.slice(0, firstWild).join('/'), files);
		const pattern = globToRegExp(glob);
		files.filter(file => pattern.test(file)).forEach(file => matched.add(file));
	}
	return [...matched].sort();
}

/** Hash of what a check is: its kind, command and the content of its input files. */
export function hashCheckInputs(root: string, check: CheckConfig | undefined, readFile: (file: string) => string | undefined): string {
	if (!check) {
		return 'missing';
	}
	const files = listInputs(root, check.inputs).map(file => [file, sha256(readFile(file) ?? '')]);
	return sha256(JSON.stringify({ kind: check.kind, command: check.command ?? '', ...(check.permittedAxioms !== undefined ? { permittedAxioms: check.permittedAxioms } : {}), files }));
}
