/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AnchorState, resolveAnchor, sha256 } from './anchors';
import { LedgerState } from './ledger';
import { ClaimRecord, EvidenceRecord, ReviewRecord } from './model';

/**
 * - `checked`: a configured check passed against the current code.
 * - `reviewed`: a person approved the current code (no passing check).
 * - `proved`: a goal whose steps are all discharged, with no evidence of its own needed.
 * - `asserted`: only an unchecked assertion covers the current code.
 * - `unsupported`: nothing has ever been recorded for the claim.
 * - `stale`: evidence exists, but for an earlier version of the claim, its premises, its
 *   steps, or the check itself.
 * - `failed`: the latest check against the current code failed, or a reviewer rejected it.
 * - `drifted`: the anchored code changed or disappeared; the claim must be re-anchored.
 * - `blocked`: a premise or a step is not in an accepted status.
 */
export type ClaimStatus = 'checked' | 'reviewed' | 'proved' | 'asserted' | 'unsupported' | 'stale' | 'failed' | 'drifted' | 'blocked';

export interface ClaimReport {
	readonly claim: ClaimRecord;
	/**
	 * Hash of the statement, the current anchored text and the fingerprints of all
	 * premises and steps. Evidence and reviews count only while their fingerprint matches.
	 */
	readonly fingerprint: string;
	readonly anchors: readonly AnchorState[];
	/** Ids of the claims that are steps of this one, in the order they were stated. */
	readonly steps: readonly string[];
	readonly machine: 'pass' | 'fail' | 'stale' | 'none';
	readonly review: 'approved' | 'rejected' | 'stale' | 'none';
	readonly asserted: boolean;
	readonly blockedBy: readonly string[];
	readonly status: ClaimStatus;
	readonly check?: EvidenceRecord;
	/** The latest check run for the claim, whether or not it still counts. */
	readonly lastCheck?: EvidenceRecord;
	readonly reviewRecord?: ReviewRecord;
}

export type ReadFile = (file: string) => string | undefined;

export interface EvaluateOptions {
	readonly accept: readonly ClaimStatus[];
	/** Current hash of a check's command and inputs; evidence from a different one is stale. */
	readonly checkInputs?: (check: string) => string;
}

function latest<T extends { at: string }>(records: readonly T[]): T | undefined {
	let result: T | undefined;
	for (const record of records) {
		if (!result || record.at >= result.at) {
			result = record;
		}
	}
	return result;
}

/** Open steps of each goal, in the order they were first stated. */
export function stepsByGoal(state: LedgerState): Map<string, string[]> {
	const steps = new Map<string, string[]>();
	for (const claim of state.claims.values()) {
		if (claim.parent && !state.retracted.has(claim.id)) {
			const list = steps.get(claim.parent) ?? [];
			list.push(claim.id);
			steps.set(claim.parent, list);
		}
	}
	return steps;
}

export function evaluateLedger(state: LedgerState, readFile: ReadFile, options: EvaluateOptions): Map<string, ClaimReport> {
	const { accept, checkInputs } = options;
	const reports = new Map<string, ClaimReport>();
	const visiting = new Set<string>();
	const contents = new Map<string, string | undefined>();
	const goals = stepsByGoal(state);
	const read = (file: string) => {
		if (!contents.has(file)) {
			contents.set(file, readFile(file));
		}
		return contents.get(file);
	};
	const inputsMatch = (record: EvidenceRecord) => !record.check || record.inputs === undefined || !checkInputs || record.inputs === checkInputs(record.check);

	const visit = (id: string): ClaimReport | undefined => {
		const known = reports.get(id);
		const claim = state.claims.get(id);
		if (known || !claim || state.retracted.has(id) || visiting.has(id)) {
			return known;
		}

		visiting.add(id);
		const premises = claim.dependsOn.map(premise => ({ id: premise, report: visit(premise) }));
		const steps = (goals.get(id) ?? []).map(step => ({ id: step, report: visit(step) }));
		visiting.delete(id);

		const anchors = claim.anchors.map(anchor => resolveAnchor(anchor, read(anchor.file)));
		const fingerprint = sha256(JSON.stringify({
			statement: claim.statement,
			anchors: anchors.map(anchor => [anchor.anchor.file, anchor.currentHash]),
			dependencies: premises.map(premise => [premise.id, premise.report?.fingerprint ?? 'missing']),
			...(steps.length ? { steps: steps.map(step => [step.id, step.report?.fingerprint ?? 'missing']) } : {}),
		}));

		const evidence = state.evidence.get(id) ?? [];
		const current = (record: EvidenceRecord) => record.fingerprint === fingerprint && inputsMatch(record);
		const checks = evidence.filter(record => record.method === 'check');
		const check = latest(checks.filter(current));
		const machine = check ? check.result : checks.length ? 'stale' : 'none';

		const reviews = state.reviews.get(id) ?? [];
		const reviewRecord = latest(reviews.filter(record => record.fingerprint === fingerprint));
		const review = reviewRecord ? reviewRecord.verdict : reviews.length ? 'stale' : 'none';

		const asserted = evidence.some(record => record.method === 'assertion' && record.result === 'pass' && current(record));
		const blockedBy = [...premises, ...steps]
			.filter(entry => !entry.report || !accept.includes(entry.report.status))
			.map(entry => entry.id);

		let status: ClaimStatus;
		if (anchors.some(anchor => anchor.kind === 'changed' || anchor.kind === 'missing')) {
			status = 'drifted';
		} else if (machine === 'fail' || review === 'rejected') {
			status = 'failed';
		} else if (blockedBy.length) {
			status = 'blocked';
		} else if (machine === 'pass') {
			status = 'checked';
		} else if (review === 'approved') {
			status = 'reviewed';
		} else if (steps.length) {
			status = 'proved';
		} else if (machine === 'stale' || review === 'stale') {
			status = 'stale';
		} else if (asserted) {
			status = 'asserted';
		} else {
			status = evidence.length ? 'stale' : 'unsupported';
		}

		const report: ClaimReport = {
			claim, fingerprint, anchors, steps: steps.map(step => step.id),
			machine, review, asserted, blockedBy, status, check, reviewRecord, lastCheck: latest(checks),
		};
		reports.set(id, report);
		return report;
	};

	for (const id of state.claims.keys()) {
		visit(id);
	}
	return reports;
}

/**
 * Ids of claims whose status can change when `id` changes: claims that rely on it as a
 * premise and goals it is a step of, directly or through other claims.
 */
export function dependentsOf(state: LedgerState, id: string): Set<string> {
	const result = new Set<string>();
	const queue = [id];
	while (queue.length) {
		const current = queue.pop()!;
		const parent = state.claims.get(current)?.parent;
		if (parent && !result.has(parent)) {
			result.add(parent);
			queue.push(parent);
		}
		for (const claim of state.claims.values()) {
			if (!result.has(claim.id) && claim.dependsOn.includes(current)) {
				result.add(claim.id);
				queue.push(claim.id);
			}
		}
	}
	return result;
}

/** A goal and all claims below it. */
export function descendantsOf(state: LedgerState, id: string): Set<string> {
	const goals = stepsByGoal(state);
	const result = new Set<string>();
	const queue = [id];
	while (queue.length) {
		for (const step of goals.get(queue.pop()!) ?? []) {
			if (!result.has(step)) {
				result.add(step);
				queue.push(step);
			}
		}
	}
	return result;
}
