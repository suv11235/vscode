/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { AnchorState } from './anchors';
import { describeCheck, ProoftreeConfig } from './config';
import { ClaimReport, ClaimStatus } from './status';

export const STATUS_LABEL: Readonly<Record<ClaimStatus, string>> = {
	checked: 'checked',
	reviewed: 'reviewed',
	proved: 'proved by steps',
	asserted: 'asserted only',
	unsupported: 'no evidence',
	stale: 'stale',
	failed: 'failed',
	drifted: 'code changed',
	blocked: 'blocked',
};

/** Reasoning depth: 1 shows the summary, 2 adds the explanation, 3 shows everything. */
export type ReasoningDepth = 1 | 2 | 3;

export function describeAnchor(anchor: AnchorState): string {
	const lines = anchor.startLine !== undefined ? `:${anchor.startLine}-${anchor.endLine}` : '';
	return `${anchor.anchor.file}${lines} (${anchor.kind})`;
}

/** What has to happen for the claim to be discharged. */
export function nextStep(report: ClaimReport, config: ProoftreeConfig): string {
	// A Lean check only applies to a claim linked to a Lean declaration.
	const checks = Object.entries(config.checks).filter(([, check]) => check.kind !== 'lean' || report.claim.formal).map(([name]) => name);
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
		case 'blocked': {
			const steps = report.blockedBy.filter(id => report.steps.includes(id));
			const premises = report.blockedBy.filter(id => !report.steps.includes(id));
			return [
				steps.length ? `discharge its steps ${steps.join(', ')}` : '',
				premises.length ? `discharge its premises ${premises.join(', ')}` : '',
			].filter(Boolean).join(' and ');
		}
		case 'stale':
		case 'asserted':
		case 'unsupported':
			return runCheck;
		default:
			return 'nothing';
	}
}

/** Reasoning lines visible at `depth`: the summary, then one more level per step deeper. */
export function visibleReasoning(report: ClaimReport, depth: ReasoningDepth): readonly string[] {
	return (report.claim.reasoning ?? []).slice(0, depth);
}

export function describeReport(report: ClaimReport, config: ProoftreeConfig, depth: ReasoningDepth = 1): string {
	const lines = [`${report.claim.id} [${STATUS_LABEL[report.status]}] ${report.claim.statement}`];
	for (const reason of visibleReasoning(report, depth)) {
		lines.push(`  why: ${reason}`);
	}
	if (report.claim.parent) {
		lines.push(`  step of ${report.claim.parent}`);
	}
	if (report.steps.length) {
		lines.push(`  steps ${report.steps.join(', ')}`);
	}
	for (const anchor of report.anchors) {
		lines.push(`  ${anchor.anchor.role === 'formal' ? 'formal' : 'at'} ${describeAnchor(anchor)}`);
	}
	if (report.claim.formal) {
		lines.push(`  lean ${report.claim.formal.declaration} in ${report.claim.formal.file}`);
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

/** Goals with their numbered steps, like a Prooftree statement outline. */
export function describeOutline(reports: ReadonlyMap<string, ClaimReport>, depth: ReasoningDepth = 1): string {
	const lines: string[] = [];
	const visit = (report: ClaimReport, number: string, indent: string) => {
		lines.push(`${indent}${number ? number + ' ' : ''}${report.claim.statement}  [${STATUS_LABEL[report.status]}, ${report.claim.id}]`);
		for (const reason of visibleReasoning(report, depth)) {
			lines.push(`${indent}    ${reason}`);
		}
		report.steps.forEach((step, index) => {
			const child = reports.get(step);
			if (child) {
				visit(child, `${number}${index + 1}.`, indent + '  ');
			}
		});
	};
	for (const report of reports.values()) {
		if (!report.claim.parent || !reports.has(report.claim.parent)) {
			visit(report, '', '');
		}
	}
	return lines.length ? lines.join('\n') : 'No claims yet.';
}

/** Short contract shown to agents at session start. */
export function agentContract(config: ProoftreeConfig): string {
	const checks = Object.entries(config.checks).map(([name, check]) => `${name} (${describeCheck(check)})`);
	return [
		'This workspace tracks claims with Prooftree (.prooftree/ledger.jsonl).',
		'When you change behavior, declare a claim stating what is now true, anchored to the lines that make it true, with dependencies on the claims it relies on.',
		'For larger changes, state the goal and break it into steps with prooftree_decompose; a goal is proved when all its steps are discharged.',
		'Give reasoning from a one-line summary to a detailed explanation so reviewers can read at the depth they need.',
		`Discharge each claim by running a configured check${checks.length ? `: ${checks.join('; ')}` : ' (none configured yet)'}. Assertions do not count.`,
		'Where a Lean statement of the property exists, link it (formal: file and declaration) and run the lean check; a proof that uses sorry fails.',
		'Editing anchored code, a premise, a step or a check\'s inputs makes evidence stale.',
		config.gate.onStop ? `You cannot finish while your claims are not ${config.gate.accept.join(', ')}.` : '',
		'Use the prooftree tools; never edit the ledger file directly.',
	].filter(Boolean).join(' ');
}
