/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { AnchorState } from '../ledger/anchors';
import { describeAnchor, nextStep, STATUS_LABEL } from '../ledger/format';
import { ClaimReport } from '../ledger/status';
import { anchorRange, ProoftreeModel } from './model';
import { claimTooltip, sortReports, statusIcon } from './presentation';

export type ClaimsNode =
	| { readonly kind: 'claim'; readonly report: ClaimReport }
	| { readonly kind: 'anchor'; readonly report: ClaimReport; readonly anchor: AnchorState }
	| { readonly kind: 'detail'; readonly label: string; readonly description?: string; readonly icon: string };

export class ClaimsView implements vscode.TreeDataProvider<ClaimsNode>, vscode.Disposable {

	private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
	private readonly _listener: vscode.Disposable;

	constructor(private readonly model: ProoftreeModel) {
		this._listener = model.onDidChange(() => this._onDidChangeTreeData.fire());
	}

	getChildren(node?: ClaimsNode): ClaimsNode[] {
		if (!node) {
			if (this.model.error) {
				return [{ kind: 'detail', label: 'Cannot read the ledger', description: this.model.error, icon: 'warning' }];
			}
			return sortReports(this.model.reports.values()).map(report => ({ kind: 'claim', report }));
		}
		if (node.kind !== 'claim') {
			return [];
		}
		const { report } = node;
		const config = this.model.config;
		const children: ClaimsNode[] = report.anchors.map(anchor => ({ kind: 'anchor', report, anchor }));
		for (const dependency of report.claim.dependsOn) {
			const dependencyReport = this.model.reports.get(dependency);
			if (dependencyReport) {
				children.push({ kind: 'claim', report: dependencyReport });
			} else {
				children.push({ kind: 'detail', label: dependency, description: 'retracted or missing dependency', icon: 'warning' });
			}
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
				const item = new vscode.TreeItem(report.claim.statement, vscode.TreeItemCollapsibleState.Collapsed);
				item.id = undefined; // the same claim can appear as a dependency of several claims
				item.description = `${STATUS_LABEL[report.status]} · ${report.claim.id}`;
				item.iconPath = statusIcon(report.status);
				item.tooltip = claimTooltip(report, this.model.config);
				item.contextValue = 'prooftree.claim';
				return item;
			}
			case 'anchor': {
				const { anchor } = node;
				const item = new vscode.TreeItem(path.basename(anchor.anchor.file));
				item.description = describeAnchor(anchor).slice(anchor.anchor.file.length);
				item.resourceUri = vscode.Uri.joinPath(this.model.folder.uri, anchor.anchor.file);
				item.iconPath = new vscode.ThemeIcon(anchor.kind === 'changed' || anchor.kind === 'missing' ? 'diff-modified' : 'symbol-file');
				if (anchor.kind !== 'missing') {
					item.command = {
						command: 'vscode.open',
						title: 'Open',
						arguments: [item.resourceUri, { selection: anchorRange(anchor) } satisfies vscode.TextDocumentShowOptions],
					};
				}
				return item;
			}
			case 'detail': {
				const item = new vscode.TreeItem(node.label);
				item.description = node.description;
				item.tooltip = node.description;
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
