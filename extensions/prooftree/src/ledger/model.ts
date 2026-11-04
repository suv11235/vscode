/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Records in `.prooftree/ledger.jsonl`. The ledger is append-only: a claim is revised by
 * appending a new revision, and evidence or reviews never change once written.
 */

export interface Actor {
	readonly kind: 'human' | 'agent';
	readonly name: string;
}

/**
 * A span of a workspace file that a claim is about. Lines are 1-based and inclusive; an
 * anchor without lines covers the whole file. `hash` is the SHA-256 of the covered text
 * when the claim revision was written.
 */
export interface Anchor {
	readonly file: string;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly hash: string;
}

interface RecordBase {
	readonly v: 1;
	readonly id: string;
	readonly at: string;
	readonly by: Actor;
}

export interface ClaimRecord extends RecordBase {
	readonly kind: 'claim';
	readonly revision: number;
	readonly statement: string;
	readonly anchors: readonly Anchor[];
	readonly dependsOn: readonly string[];
	readonly session?: string;
}

/**
 * A `check` is a configured command the tooling ran itself; an `assertion` is an agent or
 * person saying something holds without a machine check. Both are bound to the claim's
 * fingerprint at the time, so any later change to the anchored code or a dependency makes
 * them stale.
 */
export interface EvidenceRecord extends RecordBase {
	readonly kind: 'evidence';
	readonly claim: string;
	readonly method: 'check' | 'assertion';
	readonly check?: string;
	readonly command?: string;
	readonly result: 'pass' | 'fail';
	readonly summary?: string;
	readonly fingerprint: string;
}

/** A person's review of a claim at an exact fingerprint. Not a machine result. */
export interface ReviewRecord extends RecordBase {
	readonly kind: 'review';
	readonly claim: string;
	readonly verdict: 'approved' | 'rejected';
	readonly note?: string;
	readonly fingerprint: string;
}

export interface RetractRecord extends RecordBase {
	readonly kind: 'retract';
	readonly claim: string;
	readonly reason?: string;
}

export type LedgerRecord = ClaimRecord | EvidenceRecord | ReviewRecord | RetractRecord;
