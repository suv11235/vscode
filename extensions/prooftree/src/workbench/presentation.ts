/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ProoftreeConfig } from '../ledger/config';
import { EditReport } from '../ledger/edits';
import { describeAnchor, nextStep, ReasoningDepth, STATUS_LABEL } from '../ledger/format';
import { ClaimReport, ClaimStatus } from '../ledger/status';
import { STATUS_STYLE } from './statusStyle';

export { STATUS_STYLE };

export function statusIcon(status: ClaimStatus): vscode.ThemeIcon {
	const style = STATUS_STYLE[status];
	return new vscode.ThemeIcon(style.icon, new vscode.ThemeColor(style.color));
}

const DEPTH_NAME: Readonly<Record<ReasoningDepth, string>> = { 1: 'summary', 2: 'explanation', 3: 'full detail' };

/**
 * A claim at a reasoning depth. Deeper levels add explanation and provenance; they never
 * change the status, so more detail is not more certainty.
 */
export function claimMarkdown(report: ClaimReport, config: ProoftreeConfig, depth: ReasoningDepth, reports: ReadonlyMap<string, ClaimReport>, unverifiedLines = 0): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString(undefined, true);
	const reasoning = report.claim.reasoning ?? [];
	markdown.appendMarkdown(`$(${STATUS_STYLE[report.status].icon}) **${STATUS_LABEL[report.status]}** · \`${report.claim.id}\` rev ${report.claim.revision}\n\n`);
	markdown.appendText(report.claim.statement);
	if (unverifiedLines) {
		markdown.appendMarkdown(`\n\n$(eye-closed) ${unverifiedLines} agent-written line${unverifiedLines === 1 ? '' : 's'} in this code ${unverifiedLines === 1 ? 'has' : 'have'} no review and no passing check.`);
	}
	reasoning.slice(0, depth).forEach(reason => {
		markdown.appendMarkdown('\n\n> ');
		markdown.appendText(reason);
	});

	if (depth >= 2) {
		markdown.appendMarkdown(`\n\n---\n\n`);
		markdown.appendMarkdown(`**Machine:** ${report.machine}${report.check ? ` — \`${report.check.check}\` ${report.check.summary}` : ''}  \n`);
		markdown.appendMarkdown(`**Review:** ${report.review}${report.reviewRecord ? ` — ${report.reviewRecord.by.name}` : ''}  \n`);
		markdown.appendMarkdown(`**Stated by:** ${report.claim.by.name} (${report.claim.by.kind})${report.asserted ? ' · asserted without a check' : ''}`);
		if (report.claim.formal) {
			markdown.appendMarkdown(`  \n**Lean:** \`${report.claim.formal.declaration}\` in \`${report.claim.formal.file}\``);
		}
		markdown.appendMarkdown('\n\n');
		for (const anchor of report.anchors) {
			markdown.appendMarkdown(`- \`${describeAnchor(anchor)}\`${anchor.anchor.role === 'formal' ? ' (Lean)' : ''}\n`);
		}
	}

	if (depth >= 3) {
		const related = (label: string, ids: readonly string[]) => {
			if (!ids.length) {
				return;
			}
			markdown.appendMarkdown(`\n**${label}:**\n\n`);
			ids.forEach((id, index) => {
				const other = reports.get(id);
				markdown.appendMarkdown(`${label === 'Steps' ? `${index + 1}.` : '-'} \`${id}\` ${other ? `${STATUS_LABEL[other.status]} — ` : ''}`);
				markdown.appendText(other?.claim.statement ?? 'retracted');
				markdown.appendMarkdown('\n');
			});
		};
		related('Steps', report.steps);
		related('Premises', report.claim.dependsOn);
		if (report.claim.parent) {
			markdown.appendMarkdown(`\nStep of \`${report.claim.parent}\`.`);
		}
		markdown.appendMarkdown(`\n\nFingerprint \`${report.fingerprint.slice(0, 12)}\``);
	}

	if (!config.gate.accept.includes(report.status)) {
		markdown.appendMarkdown(`\n\n**Next:** `);
		markdown.appendText(nextStep(report, config));
	}
	markdown.appendMarkdown(`\n\n*Reasoning depth ${depth} of 3: ${DEPTH_NAME[depth]}.${depth < 3 && reasoning.length > depth ? ' More is available.' : ''}*`);
	return markdown;
}

export function sortReports(reports: Iterable<ClaimReport>): ClaimReport[] {
	return [...reports].sort((a, b) => STATUS_STYLE[a.status].order - STATUS_STYLE[b.status].order || a.claim.at.localeCompare(b.claim.at));
}

/** Hover text for agent-written lines that only the agent vouches for. */
export function editMarkdown(edit: EditReport): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString(undefined, true);
	markdown.isTrusted = { enabledCommands: ['prooftree.reviewEdit', 'prooftree.declareClaim'] };
	const { source } = edit;
	const lines = edit.startLine === edit.endLine ? `line ${edit.startLine}` : `lines ${edit.startLine}-${edit.endLine}`;
	const writer = [source.model, source.agent ?? (source.by.kind === 'agent' ? source.by.name : undefined)].filter(Boolean).join(' · ') || 'an agent';
	const args = encodeURIComponent(JSON.stringify([{ file: edit.file, startLine: edit.startLine, endLine: edit.endLine }]));
	markdown.appendMarkdown(`$(eye-closed) **Agent code without evidence** · ${lines}\n\n`);
	markdown.appendMarkdown(`Written by `);
	markdown.appendText(writer);
	if (source.decision === 'written') {
		markdown.appendText(`${source.tool ? ` with ${source.tool}` : ''} on ${new Date(source.at).toLocaleString()}`);
		markdown.appendMarkdown(`\n\nNo person has reviewed these lines and no passing check covers them.`);
	} else {
		markdown.appendMarkdown(` · kept by `);
		markdown.appendText(`${source.by.name} on ${new Date(source.at).toLocaleString()}`);
		markdown.appendMarkdown(`\n\nKeeping an edit does not record that anyone read it, and no passing check covers these lines.`);
	}
	markdown.appendMarkdown(` [Mark reviewed](command:prooftree.reviewEdit?${args} "Record that you reviewed these lines") · [Declare a claim](command:prooftree.declareClaim?${args} "State what these lines make true, then run a check")`);
	return markdown;
}
