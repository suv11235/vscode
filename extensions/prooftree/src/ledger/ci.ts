/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describeEdit, EditReport, editLines, writerOf } from './edits';
import { describeAnchor, nextStep, STATUS_LABEL } from './format';
import { Actor } from './model';
import { ProoftreeService } from './service';
import { ClaimReport, ClaimStatus } from './status';

export interface CiOptions {
	/** Re-run the last check of each claim whose evidence is stale, failed or blocked. */
	readonly rerun: boolean;
	/** Which claims must be discharged; CI covers all claims unless told otherwise. */
	readonly scope?: 'agent' | 'all';
}

export interface CiRun {
	readonly claim: string;
	readonly check: string;
	readonly result: 'pass' | 'fail';
	readonly summary?: string;
}

export interface CiResult {
	readonly ok: boolean;
	readonly reports: readonly ClaimReport[];
	readonly open: readonly ClaimReport[];
	readonly reran: readonly CiRun[];
	/** Agent-written lines no review or passing check covers; empty when the gate allows them. */
	readonly unverified: readonly EditReport[];
	readonly unverifiedAgentCode: 'allow' | 'warn' | 'block';
}

const CI: Actor = { kind: 'ci', name: process.env.GITHUB_ACTIONS ? 'github-actions' : 'ci' };
const RERUNNABLE: readonly ClaimStatus[] = ['stale', 'failed', 'blocked', 'asserted'];

export async function runCi(service: ProoftreeService, options: CiOptions): Promise<CiResult> {
	const scope = options.scope ?? 'all';
	const reran: CiRun[] = [];
	if (options.rerun) {
		const state = service.state();
		for (const report of service.evaluate(state).values()) {
			// Re-run the check this claim was last discharged with; code drift needs a person or agent to re-anchor.
			const lastCheck = [...(state.evidence.get(report.claim.id) ?? [])].reverse().find(record => record.method === 'check')?.check;
			if (lastCheck && RERUNNABLE.includes(report.status) && service.config().checks[lastCheck]) {
				const outcome = await service.runCheck(report.claim.id, lastCheck, CI);
				reran.push({ claim: report.claim.id, check: lastCheck, result: outcome.evidence.result, summary: outcome.evidence.summary });
			}
		}
	}
	const reports = [...service.evaluate().values()];
	const open = service.obligations(new Map(reports.map(report => [report.claim.id, report])), scope);
	const { unverifiedAgentCode } = service.config().gate;
	const unverified = unverifiedAgentCode === 'allow' ? [] : service.edits().filter(edit => edit.status === 'unverified');
	const ok = open.length === 0 && !(unverifiedAgentCode === 'block' && unverified.length);
	return { ok, reports, open, reran, unverified, unverifiedAgentCode };
}

function escapeData(text: string): string {
	return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProperty(text: string): string {
	return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** GitHub Actions workflow commands that annotate open claims and unverified agent code on their lines. */
export function githubAnnotations(result: CiResult, service: ProoftreeService): string[] {
	const config = service.config();
	const level = result.unverifiedAgentCode === 'block' ? 'error' : 'warning';
	const edits = result.unverified.map(edit =>
		`::${level} file=${escapeProperty(edit.file)},line=${edit.startLine},endLine=${edit.endLine},title=${escapeProperty('Prooftree: agent code without evidence')}::${escapeData(describeEdit(edit))}`);
	return [...edits, ...result.open.flatMap(report => {
		const title = escapeProperty(`Prooftree ${report.claim.id}: ${STATUS_LABEL[report.status]}`);
		const message = escapeData(`${report.claim.statement}\nNext: ${nextStep(report, config)}`);
		const located = report.anchors.filter(anchor => anchor.kind !== 'missing');
		if (!located.length) {
			return [`::error title=${title}::${message}`];
		}
		return located.map(anchor => {
			const lines = anchor.startLine !== undefined ? `,line=${anchor.startLine},endLine=${anchor.endLine}` : '';
			return `::error file=${escapeProperty(anchor.anchor.file)}${lines},title=${title}::${message}`;
		});
	})];
}

/** Markdown for the job summary. */
export function ciSummary(result: CiResult): string {
	const counts = new Map<ClaimStatus, number>();
	result.reports.forEach(report => counts.set(report.status, (counts.get(report.status) ?? 0) + 1));
	const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
	const problems = [
		...(result.open.length ? [plural(result.open.length, 'open claim')] : []),
		...(result.unverified.length ? [`${plural(result.unverified.length, 'agent edit')} without evidence`] : []),
	];
	const lines = [
		`## Prooftree: ${problems.join(', ') || 'all claims discharged'}`,
		'',
		[...counts].map(([status, count]) => `${count} ${STATUS_LABEL[status]}`).join(' · '),
		'',
	];
	if (result.reran.length) {
		lines.push(`Re-ran ${result.reran.length} check${result.reran.length === 1 ? '' : 's'}: ${result.reran.map(run => `\`${run.check}\` for ${run.claim} ${run.result === 'pass' ? 'passed' : 'failed'}`).join(', ')}.`, '');
	}
	if (result.open.length) {
		lines.push('| Claim | Status | Statement | Where |', '| --- | --- | --- | --- |');
		for (const report of result.open) {
			const where = report.anchors.map(describeAnchor).join('<br>') || '—';
			lines.push(`| \`${report.claim.id}\` | ${STATUS_LABEL[report.status]} | ${report.claim.statement.replace(/\|/g, '\\|')} | ${where} |`);
		}
	}
	if (result.unverified.length) {
		const effect = result.unverifiedAgentCode === 'block' ? 'They fail this build.' : 'They do not fail the build.';
		lines.push('', `### Agent code without evidence`, '', `No person reviewed these agent-written lines, and no claim about them has a passing check or a person's approval. ${effect}`, '');
		lines.push('| Where | Written by | How |', '| --- | --- | --- |');
		for (const edit of result.unverified) {
			const date = edit.source.at.slice(0, 10);
			const how = edit.source.decision === 'written' ? `written${edit.source.tool ? ` with ${edit.source.tool}` : ''}, ${date}` : `kept by ${edit.source.by.name}, ${date}`;
			lines.push(`| ${edit.file}:${editLines(edit)} | ${writerOf(edit.source)} | ${how} |`);
		}
	}
	return lines.join('\n') + '\n';
}

export const WORKFLOW_FILE = '.github/workflows/prooftree.yml';

/** A GitHub Actions workflow that fails pull requests with open claims. */
export function workflowTemplate(usesLean: boolean): string {
	const lean = [
		'      - name: Install Lean',
		'        run: |',
		'          curl -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none',
		'          echo "$HOME/.elan/bin" >> "$GITHUB_PATH"',
	];
	return [
		'name: Prooftree',
		'',
		'on:',
		'  push:',
		'  pull_request:',
		'',
		'jobs:',
		'  claims:',
		'    runs-on: ubuntu-latest',
		'    steps:',
		'      - uses: actions/checkout@v4',
		'      - uses: actions/setup-node@v4',
		'        with:',
		'          node-version: 22',
		'      # Install whatever your configured checks need, for example:',
		'      # - run: npm ci',
		...(usesLean ? lean : []),
		'      - name: Check claims',
		'        run: node .prooftree/bin/prooftree.cjs ci --rerun',
		'',
	].join('\n');
}
