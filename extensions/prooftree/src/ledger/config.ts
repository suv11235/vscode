/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ClaimStatus } from './status';

/**
 * A named check. `command` checks run a shell command from the workspace root and pass on
 * exit code 0. `lean` checks compile the claim's Lean declaration and pass only when it
 * has no errors and does not depend on `sorry`. `inputs` are globs of files the check reads
 * (tests, fixtures, specs); changing one makes earlier results of the check stale.
 */
export interface CheckConfig {
	readonly kind: 'command' | 'lean';
	/** Lean checks reject dependencies outside this list when specified. */
	readonly permittedAxioms?: readonly string[];
	readonly command?: string;
	readonly inputs: readonly string[];
}

/**
 * `.prooftree/config.json`, written by people. Agents can only run the checks named here,
 * so the standard of evidence is set by the humans on the project.
 */
export interface ProoftreeConfig {
	readonly checks: Readonly<Record<string, CheckConfig>>;
	readonly checkTimeoutSeconds: number;
	readonly gate: {
		/** Keep agents working while their claims are not in an accepted status. */
		readonly onStop: boolean;
		/**
		 * Which claims the stop gate holds an agent to. `agent`: claims its session opened or
		 * changed (claims stated by agents, when hooks cannot tell sessions apart). `all`: every
		 * open claim.
		 */
		readonly scope: 'agent' | 'all';
		/** Statuses that discharge a claim, and that a dependency must have to not block. */
		readonly accept: readonly ClaimStatus[];
		/** What CI does about agent-written lines that no review or passing check covers. */
		readonly unverifiedAgentCode: 'allow' | 'warn' | 'block';
	};
}

export const DEFAULT_CONFIG: ProoftreeConfig = {
	checks: {},
	checkTimeoutSeconds: 300,
	gate: { onStop: true, scope: 'agent', accept: ['checked', 'reviewed', 'proved'], unverifiedAgentCode: 'warn' },
};

type RawCheck = string | { kind?: 'command' | 'lean'; command?: string; inputs?: string[]; permittedAxioms?: string[] };

function parseCheck(name: string, raw: RawCheck): CheckConfig {
	if (typeof raw === 'string') {
		return { kind: 'command', command: raw, inputs: [] };
	}
	const kind = raw.kind ?? 'command';
	if (kind === 'command' && !raw.command) {
		throw new Error(`Check "${name}" needs a command.`);
	}
	if (raw.permittedAxioms !== undefined && (!Array.isArray(raw.permittedAxioms) || raw.permittedAxioms.some(value => typeof value !== 'string'))) {
		throw new Error(`Check "${name}" permittedAxioms must be an array of names.`);
	}
	return { kind, command: raw.command, inputs: raw.inputs ?? [], ...(raw.permittedAxioms !== undefined ? { permittedAxioms: raw.permittedAxioms } : {}) };
}

export function parseConfig(text: string | undefined): ProoftreeConfig {
	if (!text) {
		return DEFAULT_CONFIG;
	}
	const raw = JSON.parse(text) as { checks?: Record<string, RawCheck>; checkTimeoutSeconds?: number; gate?: Partial<ProoftreeConfig['gate']> };
	return {
		checks: Object.fromEntries(Object.entries(raw.checks ?? {}).map(([name, check]) => [name, parseCheck(name, check)])),
		checkTimeoutSeconds: raw.checkTimeoutSeconds ?? DEFAULT_CONFIG.checkTimeoutSeconds,
		gate: { ...DEFAULT_CONFIG.gate, ...raw.gate },
	};
}

/** How a check is shown to people and agents. */
export function describeCheck(check: CheckConfig): string {
	const policy = check.permittedAxioms === undefined ? '' : ` · axioms: ${check.permittedAxioms.length ? check.permittedAxioms.join(', ') : 'none'}`;
	const what = check.kind === 'lean' ? `Lean${check.command ? ` (${check.command})` : ''}${policy}` : check.command!;
	return check.inputs.length ? `${what} · inputs ${check.inputs.join(', ')}` : what;
}
