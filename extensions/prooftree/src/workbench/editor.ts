/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { STATUS_LABEL } from '../ledger/format';
import { ClaimStatus } from '../ledger/status';
import { anchorRange, ProoftreeModel } from './model';
import { claimTooltip, STATUS_STYLE } from './presentation';

const MAX_LENS_STATEMENT = 80;

/** A lens above each anchored range: the claim's status and statement, plus actions. */
export class ClaimCodeLensProvider implements vscode.CodeLensProvider {

	readonly onDidChangeCodeLenses: vscode.Event<void>;

	constructor(private readonly model: ProoftreeModel) {
		this.onDidChangeCodeLenses = model.onDidChange;
	}

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const lenses: vscode.CodeLens[] = [];
		for (const { report, anchor } of this.model.anchorsIn(document.uri)) {
			const range = anchorRange(anchor).with({ end: anchorRange(anchor).start });
			const statement = report.claim.statement.length > MAX_LENS_STATEMENT
				? report.claim.statement.slice(0, MAX_LENS_STATEMENT - 1) + '…'
				: report.claim.statement;
			lenses.push(new vscode.CodeLens(range, {
				title: `$(${STATUS_STYLE[report.status].icon}) ${STATUS_LABEL[report.status]}: ${statement}`,
				tooltip: report.claim.id,
				command: 'prooftree.revealClaim',
				arguments: [report.claim.id],
			}));
			if (report.status === 'drifted') {
				lenses.push(new vscode.CodeLens(range, { title: 'Re-anchor', command: 'prooftree.reanchor', arguments: [report.claim.id] }));
			}
			if (Object.keys(this.model.config.checks).length) {
				lenses.push(new vscode.CodeLens(range, { title: 'Run check', command: 'prooftree.runCheck', arguments: [report.claim.id] }));
			}
			if (report.review !== 'approved') {
				lenses.push(new vscode.CodeLens(range, { title: 'Approve', command: 'prooftree.approve', arguments: [report.claim.id] }));
			}
		}
		return lenses;
	}
}

/** Colored left border and overview ruler marks on anchored ranges, plus a hover. */
export class ClaimDecorations implements vscode.Disposable {

	private readonly _types = new Map<ClaimStatus, vscode.TextEditorDecorationType>();
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(private readonly model: ProoftreeModel) {
		for (const [status, style] of Object.entries(STATUS_STYLE) as [ClaimStatus, typeof STATUS_STYLE[ClaimStatus]][]) {
			const color = new vscode.ThemeColor(style.color);
			this._types.set(status, vscode.window.createTextEditorDecorationType({
				isWholeLine: true,
				borderWidth: '0 0 0 2px',
				borderStyle: 'solid',
				borderColor: color,
				overviewRulerColor: color,
				overviewRulerLane: vscode.OverviewRulerLane.Left,
			}));
		}
		this._disposables.push(
			model.onDidChange(() => this.updateAll()),
			vscode.window.onDidChangeVisibleTextEditors(() => this.updateAll()),
		);
		this.updateAll();
	}

	private updateAll(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			this.update(editor);
		}
	}

	private update(editor: vscode.TextEditor): void {
		const byStatus = new Map<ClaimStatus, vscode.DecorationOptions[]>();
		for (const { report, anchor } of this.model.anchorsIn(editor.document.uri)) {
			if (anchor.startLine === undefined) {
				continue;
			}
			const options = byStatus.get(report.status) ?? [];
			options.push({ range: anchorRange(anchor), hoverMessage: claimTooltip(report, this.model.config) });
			byStatus.set(report.status, options);
		}
		for (const [status, type] of this._types) {
			editor.setDecorations(type, byStatus.get(status) ?? []);
		}
	}

	dispose(): void {
		this._types.forEach(type => type.dispose());
		this._disposables.forEach(disposable => disposable.dispose());
	}
}
