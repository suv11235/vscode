/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { AnchorState } from '../ledger/anchors';
import { EditReport, editLines, writerOf } from '../ledger/edits';
import { describeAnchor, nextStep, STATUS_LABEL } from '../ledger/format';
import { ClaimReport } from '../ledger/status';
import { anchorRange, editRange, ProoftreeModel } from './model';
import { claimMarkdown, editMarkdown, sortReports, statusIcon } from './presentation';

export type ClaimsNode =
	| { readonly kind: 'claim'; readonly report: ClaimReport; readonly number?: string }
	| { readonly kind: 'anchor'; readonly report: ClaimReport; readonly anchor: AnchorState }
	| { readonly kind: 'detail'; readonly label: string; readonly description?: string; readonly icon: string }
	| { readonly kind: 'edits' }
	| { readonly kind: 'edit'; readonly edit: EditReport };

/**
 * Goals with their numbered steps, like a Prooftree statement outline. Top-level claims are
 * sorted so what needs attention comes first; steps keep the order they were stated in.
 */
export class ClaimsView implements vscode.TreeDataProvider<ClaimsNode>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _listener: vscode.Disposable;

	constructor(private readonly model: ProoftreeModel) {
		this._listener = model.onDidChange(() => this._onDidChangeTreeData.fire());
	}

	getChildren(node?: ClaimsNode): ClaimsNode[] {
		const reports = this.model.reports;
		if (!node) {
			if (this.model.error) {
				return [{ kind: 'detail', label: 'Cannot read the ledger', description: this.model.error, icon: 'warning' }];
			}
			const roots = [...reports.values()].filter(report => !report.claim.parent || !reports.has(report.claim.parent));
			const edits: ClaimsNode[] = this.model.unverifiedEdits.length ? [{ kind: 'edits' }] : [];
			return [...edits, ...sortReports(roots).map(report => ({ kind: 'claim' as const, report }))];
		}
		if (node.kind === 'edits') {
			return this.model.unverifiedEdits.map(edit => ({ kind: 'edit', edit }));
		}
		if (node.kind !== 'claim') {
			return [];
		}
		const { report } = node;
		const config = this.model.config;
		const children: ClaimsNode[] = [];
		report.steps.forEach((step, index) => {
			const stepReport = reports.get(step);
			if (stepReport) {
				children.push({ kind: 'claim', report: stepReport, number: `${node.number ?? ''}${index + 1}.` });
			}
		});
		for (const reason of (report.claim.reasoning ?? []).slice(0, this.model.depth)) {
			children.push({ kind: 'detail', label: reason, icon: 'lightbulb' });
		}
		children.push(...report.anchors.map(anchor => ({ kind: 'anchor' as const, report, anchor })));
		for (const premise of report.claim.dependsOn) {
			const premiseReport = reports.get(premise);
			children.push(premiseReport
				? { kind: 'claim', report: premiseReport }
				: { kind: 'detail', label: premise, description: 'retracted or missing premise', icon: 'warning' });
		}
		children.push({ kind: 'detail', label: 'Machine', description: report.check ? `${report.machine} · ${report.check.check} · ${report.check.summary}` : report.machine, icon: 'beaker' });
		children.push({ kind: 'detail', label: 'Review', description: report.reviewRecord ? `${report.review} · ${report.reviewRecord.by.name}` : report.review, icon: 'person' });
		if (!config.gate.accept.includes(report.status)) {
			children.push({ kind: 'detail', label: 'Next', description: nextStep(report, config), icon: 'arrow-right' });
		}
		return children;
	}

	getTreeItem(node: ClaimsNode): vscode.TreeItem {
		switch (node.kind) {
			case 'claim': {
				const { report } = node;
				const label = node.number ? `${node.number} ${report.claim.statement}` : report.claim.statement;
				const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = `${STATUS_LABEL[report.status]} · ${report.claim.id}`;
				item.iconPath = statusIcon(report.status);
				item.tooltip = claimMarkdown(report, this.model.config, this.model.depth, this.model.reports, this.model.unverifiedLinesIn(report));
				item.contextValue = 'prooftree.claim';
				return item;
			}
			case 'anchor': {
				const { anchor } = node;
				const formal = anchor.anchor.role === 'formal';
				const item = new vscode.TreeItem(formal && node.report.claim.formal ? `Lean: ${node.report.claim.formal.declaration}` : path.basename(anchor.anchor.file));
				item.description = describeAnchor(anchor).slice(formal ? 0 : anchor.anchor.file.length);
				item.resourceUri = vscode.Uri.joinPath(this.model.folder.uri, anchor.anchor.file);
				item.iconPath = new vscode.ThemeIcon(anchor.kind === 'changed' || anchor.kind === 'missing' ? 'diff-modified' : formal ? 'symbol-function' : 'symbol-file');
				if (anchor.kind !== 'missing') {
					item.command = {
						command: 'vscode.open',
						title: 'Open',
						arguments: [item.resourceUri, { selection: anchorRange(anchor) } satisfies vscode.TextDocumentShowOptions],
					};
				}
				return item;
			}
			case 'edits': {
				const count = this.model.unverifiedEdits.length;
				const item = new vscode.TreeItem('Agent code without evidence', vscode.TreeItemCollapsibleState.Expanded);
				item.description = `${count} edit${count === 1 ? '' : 's'}`;
				item.tooltip = 'Agent-written lines that no person reviewed and no claim\'s passing check or approval covers. A check does not vouch for the tests it runs, and keeping an edit is not reviewing it.';
				item.iconPath = new vscode.ThemeIcon('eye-closed', new vscode.ThemeColor('prooftree.unverifiedAgentCodeOverviewRuler'));
				return item;
			}
			case 'edit': {
				const { edit } = node;
				const item = new vscode.TreeItem(`${path.basename(edit.file)}:${editLines(edit)}`);
				item.description = edit.source.decision === 'written'
					? `${writerOf(edit.source)}${edit.source.tool ? ` · ${edit.source.tool}` : ''}`
					: `${writerOf(edit.source)} · kept by ${edit.source.by.name}`;
				item.tooltip = editMarkdown(edit);
				item.resourceUri = vscode.Uri.joinPath(this.model.folder.uri, edit.file);
				item.iconPath = new vscode.ThemeIcon('sparkle');
				item.contextValue = 'prooftree.edit';
				item.command = {
					command: 'vscode.open',
					title: 'Open',
					arguments: [item.resourceUri, { selection: editRange(edit) } satisfies vscode.TextDocumentShowOptions],
				};
				return item;
			}
			case 'detail': {
				const item = new vscode.TreeItem(node.label);
				item.description = node.description;
				item.tooltip = node.description ?? node.label;
				item.iconPath = new vscode.ThemeIcon(node.icon);
				return item;
			}
		}
	}

	dispose(): void {
		this._listener.dispose();
		this._onDidChangeTreeData.dispose();
	}
}
