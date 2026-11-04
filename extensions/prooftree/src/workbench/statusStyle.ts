/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ClaimStatus } from '../ledger/status';

export interface StatusStyle {
	readonly icon: string;
	readonly color: string;
	/** Lower sorts first: what needs attention comes before what is done. */
	readonly order: number;
}

export const STATUS_STYLE: Readonly<Record<ClaimStatus, StatusStyle>> = {
	failed: { icon: 'error', color: 'testing.iconFailed', order: 0 },
	drifted: { icon: 'diff-modified', color: 'charts.orange', order: 1 },
	blocked: { icon: 'lock', color: 'charts.orange', order: 2 },
	stale: { icon: 'history', color: 'charts.yellow', order: 3 },
	asserted: { icon: 'comment', color: 'charts.yellow', order: 4 },
	unsupported: { icon: 'circle-large-outline', color: 'disabledForeground', order: 5 },
	proved: { icon: 'type-hierarchy-sub', color: 'testing.iconPassed', order: 6 },
	reviewed: { icon: 'verified-filled', color: 'charts.blue', order: 7 },
	checked: { icon: 'pass-filled', color: 'testing.iconPassed', order: 8 },
};
