/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { describeAnchor, nextStep, STATUS_LABEL } from '../ledger/format';
import { ClaimReport, ClaimStatus } from '../ledger/status';
import { ProoftreeConfig } from '../ledger/config';

interface StatusStyle {
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
	reviewed: { icon: 'verified-filled', color: 'charts.blue', order: 6 },
	checked: { icon: 'pass-filled', color: 'testing.iconPassed', order: 7 },
};

export function statusIcon(status: ClaimStatus): vscode.ThemeIcon {
	const style = STATUS_STYLE[status];
	return new vscode.ThemeIcon(style.icon, new vscode.ThemeColor(style.color));
}

export function claimTooltip(report: ClaimReport, config: ProoftreeConfig): vscode.MarkdownString {
	const markdown = new vscode.MarkdownString(undefined, true);
	markdown.appendMarkdown(`$(${STATUS_STYLE[report.status].icon}) **${STATUS_LABEL[report.status]}** · \`${report.claim.id}\` rev ${report.claim.revision}\n\n`);
	markdown.appendText(report.claim.statement);
	markdown.appendMarkdown(`\n\n---\n\n`);
	markdown.appendMarkdown(`**Machine:** ${report.machine}${report.check ? ` — \`${report.check.check}\` ${report.check.summary}` : ''}  \n`);
	markdown.appendMarkdown(`**Review:** ${report.review}${report.reviewRecord ? ` — ${report.reviewRecord.by.name}` : ''}  \n`);
	markdown.appendMarkdown(`**Stated by:** ${report.claim.by.name} (${report.claim.by.kind})`);
	if (report.asserted) {
		markdown.appendMarkdown(` · asserted without a check`);
	}
	markdown.appendMarkdown('\n\n');
	for (const anchor of report.anchors) {
		markdown.appendMarkdown(`- \`${describeAnchor(anchor)}\`\n`);
	}
	if (!config.gate.accept.includes(report.status)) {
		markdown.appendMarkdown(`\n**Next:** `);
		markdown.appendText(nextStep(report, config));
	}
	return markdown;
}

export function sortReports(reports: Iterable<ClaimReport>): ClaimReport[] {
	return [...reports].sort((a, b) => STATUS_STYLE[a.status].order - STATUS_STYLE[b.status].order || a.claim.at.localeCompare(b.claim.at));
}
