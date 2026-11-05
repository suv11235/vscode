/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { runCommand } from './checks';
import { CheckConfig } from './config';
import { FormalLink } from './model';

const DECLARATION_KEYWORDS = 'theorem|lemma|def|abbrev|instance|example|structure|inductive|class|opaque|axiom';
const MODIFIERS = '(?:(?:private|protected|noncomputable|partial|unsafe)\\s+)*';
/** A line that starts a new top-level command, which ends the previous declaration. */
const TOP_LEVEL = new RegExp(`^(?:@\\[|/--|#|${MODIFIERS}(?:${DECLARATION_KEYWORDS}|namespace|section|end|open|variable|universe|set_option|attribute|macro|syntax|notation|elab|import)\\b)`);

function escape(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Lines (1-based, inclusive) of a top-level declaration, matched by its full name or its
 * last name component, including attributes and doc comment directly above it.
 */
export function locateDeclaration(content: string, declaration: string): { startLine: number; endLine: number } | undefined {
	const lines = content.replace(/\r\n?/g, '\n').split('\n');
	const shortName = declaration.split('.').pop()!;
	const header = new RegExp(`^(?:@\\[[^\\]]*\\]\\s*)?${MODIFIERS}(?:${DECLARATION_KEYWORDS})\\s+(?:${escape(declaration)}|${escape(shortName)})(?=[\\s:({\\[]|$)`);
	const start = lines.findIndex(line => header.test(line));
	if (start === -1) {
		return undefined;
	}
	// Include attribute lines and a doc comment directly above the declaration.
	let first = start;
	for (; ;) {
		if (first > 0 && /^@\[/.test(lines[first - 1])) {
			first--;
			continue;
		}
		if (first > 0 && /-\/\s*$/.test(lines[first - 1])) {
			let open = first - 1;
			while (open > 0 && !/^\/--/.test(lines[open])) {
				open--;
			}
			if (/^\/--/.test(lines[open])) {
				first = open;
				continue;
			}
		}
		break;
	}
	let end = start + 1;
	while (end < lines.length && !TOP_LEVEL.test(lines[end])) {
		end++;
	}
	while (end - 1 > start && !lines[end - 1].trim()) {
		end--;
	}
	return { startLine: first + 1, endLine: end };
}

export interface LeanResult {
	readonly result: 'pass' | 'fail';
	readonly summary: string;
	readonly output: string;
	readonly command: string;
}

/**
 * Compiles the declaration's file with `#print axioms` appended. It passes only when Lean
 * exits successfully and reports no errors; `sorryAx` is always rejected.
 * When configured, every reported dependency must be in `permittedAxioms`.
 */
export async function runLeanCheck(root: string, formal: FormalLink, check: CheckConfig, timeoutSeconds: number): Promise<LeanResult> {
	const source = path.join(root, formal.file);
	const lean = check.command ?? (['lakefile.lean', 'lakefile.toml'].some(file => fs.existsSync(path.join(root, file))) ? 'lake env lean' : 'lean');
	const probe = path.join(path.dirname(source), `.prooftree-${randomBytes(4).toString('hex')}.lean`);
	const command = `${lean} ${JSON.stringify(path.relative(root, probe))}`;
	fs.writeFileSync(probe, `${fs.readFileSync(source, 'utf8')}\n\n#print axioms ${formal.declaration}\n`);
	try {
		const run = await runCommand(command, root, timeoutSeconds);
		const output = run.output.split(path.basename(probe)).join(path.basename(source));
		const errors = output.split('\n').filter(line => /(^|:\d+:\d+: )error\b/.test(line));
		const axioms = new RegExp(`'${escape(formal.declaration)}' depends on axioms: \\[([^\\]]*)\\]`).exec(output);
		const dependencies = axioms?.[1].split(',').map(name => name.trim()).filter(Boolean) ?? [];
		const rejected = dependencies.filter(name => check.permittedAxioms !== undefined && !check.permittedAxioms.includes(name));
		const noAxioms = new RegExp(`'${escape(formal.declaration)}' does not depend on any axioms`).test(output);
		let result: LeanResult['result'] = 'fail';
		let summary: string;
		if (run.timedOut) {
			summary = `Lean timed out after ${timeoutSeconds}s`;
		} else if (errors.length) {
			summary = `Lean error: ${errors[0].replace(/^.*?error:\s*/, '').slice(0, 160)}`;
		} else if (run.exitCode !== 0) {
			summary = `Lean exited with code ${run.exitCode ?? 'unknown'}`;
		} else if (dependencies.includes('sorryAx')) {
			summary = `${formal.declaration} uses sorry`;
		} else if (rejected.length) {
			summary = `${formal.declaration} depends on unpermitted axioms: ${rejected.join(', ')}`;
		} else if (axioms || noAxioms) {
			result = 'pass';
			summary = `${formal.declaration} proved` + (axioms ? ` (axioms: ${axioms[1].trim()})` : ' (no axioms)');
		} else {
			summary = `Lean did not report on ${formal.declaration}; is the name right?`;
		}
		return { result, summary, output, command: `${lean} ${formal.file}` };
	} finally {
		fs.rmSync(probe, { force: true });
	}
}
