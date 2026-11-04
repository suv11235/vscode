/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Records in `.prooftree/ledger.jsonl`. The ledger is append-only: a claim is revised by
 * appending a new revision, and evidence or reviews never change once written.
 */

export interface Actor {
	readonly kind: 'human' | 'agent' | 'ci';
	readonly name: string;
}

/**
 * A span of a workspace file that a claim is about. Lines are 1-based and inclusive; an
 * anchor without lines covers the whole file. `hash` is the SHA-256 of the covered text
 * when the claim revision was written. The anchor on a claim's Lean declaration has the
 * `formal` role and is re-located from the declaration name on every revision.
 */
export interface Anchor {
	readonly file: string;
	readonly startLine?: number;
	readonly endLine?: number;
	readonly hash: string;
	readonly role?: 'formal';
}

/** A Lean declaration that states the claim formally, like the Lean half of a Prooftree step. */
export interface FormalLink {
	readonly file: string;
	readonly declaration: string;
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
	/** Premises: claims this one relies on. */
	readonly dependsOn: readonly string[];
	/** The goal this claim is a step of. A goal with steps is proved when all its steps are. */
	readonly parent?: string;
	/** Explanation from shortest to most detailed; shown up to the reader's reasoning depth. */
	readonly reasoning?: readonly string[];
	readonly formal?: FormalLink;
	readonly session?: string;
}

/**
 * A `check` is a configured command the tooling ran itself; an `assertion` is an agent or
 * person saying something holds without a machine check. Both are bound to the claim's
 * fingerprint at the time, so any later change to the anchored code or a dependency makes
 * them stale. Checks also record `inputs`, a hash of the check's command and input files,
 * so editing a test makes its earlier results stale too.
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
	readonly inputs?: string;
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
