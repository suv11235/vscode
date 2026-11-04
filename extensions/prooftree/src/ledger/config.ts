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
		/** Which claims the stop gate covers. */
		readonly scope: 'agent' | 'all';
		/** Statuses that discharge a claim, and that a dependency must have to not block. */
		readonly accept: readonly ClaimStatus[];
	};
}

export const DEFAULT_CONFIG: ProoftreeConfig = {
	checks: {},
	checkTimeoutSeconds: 300,
	gate: { onStop: true, scope: 'agent', accept: ['checked', 'reviewed', 'proved'] },
};

type RawCheck = string | { kind?: 'command' | 'lean'; command?: string; inputs?: string[] };

function parseCheck(name: string, raw: RawCheck): CheckConfig {
	if (typeof raw === 'string') {
		return { kind: 'command', command: raw, inputs: [] };
	}
	const kind = raw.kind ?? 'command';
	if (kind === 'command' && !raw.command) {
		throw new Error(`Check "${name}" needs a command.`);
	}
	return { kind, command: raw.command, inputs: raw.inputs ?? [] };
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
	const what = check.kind === 'lean' ? `Lean${check.command ? ` (${check.command})` : ''}` : check.command!;
	return check.inputs.length ? `${what} · inputs ${check.inputs.join(', ')}` : what;
}
