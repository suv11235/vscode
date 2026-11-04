/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { createAnchor } from './anchors';
import { runCommand } from './checks';
import { CheckConfig, parseConfig, ProoftreeConfig } from './config';
import { hashCheckInputs } from './inputs';
import { locateDeclaration, runLeanCheck } from './lean';
import { CONFIG_FILE, LEDGER_DIR, LEDGER_FILE, LedgerState, newId, readLedger, serializeRecord } from './ledger';
import { Actor, Anchor, ClaimRecord, EvidenceRecord, FormalLink, LedgerRecord, RetractRecord, ReviewRecord } from './model';
import { ClaimReport, dependentsOf, descendantsOf, evaluateLedger, ReadFile } from './status';

export interface AnchorInput {
	readonly file: string;
	readonly startLine?: number;
	readonly endLine?: number;
}

export interface DeclareClaimInput {
	readonly statement: string;
	/** Code the claim is about. A goal stated only through its steps may have none. */
	readonly anchors?: readonly AnchorInput[];
	readonly dependsOn?: readonly string[];
	readonly parent?: string;
	readonly reasoning?: readonly string[];
	readonly formal?: FormalLink;
	readonly session?: string;
}

export interface DecomposeInput extends DeclareClaimInput {
	readonly steps: readonly DeclareClaimInput[];
}

export interface UpdateClaimInput {
	readonly claim: string;
	readonly statement?: string;
	/** Omitted anchors are re-taken over their current location. */
	readonly anchors?: readonly AnchorInput[];
	readonly dependsOn?: readonly string[];
	readonly reasoning?: readonly string[];
	readonly formal?: FormalLink;
}

export interface CheckOutcome {
	readonly evidence: EvidenceRecord;
	/** Output of the check, for showing on failure. */
	readonly output: string;
	readonly report: ClaimReport;
}

/**
 * All reads and writes of a workspace's ledger. The VS Code extension, the agent hook
 * command, CI and the MCP server share this class, so they agree on every status.
 */
export class ProoftreeService {

	readonly ledgerPath: string;
	readonly configPath: string;

	/**
	 * @param overlay Unsaved editor contents, consulted before the file on disk.
	 */
	constructor(readonly root: string, private readonly overlay: ReadFile = () => undefined) {
		this.ledgerPath = path.join(root, LEDGER_DIR, LEDGER_FILE);
		this.configPath = path.join(root, LEDGER_DIR, CONFIG_FILE);
	}

	config(): ProoftreeConfig {
		return parseConfig(readIfExists(this.configPath));
	}

	state(): LedgerState {
		return readLedger(readIfExists(this.ledgerPath) ?? '');
	}

	evaluate(state = this.state()): Map<string, ClaimReport> {
		const config = this.config();
		const inputs = new Map<string, string>();
		return evaluateLedger(state, file => this.readFile(file), {
			accept: config.gate.accept,
			checkInputs: check => {
				if (!inputs.has(check)) {
					inputs.set(check, this.checkInputs(config.checks[check]));
				}
				return inputs.get(check)!;
			},
		});
	}

	report(claimId: string, reports = this.evaluate()): ClaimReport {
		const report = reports.get(claimId);
		if (!report) {
			throw new Error(`No open claim ${claimId}. Use list obligations or status to see claim ids.`);
		}
		return report;
	}

	readFile(file: string): string | undefined {
		return this.overlay(file) ?? readIfExists(path.join(this.root, file));
	}

	/** Workspace-relative POSIX path for an absolute or relative path inside the workspace. */
	relativePath(file: string): string {
		const absolute = path.resolve(this.root, file);
		const relative = path.relative(this.root, absolute);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			throw new Error(`${file} is outside the workspace ${this.root}.`);
		}
		return relative.split(path.sep).join('/');
	}

	declareClaim(input: DeclareClaimInput, by: Actor): ClaimReport {
		const claim = this.newClaim(this.state(), input, by);
		this.append(claim);
		return this.report(claim.id);
	}

	/** States a goal and its steps in one go, like a Prooftree statement and its outline. */
	decompose(input: DecomposeInput, by: Actor): ClaimReport[] {
		if (!input.steps.length) {
			throw new Error('Give at least one step; otherwise declare a single claim.');
		}
		const state = this.state();
		const goal = this.newClaim(state, input, by);
		// Validate every step before writing anything, so a bad step leaves no half-stated goal.
		const steps = input.steps.map(step => this.newClaim(state, { ...step, parent: undefined }, by));
		this.append(goal);
		steps.forEach(step => this.append({ ...step, parent: goal.id }));
		const reports = this.evaluate();
		return [goal, ...steps].map(claim => this.report(claim.id, reports));
	}

	updateClaim(input: UpdateClaimInput, by: Actor): ClaimReport {
		const state = this.state();
		const previous = state.claims.get(input.claim);
		if (!previous || state.retracted.has(input.claim)) {
			throw new Error(`No open claim ${input.claim}.`);
		}
		const current = this.report(input.claim, this.evaluate(state));
		const anchors = input.anchors ?? current.anchors.filter(anchor => anchor.anchor.role !== 'formal').map(anchor => {
			if (anchor.kind === 'missing') {
				throw new Error(`${anchor.anchor.file} no longer exists; pass new anchors for ${input.claim}.`);
			}
			return { file: anchor.anchor.file, startLine: anchor.startLine, endLine: anchor.endLine };
		});
		const formal = input.formal ?? previous.formal;
		const claim: ClaimRecord = {
			...previous,
			at: now(),
			by,
			revision: previous.revision + 1,
			statement: input.statement?.trim() || previous.statement,
			anchors: [...this.anchor(anchors), ...this.formalAnchor(formal)],
			dependsOn: input.dependsOn ? this.validateDependencies(state, input.claim, input.dependsOn) : previous.dependsOn,
			...(input.reasoning ? { reasoning: cleanReasoning(input.reasoning) } : {}),
			...(formal ? { formal: this.normalizeFormal(formal) } : {}),
		};
		this.append(claim);
		return this.report(claim.id);
	}

	assert(claimId: string, note: string, by: Actor): ClaimReport {
		const report = this.report(claimId);
		this.append({
			v: 1, kind: 'evidence', id: newId('e'), at: now(), by,
			claim: claimId, method: 'assertion', result: 'pass', summary: note, fingerprint: report.fingerprint,
		});
		return this.report(claimId);
	}

	async runCheck(claimId: string, checkName: string, by: Actor): Promise<CheckOutcome> {
		const config = this.config();
		const check = config.checks[checkName];
		if (!check) {
			const names = Object.keys(config.checks);
			throw new Error(names.length
				? `Unknown check "${checkName}". Configured checks: ${names.join(', ')}.`
				: `No checks are configured. A person must add them to ${LEDGER_DIR}/${CONFIG_FILE}.`);
		}
		// Bind the result to the code and the check as they were when the check started.
		const before = this.report(claimId);
		const inputs = this.checkInputs(check);
		let result: 'pass' | 'fail';
		let summary: string;
		let output: string;
		let command: string;
		if (check.kind === 'lean') {
			const formal = before.claim.formal;
			if (!formal) {
				throw new Error(`${claimId} has no Lean declaration. Link one with update claim (formal: file and declaration).`);
			}
			const lean = await runLeanCheck(this.root, formal, check, config.checkTimeoutSeconds);
			({ result, summary, output, command } = lean);
		} else {
			const run = await runCommand(check.command!, this.root, config.checkTimeoutSeconds);
			result = run.result;
			output = run.output;
			command = check.command!;
			summary = run.timedOut ? `timed out after ${config.checkTimeoutSeconds}s` : `exit ${run.exitCode} in ${run.durationMs}ms`;
		}
		const evidence: EvidenceRecord = {
			v: 1, kind: 'evidence', id: newId('e'), at: now(), by,
			claim: claimId, method: 'check', check: checkName, command, result, summary,
			fingerprint: before.fingerprint, inputs,
		};
		this.append(evidence);
		return { evidence, output, report: this.report(claimId) };
	}

	review(claimId: string, verdict: ReviewRecord['verdict'], note: string | undefined, by: Actor): ClaimReport {
		if (by.kind !== 'human') {
			throw new Error('Only a person can record a review.');
		}
		const report = this.report(claimId);
		this.append({
			v: 1, kind: 'review', id: newId('r'), at: now(), by,
			claim: claimId, verdict, fingerprint: report.fingerprint, ...(note ? { note } : {}),
		});
		return this.report(claimId);
	}

	retract(claimId: string, reason: string | undefined, by: Actor): void {
		this.report(claimId);
		const record: RetractRecord = { v: 1, kind: 'retract', id: newId('x'), at: now(), by, claim: claimId, ...(reason ? { reason } : {}) };
		this.append(record);
	}

	/** Claims the stop gate holds an agent to, in ledger order. */
	obligations(reports = this.evaluate(), scope = this.config().gate.scope): ClaimReport[] {
		const { accept } = this.config().gate;
		return [...reports.values()].filter(report =>
			(scope === 'all' || report.claim.by.kind === 'agent') && !accept.includes(report.status));
	}

	/** Claims anchored in any of `files`, and every claim whose status depends on them. */
	claimsTouching(files: readonly string[], reports = this.evaluate()): ClaimReport[] {
		const state = this.state();
		const wanted = new Set(files.map(file => this.relativePath(file)));
		const ids = new Set<string>();
		for (const report of reports.values()) {
			if (report.claim.anchors.some(anchor => wanted.has(anchor.file))) {
				ids.add(report.claim.id);
				dependentsOf(state, report.claim.id).forEach(id => ids.add(id));
			}
		}
		return [...ids].map(id => reports.get(id)).filter((report): report is ClaimReport => !!report);
	}

	checkInputs(check: CheckConfig | undefined): string {
		return hashCheckInputs(this.root, check, file => this.readFile(file));
	}

	private newClaim(state: LedgerState, input: DeclareClaimInput, by: Actor): ClaimRecord {
		const statement = input.statement.trim();
		if (!statement) {
			throw new Error('A claim needs a statement of what is true.');
		}
		if (input.parent && (!state.claims.has(input.parent) || state.retracted.has(input.parent))) {
			throw new Error(`Goal ${input.parent} is not an open claim.`);
		}
		// A goal depends on its steps, so a step cannot rely on its goal or anything above it.
		for (let goal = input.parent; goal; goal = state.claims.get(goal)?.parent) {
			if (input.dependsOn?.includes(goal)) {
				throw new Error(`Depending on ${goal} would create a cycle: it is a goal above this step.`);
			}
		}
		const id = newId('c');
		const formal = input.formal ? this.normalizeFormal(input.formal) : undefined;
		return {
			v: 1, kind: 'claim', id, at: now(), by,
			revision: 1,
			statement,
			anchors: [...this.anchor(input.anchors ?? []), ...this.formalAnchor(formal)],
			dependsOn: this.validateDependencies(state, undefined, input.dependsOn ?? []),
			...(input.parent ? { parent: input.parent } : {}),
			...(input.reasoning?.length ? { reasoning: cleanReasoning(input.reasoning) } : {}),
			...(formal ? { formal } : {}),
			...(input.session ? { session: input.session } : {}),
		};
	}

	private anchor(inputs: readonly AnchorInput[]): Anchor[] {
		return inputs.map(input => {
			const file = this.relativePath(input.file);
			const content = this.readFile(file);
			if (content === undefined) {
				throw new Error(`${file} does not exist.`);
			}
			return createAnchor(file, content, input.startLine, input.endLine);
		});
	}

	private normalizeFormal(formal: FormalLink): FormalLink {
		return { file: this.relativePath(formal.file), declaration: formal.declaration.trim() };
	}

	/** The anchor on a Lean declaration, found by name so it follows the declaration. */
	private formalAnchor(formal: FormalLink | undefined): Anchor[] {
		if (!formal) {
			return [];
		}
		const { file, declaration } = this.normalizeFormal(formal);
		const content = this.readFile(file);
		if (content === undefined) {
			throw new Error(`${file} does not exist.`);
		}
		const lines = locateDeclaration(content, declaration);
		if (!lines) {
			throw new Error(`No declaration named ${declaration} in ${file}.`);
		}
		return [{ ...createAnchor(file, content, lines.startLine, lines.endLine), role: 'formal' }];
	}

	private validateDependencies(state: LedgerState, claimId: string | undefined, dependsOn: readonly string[]): string[] {
		const dependents = claimId ? dependentsOf(state, claimId) : new Set<string>();
		const below = claimId ? descendantsOf(state, claimId) : new Set<string>();
		for (const id of dependsOn) {
			if (!state.claims.has(id) || state.retracted.has(id)) {
				throw new Error(`Dependency ${id} is not an open claim.`);
			}
			if (id === claimId || dependents.has(id) || below.has(id)) {
				throw new Error(`Depending on ${id} would create a cycle.`);
			}
		}
		return [...new Set(dependsOn)];
	}

	private append(record: LedgerRecord): void {
		fs.mkdirSync(path.dirname(this.ledgerPath), { recursive: true });
		fs.appendFileSync(this.ledgerPath, serializeRecord(record), 'utf8');
	}
}

/** The nearest directory at or above `start` with a `.prooftree` folder or, failing that, `.git`. */
export function findWorkspaceRoot(start: string): string {
	let gitRoot: string | undefined;
	for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
		if (fs.existsSync(path.join(dir, LEDGER_DIR))) {
			return dir;
		}
		if (!gitRoot && fs.existsSync(path.join(dir, '.git'))) {
			gitRoot = dir;
		}
		if (path.dirname(dir) === dir) {
			return gitRoot ?? path.resolve(start);
		}
	}
}

function cleanReasoning(levels: readonly string[]): string[] {
	return levels.map(level => level.trim()).filter(Boolean).slice(0, 3);
}

function readIfExists(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

function now(): string {
	return new Date().toISOString();
}
