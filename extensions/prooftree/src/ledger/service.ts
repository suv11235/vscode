/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { createAnchor } from './anchors';
import { CheckRun, runCommand } from './checks';
import { CONFIG_FILE, LEDGER_DIR, LEDGER_FILE, LedgerState, newId, readLedger, serializeRecord } from './ledger';
import { Actor, ClaimRecord, EvidenceRecord, LedgerRecord, RetractRecord, ReviewRecord } from './model';
import { ClaimReport, dependentsOf, evaluateLedger, ReadFile } from './status';
import { parseConfig, ProoftreeConfig } from './config';

export interface AnchorInput {
	readonly file: string;
	readonly startLine?: number;
	readonly endLine?: number;
}

export interface DeclareClaimInput {
	readonly statement: string;
	readonly anchors: readonly AnchorInput[];
	readonly dependsOn?: readonly string[];
	readonly session?: string;
}

export interface UpdateClaimInput {
	readonly claim: string;
	readonly statement?: string;
	/** Omitted anchors are re-taken over their current location. */
	readonly anchors?: readonly AnchorInput[];
	readonly dependsOn?: readonly string[];
}

export interface CheckOutcome {
	readonly evidence: EvidenceRecord;
	readonly run: CheckRun;
	readonly report: ClaimReport;
}

/**
 * All reads and writes of a workspace's ledger. The VS Code extension, the agent hook
 * command and the MCP server share this class, so they agree on every status.
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
		return evaluateLedger(state, file => this.readFile(file), this.config().gate.accept);
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
		const state = this.state();
		const statement = input.statement.trim();
		if (!statement) {
			throw new Error('A claim needs a statement of what is true.');
		}
		const dependsOn = this.validateDependencies(state, undefined, input.dependsOn ?? []);
		const claim: ClaimRecord = {
			v: 1, kind: 'claim', id: newId('c'), at: now(), by,
			revision: 1,
			statement,
			anchors: this.anchor(input.anchors),
			dependsOn,
			...(input.session ? { session: input.session } : {}),
		};
		this.append(claim);
		return this.report(claim.id);
	}

	updateClaim(input: UpdateClaimInput, by: Actor): ClaimReport {
		const state = this.state();
		const previous = state.claims.get(input.claim);
		if (!previous || state.retracted.has(input.claim)) {
			throw new Error(`No open claim ${input.claim}.`);
		}
		const current = this.report(input.claim, this.evaluate(state));
		const anchors = input.anchors ?? current.anchors.map(anchor => {
			if (anchor.kind === 'missing') {
				throw new Error(`${anchor.anchor.file} no longer exists; pass new anchors for ${input.claim}.`);
			}
			return { file: anchor.anchor.file, startLine: anchor.startLine, endLine: anchor.endLine };
		});
		const claim: ClaimRecord = {
			...previous,
			at: now(),
			by,
			revision: previous.revision + 1,
			statement: input.statement?.trim() || previous.statement,
			anchors: this.anchor(anchors),
			dependsOn: input.dependsOn ? this.validateDependencies(state, input.claim, input.dependsOn) : previous.dependsOn,
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
		const command = config.checks[checkName];
		if (!command) {
			const names = Object.keys(config.checks);
			throw new Error(names.length
				? `Unknown check "${checkName}". Configured checks: ${names.join(', ')}.`
				: `No checks are configured. A person must add them to ${LEDGER_DIR}/${CONFIG_FILE}.`);
		}
		// Bind the result to the code as it was when the check started.
		const before = this.report(claimId);
		const run = await runCommand(command, this.root, config.checkTimeoutSeconds);
		const evidence: EvidenceRecord = {
			v: 1, kind: 'evidence', id: newId('e'), at: now(), by,
			claim: claimId, method: 'check', check: checkName, command, result: run.result,
			summary: run.timedOut ? `timed out after ${config.checkTimeoutSeconds}s` : `exit ${run.exitCode} in ${run.durationMs}ms`,
			fingerprint: before.fingerprint,
		};
		this.append(evidence);
		return { evidence, run, report: this.report(claimId) };
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
	obligations(reports = this.evaluate()): ClaimReport[] {
		const { gate } = this.config();
		return [...reports.values()].filter(report =>
			(gate.scope === 'all' || report.claim.by.kind === 'agent') && !gate.accept.includes(report.status));
	}

	/** Claims anchored in any of `files`, and every claim that depends on them. */
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

	private anchor(inputs: readonly AnchorInput[]) {
		if (!inputs.length) {
			throw new Error('A claim needs at least one anchor: the file, and optionally the lines, it is about.');
		}
		return inputs.map(input => {
			const file = this.relativePath(input.file);
			const content = this.readFile(file);
			if (content === undefined) {
				throw new Error(`${file} does not exist.`);
			}
			return createAnchor(file, content, input.startLine, input.endLine);
		});
	}

	private validateDependencies(state: LedgerState, claimId: string | undefined, dependsOn: readonly string[]): string[] {
		const dependents = claimId ? dependentsOf(state, claimId) : new Set<string>();
		for (const id of dependsOn) {
			if (!state.claims.has(id) || state.retracted.has(id)) {
				throw new Error(`Dependency ${id} is not an open claim.`);
			}
			if (id === claimId || dependents.has(id)) {
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
