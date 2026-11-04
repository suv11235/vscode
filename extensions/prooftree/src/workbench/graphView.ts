/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { buildGraph } from '../ledger/graph';
import { graphPage, graphPayload } from './graphPage';
import { ProoftreeModel } from './model';

/** The knowledge graph in an editor tab. Clicking a node opens the claim or file. */
export class GraphPanel implements vscode.Disposable {

	private static _current: GraphPanel | undefined;

	static show(model: ProoftreeModel): void {
		if (GraphPanel._current) {
			GraphPanel._current._panel.reveal();
			return;
		}
		GraphPanel._current = new GraphPanel(model);
	}

	private readonly _panel: vscode.WebviewPanel;
	private readonly _disposables: vscode.Disposable[] = [];

	private constructor(private readonly model: ProoftreeModel) {
		this._panel = vscode.window.createWebviewPanel('prooftree.graph', 'Prooftree Graph', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
		this._panel.iconPath = new vscode.ThemeIcon('type-hierarchy');
		this._panel.webview.html = graphPage(randomBytes(16).toString('base64'));
		this._disposables.push(
			this._panel.onDidDispose(() => this.dispose()),
			// The page asks for the graph once its script runs; a message posted earlier would be lost.
			this._panel.webview.onDidReceiveMessage(message => message.type === 'ready' ? this.post() : this.open(message.id)),
			model.onDidChange(() => this.post()),
		);
	}

	private post(): void {
		this._panel.webview.postMessage(graphPayload(this.model.reports));
	}

	private async open(id: string): Promise<void> {
		if (this.model.reports.has(id)) {
			await vscode.commands.executeCommand('prooftree.revealClaim', id);
			return;
		}
		const node = buildGraph(this.model.reports).nodes.find(candidate => candidate.id === id);
		if (node?.file) {
			const line = Math.max(0, (node.line ?? 1) - 1);
			await vscode.window.showTextDocument(vscode.Uri.joinPath(this.model.folder.uri, node.file), {
				viewColumn: vscode.ViewColumn.Beside,
				selection: new vscode.Range(line, 0, line, 0),
			});
		}
	}

	dispose(): void {
		GraphPanel._current = undefined;
		this._disposables.forEach(disposable => disposable.dispose());
		this._panel.dispose();
	}
}
