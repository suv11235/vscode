/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ClaimStatus } from './status';

/**
 * `.prooftree/config.json`, written by people. Agents can only run the checks named here,
 * so the standard of evidence is set by the humans on the project.
 */
export interface ProoftreeConfig {
	/** Named shell commands, run from the workspace root. Exit code 0 is a pass. */
	readonly checks: Readonly<Record<string, string>>;
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
	gate: { onStop: true, scope: 'agent', accept: ['checked', 'reviewed'] },
};

export function parseConfig(text: string | undefined): ProoftreeConfig {
	if (!text) {
		return DEFAULT_CONFIG;
	}
	const raw = JSON.parse(text) as Partial<ProoftreeConfig>;
	return {
		checks: { ...DEFAULT_CONFIG.checks, ...raw.checks },
		checkTimeoutSeconds: raw.checkTimeoutSeconds ?? DEFAULT_CONFIG.checkTimeoutSeconds,
		gate: { ...DEFAULT_CONFIG.gate, ...raw.gate },
	};
}
