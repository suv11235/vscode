/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { AnchorState } from '../ledger/anchors';
import { ProoftreeConfig } from '../ledger/config';
import { EditReport } from '../ledger/edits';
import { ReasoningDepth } from '../ledger/format';
import { LEDGER_DIR } from '../ledger/ledger';
import { ProoftreeService } from '../ledger/service';
import { ClaimReport } from '../ledger/status';

/** Evaluated claims for one workspace folder, refreshed as the ledger and files change. */
export class ProoftreeModel implements vscode.Disposable {

	readonly service: ProoftreeService;

	private _reports = new Map<string, ClaimReport>();
	private _edits: EditReport[] = [];
	private _config: ProoftreeConfig;
	private _error: string | undefined;
	private _timer: ReturnType<typeof setTimeout> | undefined;
	private readonly _disposables: vscode.Disposable[] = [];
	private readonly _onDidChange = new vscode.EventEmitter<void>();
	readonly onDidChange = this._onDidChange.event;

	constructor(readonly folder: vscode.WorkspaceFolder) {
		const root = folder.uri.fsPath;
		this.service = new ProoftreeService(root, file => {
			const absolute = path.join(root, file);
			return vscode.workspace.textDocuments.find(document => document.uri.fsPath === absolute)?.getText();
		});
		this._config = this.service.config();

		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, `${LEDGER_DIR}/**`));
		this._disposables.push(
			watcher,
			watcher.onDidChange(() => this.refresh()),
			watcher.onDidCreate(() => this.refresh()),
			watcher.onDidDelete(() => this.refresh()),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (this.isAnchored(event.document.uri)) {
					this.scheduleRefresh();
				}
			}),
			vscode.workspace.onDidSaveTextDocument(() => this.scheduleRefresh()),
			vscode.workspace.onDidCreateFiles(() => this.scheduleRefresh()),
			vscode.workspace.onDidDeleteFiles(() => this.scheduleRefresh()),
			vscode.workspace.onDidRenameFiles(() => this.scheduleRefresh()),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('prooftree.reasoningDepth')) {
					this._onDidChange.fire();
				}
			}),
			this._onDidChange,
		);
		this.refresh();
	}

	get reports(): ReadonlyMap<string, ClaimReport> {
		return this._reports;
	}

	/** Agent-written lines people kept, reviewed or not. */
	get edits(): readonly EditReport[] {
		return this._edits;
	}

	get unreviewedEdits(): EditReport[] {
		return this._edits.filter(edit => edit.status === 'unreviewed');
	}

	/** Kept agent lines in the given document. */
	editsIn(uri: vscode.Uri): EditReport[] {
		const file = this.relativePath(uri);
		return this._edits.filter(edit => edit.file === file);
	}

	/** How many agent-written lines inside the claim's code were kept without review. */
	unreviewedLinesIn(report: ClaimReport): number {
		let count = 0;
		for (const anchor of report.anchors) {
			if (anchor.startLine === undefined || anchor.endLine === undefined || anchor.anchor.role === 'formal') {
				continue;
			}
			for (const edit of this._edits) {
				if (edit.status === 'unreviewed' && edit.file === anchor.anchor.file) {
					count += Math.max(0, Math.min(edit.endLine, anchor.endLine) - Math.max(edit.startLine, anchor.startLine) + 1);
				}
			}
		}
		return count;
	}

	get config(): ProoftreeConfig {
		return this._config;
	}

	/** How much reasoning people see by default: 1 summary, 2 explanation, 3 full detail. */
	get depth(): ReasoningDepth {
		const depth = vscode.workspace.getConfiguration('prooftree').get<number>('reasoningDepth', 1);
		return depth === 2 || depth === 3 ? depth : 1;
	}

	/** Why the ledger or config could not be read, if it could not. */
	get error(): string | undefined {
		return this._error;
	}

	obligations(): ClaimReport[] {
		return this.service.obligations(this._reports as Map<string, ClaimReport>);
	}

	relativePath(uri: vscode.Uri): string | undefined {
		if (uri.scheme !== 'file') {
			return undefined;
		}
		try {
			return this.service.relativePath(uri.fsPath);
		} catch {
			return undefined;
		}
	}

	/** Anchors in the given document, with the claims they belong to. */
	anchorsIn(uri: vscode.Uri): { report: ClaimReport; anchor: AnchorState }[] {
		const file = this.relativePath(uri);
		const result: { report: ClaimReport; anchor: AnchorState }[] = [];
		for (const report of this._reports.values()) {
			for (const anchor of report.anchors) {
				if (anchor.anchor.file === file) {
					result.push({ report, anchor });
				}
			}
		}
		return result;
	}

	refresh(): void {
		clearTimeout(this._timer);
		try {
			this._config = this.service.config();
			const state = this.service.state();
			this._reports = this.service.evaluate(state);
			this._edits = this.service.edits(state);
			this._error = undefined;
		} catch (error) {
			this._error = error instanceof Error ? error.message : String(error);
		}
		this._onDidChange.fire();
	}

	private scheduleRefresh(): void {
		clearTimeout(this._timer);
		this._timer = setTimeout(() => this.refresh(), 300);
	}

	private isAnchored(uri: vscode.Uri): boolean {
		const file = this.relativePath(uri);
		return !!file && ([...this._reports.values()].some(report => report.claim.anchors.some(anchor => anchor.file === file))
			|| this._edits.some(edit => edit.file === file));
	}

	dispose(): void {
		clearTimeout(this._timer);
		this._disposables.forEach(disposable => disposable.dispose());
	}
}

export function anchorRange(anchor: AnchorState): vscode.Range {
	if (anchor.startLine === undefined || anchor.endLine === undefined) {
		return new vscode.Range(0, 0, 0, 0);
	}
	return new vscode.Range(anchor.startLine - 1, 0, anchor.endLine - 1, Number.MAX_SAFE_INTEGER);
}

export function editRange(edit: EditReport): vscode.Range {
	return new vscode.Range(edit.startLine - 1, 0, edit.endLine - 1, Number.MAX_SAFE_INTEGER);
}
