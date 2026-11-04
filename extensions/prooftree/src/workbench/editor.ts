/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ReasoningDepth, STATUS_LABEL } from '../ledger/format';
import { ClaimStatus } from '../ledger/status';
import { anchorRange, editRange, ProoftreeModel } from './model';
import { claimMarkdown, editMarkdown, STATUS_STYLE } from './presentation';

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
			const prefix = anchor.anchor.role === 'formal' ? 'Lean statement of ' : '';
			lenses.push(new vscode.CodeLens(range, {
				title: `$(${STATUS_STYLE[report.status].icon}) ${STATUS_LABEL[report.status]}: ${prefix}${statement}`,
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

/**
 * The claims covering the hovered line. The hover's + and - buttons change the reasoning
 * depth, as the reasoning depth slider does on a Prooftree statement page.
 */
export class ClaimHoverProvider implements vscode.HoverProvider {

	private readonly _depths = new WeakMap<vscode.Hover, ReasoningDepth>();

	constructor(private readonly model: ProoftreeModel) { }

	provideHover(document: vscode.TextDocument, position: vscode.Position, _token: vscode.CancellationToken, context?: vscode.HoverContext): vscode.VerboseHover | undefined {
		const hits = this.model.anchorsIn(document.uri).filter(({ anchor }) => anchor.startLine !== undefined && anchorRange(anchor).contains(position));
		if (!hits.length) {
			return undefined;
		}
		const previous = context?.previousHover && this._depths.get(context.previousHover);
		const depth = Math.min(3, Math.max(1, (previous ?? this.model.depth) + (context?.verbosityDelta ?? 0))) as ReasoningDepth;
		const contents = hits.map(({ report }) => claimMarkdown(report, this.model.config, depth, this.model.reports, this.model.unverifiedLinesIn(report)));
		const range = hits.map(({ anchor }) => anchorRange(anchor)).reduce((a, b) => a.intersection(b) ?? a);
		const hover = new vscode.VerboseHover(contents, range, depth < 3, depth > 1);
		this._depths.set(hover, depth);
		return hover;
	}
}

/** Colored left border and overview ruler marks on anchored ranges. */
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
		const byStatus = new Map<ClaimStatus, vscode.Range[]>();
		for (const { report, anchor } of this.model.anchorsIn(editor.document.uri)) {
			if (anchor.startLine !== undefined) {
				byStatus.set(report.status, [...(byStatus.get(report.status) ?? []), anchorRange(anchor)]);
			}
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

/** Who wrote the hovered agent lines and how they got in, while nothing covers them. */
export class EditHoverProvider implements vscode.HoverProvider {

	constructor(private readonly model: ProoftreeModel) { }

	provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const edit = this.model.editsIn(document.uri).find(candidate => candidate.status === 'unverified' && editRange(candidate).contains(position));
		return edit && new vscode.Hover(editMarkdown(edit), editRange(edit));
	}
}

/**
 * A tint and overview ruler mark on agent-written lines that only the agent vouches for,
 * whether an agent wrote them from a terminal or a person kept them in the editor. Lines a
 * person reviewed, or that a claim's passing check or approval covers, are left plain.
 */
export class EditDecorations implements vscode.Disposable {

	private readonly _type = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('prooftree.unverifiedAgentCodeBackground'),
		overviewRulerColor: new vscode.ThemeColor('prooftree.unverifiedAgentCodeOverviewRuler'),
		overviewRulerLane: vscode.OverviewRulerLane.Right,
	});
	private readonly _disposables: vscode.Disposable[] = [];

	constructor(private readonly model: ProoftreeModel) {
		this._disposables.push(
			model.onDidChange(() => this.updateAll()),
			vscode.window.onDidChangeVisibleTextEditors(() => this.updateAll()),
		);
		this.updateAll();
	}

	private updateAll(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			const ranges = this.model.editsIn(editor.document.uri).filter(edit => edit.status === 'unverified').map(editRange);
			editor.setDecorations(this._type, ranges);
		}
	}

	dispose(): void {
		this._type.dispose();
		this._disposables.forEach(disposable => disposable.dispose());
	}
}
