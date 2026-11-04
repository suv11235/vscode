/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AnchorState } from './anchors';
import { ProoftreeConfig } from './config';
import { ClaimReport, ClaimStatus } from './status';

export const STATUS_LABEL: Readonly<Record<ClaimStatus, string>> = {
	checked: 'checked',
	reviewed: 'reviewed',
	asserted: 'asserted only',
	unsupported: 'no evidence',
	stale: 'stale',
	failed: 'failed',
	drifted: 'code changed',
	blocked: 'blocked',
};

export function describeAnchor(anchor: AnchorState): string {
	const lines = anchor.startLine !== undefined ? `:${anchor.startLine}-${anchor.endLine}` : '';
	return `${anchor.anchor.file}${lines} (${anchor.kind})`;
}

/** What has to happen for the claim to be discharged. */
export function nextStep(report: ClaimReport, config: ProoftreeConfig): string {
	const checks = Object.keys(config.checks);
	const runCheck = checks.length
		? `run a check (${checks.join(', ')})`
		: 'ask a person to add a check to .prooftree/config.json or review it';
	switch (report.status) {
		case 'drifted':
			return 'the anchored code changed: confirm the claim still holds, re-anchor it with update claim, then ' + runCheck;
		case 'failed':
			return report.machine === 'fail'
				? `fix the code or the claim; check "${report.check?.check}" failed (${report.check?.summary})`
				: `a reviewer rejected it${report.reviewRecord?.note ? `: ${report.reviewRecord.note}` : ''}`;
		case 'blocked':
			return `discharge its dependencies first: ${report.blockedBy.join(', ')}`;
		case 'stale':
		case 'asserted':
		case 'unsupported':
			return runCheck;
		default:
			return 'nothing';
	}
}

export function describeReport(report: ClaimReport, config: ProoftreeConfig): string {
	const lines = [`${report.claim.id} [${STATUS_LABEL[report.status]}] ${report.claim.statement}`];
	for (const anchor of report.anchors) {
		lines.push(`  at ${describeAnchor(anchor)}`);
	}
	if (report.claim.dependsOn.length) {
		lines.push(`  depends on ${report.claim.dependsOn.join(', ')}`);
	}
	lines.push(`  machine: ${report.machine}${report.check ? ` (${report.check.check}, ${report.check.summary})` : ''}`
		+ ` · review: ${report.review}${report.reviewRecord ? ` by ${report.reviewRecord.by.name}` : ''}`
		+ (report.asserted ? ' · asserted' : ''));
	if (!config.gate.accept.includes(report.status)) {
		lines.push(`  next: ${nextStep(report, config)}`);
	}
	return lines.join('\n');
}

export function describeObligations(reports: readonly ClaimReport[], config: ProoftreeConfig): string {
	if (!reports.length) {
		return 'No open obligations.';
	}
	return `${reports.length} open obligation${reports.length === 1 ? '' : 's'}:\n\n` + reports.map(report => describeReport(report, config)).join('\n\n');
}

/** Short contract shown to agents at session start. */
export function agentContract(config: ProoftreeConfig): string {
	const checks = Object.keys(config.checks);
	return [
		'This workspace tracks claims with Prooftree (.prooftree/ledger.jsonl).',
		'When you change behavior, declare a claim stating what is now true, anchored to the lines that make it true, with dependencies on the claims it relies on.',
		`Discharge each claim by running a configured check${checks.length ? ` (${checks.join(', ')})` : ' (none configured yet)'}; assertions do not count.`,
		'Editing anchored code makes its evidence stale, and staleness flows to dependent claims.',
		config.gate.onStop ? `You cannot finish while your claims are not ${config.gate.accept.join(' or ')}.` : '',
		'Use the prooftree tools (declare claim, update claim, run check, list obligations). Never edit the ledger file directly.',
	].filter(Boolean).join(' ');
}
