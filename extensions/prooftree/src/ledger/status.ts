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
 * - `asserted`: only an unchecked assertion covers the current code.
 * - `unsupported`: nothing has ever been recorded for the claim.
 * - `stale`: evidence exists, but for an earlier version of the claim or its dependencies.
 * - `failed`: the latest check against the current code failed, or a reviewer rejected it.
 * - `drifted`: the anchored code changed or disappeared; the claim must be re-anchored.
 * - `blocked`: a dependency is not in an accepted status.
 */
export type ClaimStatus = 'checked' | 'reviewed' | 'asserted' | 'unsupported' | 'stale' | 'failed' | 'drifted' | 'blocked';

export interface ClaimReport {
	readonly claim: ClaimRecord;
	/**
	 * Hash of the statement, the current anchored text and the fingerprints of all
	 * dependencies. Evidence and reviews count only while their fingerprint matches.
	 */
	readonly fingerprint: string;
	readonly anchors: readonly AnchorState[];
	readonly machine: 'pass' | 'fail' | 'stale' | 'none';
	readonly review: 'approved' | 'rejected' | 'stale' | 'none';
	readonly asserted: boolean;
	readonly blockedBy: readonly string[];
	readonly status: ClaimStatus;
	readonly check?: EvidenceRecord;
	readonly reviewRecord?: ReviewRecord;
}

export type ReadFile = (file: string) => string | undefined;

function latest<T extends { at: string }>(records: readonly T[]): T | undefined {
	let result: T | undefined;
	for (const record of records) {
		if (!result || record.at >= result.at) {
			result = record;
		}
	}
	return result;
}

export function evaluateLedger(state: LedgerState, readFile: ReadFile, accept: readonly ClaimStatus[]): Map<string, ClaimReport> {
	const reports = new Map<string, ClaimReport>();
	const visiting = new Set<string>();
	const contents = new Map<string, string | undefined>();
	const read = (file: string) => {
		if (!contents.has(file)) {
			contents.set(file, readFile(file));
		}
		return contents.get(file);
	};

	const visit = (id: string): ClaimReport | undefined => {
		const known = reports.get(id);
		const claim = state.claims.get(id);
		if (known || !claim || state.retracted.has(id) || visiting.has(id)) {
			return known;
		}

		visiting.add(id);
		const dependencies = claim.dependsOn.map(dependency => ({ id: dependency, report: visit(dependency) }));
		visiting.delete(id);

		const anchors = claim.anchors.map(anchor => resolveAnchor(anchor, read(anchor.file)));
		const fingerprint = sha256(JSON.stringify({
			statement: claim.statement,
			anchors: anchors.map(anchor => [anchor.anchor.file, anchor.currentHash]),
			dependencies: dependencies.map(dependency => [dependency.id, dependency.report?.fingerprint ?? 'missing']),
		}));

		const evidence = state.evidence.get(id) ?? [];
		const checks = evidence.filter(record => record.method === 'check');
		const check = latest(checks.filter(record => record.fingerprint === fingerprint));
		const machine = check ? check.result : checks.length ? 'stale' : 'none';

		const reviews = state.reviews.get(id) ?? [];
		const reviewRecord = latest(reviews.filter(record => record.fingerprint === fingerprint));
		const review = reviewRecord ? reviewRecord.verdict : reviews.length ? 'stale' : 'none';

		const asserted = evidence.some(record => record.method === 'assertion' && record.result === 'pass' && record.fingerprint === fingerprint);
		const blockedBy = dependencies
			.filter(dependency => !dependency.report || !accept.includes(dependency.report.status))
			.map(dependency => dependency.id);

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
		} else if (machine === 'stale' || review === 'stale') {
			status = 'stale';
		} else if (asserted) {
			status = 'asserted';
		} else {
			status = evidence.length ? 'stale' : 'unsupported';
		}

		const report: ClaimReport = { claim, fingerprint, anchors, machine, review, asserted, blockedBy, status, check, reviewRecord };
		reports.set(id, report);
		return report;
	};

	for (const id of state.claims.keys()) {
		visit(id);
	}
	return reports;
}

/** Ids of claims that depend on `id`, directly or through other claims. */
export function dependentsOf(state: LedgerState, id: string): Set<string> {
	const result = new Set<string>();
	const queue = [id];
	while (queue.length) {
		const current = queue.pop()!;
		for (const claim of state.claims.values()) {
			if (!result.has(claim.id) && claim.dependsOn.includes(current)) {
				result.add(claim.id);
				queue.push(claim.id);
			}
		}
	}
	return result;
}
