/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import { ClaimRecord, EvidenceRecord, LedgerRecord, RetractRecord, ReviewRecord } from './model';

export const LEDGER_DIR = '.prooftree';
export const LEDGER_FILE = 'ledger.jsonl';
export const CONFIG_FILE = 'config.json';

export interface LedgerState {
	/** Latest revision of each claim. */
	readonly claims: Map<string, ClaimRecord>;
	readonly evidence: Map<string, EvidenceRecord[]>;
	readonly reviews: Map<string, ReviewRecord[]>;
	readonly retracted: Map<string, RetractRecord>;
	/** Lines that could not be read, with their 1-based line numbers. */
	readonly errors: readonly string[];
}

export function newId(prefix: 'c' | 'e' | 'r' | 'x'): string {
	return `${prefix}_${randomBytes(4).toString('hex')}`;
}

function isRecord(value: unknown): value is LedgerRecord {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const record = value as Partial<LedgerRecord>;
	return record.v === 1 && typeof record.id === 'string' && typeof record.kind === 'string';
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
	const list = map.get(key);
	if (list) {
		list.push(value);
	} else {
		map.set(key, [value]);
	}
}

export function readLedger(text: string): LedgerState {
	const state: LedgerState = { claims: new Map(), evidence: new Map(), reviews: new Map(), retracted: new Map(), errors: [] };
	const errors = state.errors as string[];

	text.split('\n').forEach((line, index) => {
		if (!line.trim()) {
			return;
		}
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			errors.push(`line ${index + 1}: not valid JSON`);
			return;
		}
		if (!isRecord(record)) {
			errors.push(`line ${index + 1}: not a ledger record`);
			return;
		}
		switch (record.kind) {
			case 'claim': {
				const previous = state.claims.get(record.id);
				if (!previous || record.revision > previous.revision) {
					state.claims.set(record.id, record);
				}
				break;
			}
			case 'evidence':
				push(state.evidence, record.claim, record);
				break;
			case 'review':
				push(state.reviews, record.claim, record);
				break;
			case 'retract':
				state.retracted.set(record.claim, record);
				break;
			default:
				errors.push(`line ${index + 1}: unknown kind`);
		}
	});
	return state;
}

export function serializeRecord(record: LedgerRecord): string {
	return JSON.stringify(record) + '\n';
}
