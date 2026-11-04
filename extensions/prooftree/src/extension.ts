/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { localHuman } from './ledger/actor';
import { DEFAULT_CONFIG } from './ledger/config';
import { STATUS_LABEL } from './ledger/format';
import { Actor } from './ledger/model';
import { ClaimReport } from './ledger/status';
import { registerAgentTools } from './workbench/agentTools';
import { ClaimsNode, ClaimsView } from './workbench/claimsView';
import { ClaimCodeLensProvider, ClaimDecorations } from './workbench/editor';
import { installAgentHooks } from './workbench/installAgentHooks';
import { anchorRange, ProoftreeModel } from './workbench/model';

export function activate(context: vscode.ExtensionContext): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (!folder || folder.uri.scheme !== 'file') {
		return;
	}

	const model = new ProoftreeModel(folder);
	const claimsView = new ClaimsView(model);
	const treeView = vscode.window.createTreeView('prooftree.claims', { treeDataProvider: claimsView, showCollapseAll: true });
	const statusBar = vscode.window.createStatusBarItem('prooftree.status', vscode.StatusBarAlignment.Left, 50);
	statusBar.name = 'Prooftree';
	statusBar.command = 'prooftree.claims.focus';

	const updateStatusBar = () => {
		const total = model.reports.size;
		const open = model.obligations().length;
		vscode.commands.executeCommand('setContext', 'prooftree.hasClaims', total > 0);
		if (!total && !model.error) {
			statusBar.hide();
			return;
		}
		statusBar.text = model.error ? '$(warning) Prooftree' : open ? `$(shield) ${total} · $(warning) ${open} open` : `$(verified-filled) ${total} claims`;
		statusBar.tooltip = model.error ?? `${total} claims, ${open} not discharged`;
		statusBar.backgroundColor = open || model.error ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
		statusBar.show();
	};

	const person = localHuman(folder.uri.fsPath);
	const human = (): Actor => person;

	/** Resolves a command argument (tree node, claim id or nothing) to a claim. */
	const pickClaim = async (argument: ClaimsNode | string | undefined, placeHolder: string): Promise<ClaimReport | undefined> => {
		if (typeof argument === 'string') {
			return model.reports.get(argument);
		}
		if (argument && argument.kind !== 'detail') {
			return argument.report;
		}
		const picked = await vscode.window.showQuickPick([...model.reports.values()].map(report => ({
			label: report.claim.statement,
			description: `${STATUS_LABEL[report.status]} · ${report.claim.id}`,
			report,
		})), { placeHolder });
		return picked?.report;
	};

	const run = (action: () => unknown) => async () => {
		try {
			await action();
		} catch (error) {
			vscode.window.showErrorMessage(`Prooftree: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			model.refresh();
		}
	};

	const command = (id: string, handler: (...args: any[]) => unknown) =>
		vscode.commands.registerCommand(id, (...args: any[]) => run(() => handler(...args))());

	context.subscriptions.push(
		model, claimsView, treeView, statusBar,
		new ClaimDecorations(model),
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new ClaimCodeLensProvider(model)),
		registerAgentTools(model),
		model.onDidChange(updateStatusBar),

		command('prooftree.declareClaim', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || !model.relativePath(editor.document.uri)) {
				throw new Error('Open a workspace file and select the lines the claim is about.');
			}
			await editor.document.save();
			const statement = await vscode.window.showInputBox({
				title: 'Declare claim',
				prompt: 'What is true about the selected code?',
				placeHolder: 'e.g. parseDate rejects months above 12',
			});
			if (!statement) {
				return;
			}
			const dependencies = model.reports.size ? await vscode.window.showQuickPick(
				[...model.reports.values()].map(report => ({ label: report.claim.statement, description: report.claim.id, id: report.claim.id })),
				{ canPickMany: true, title: 'Depends on (optional)', placeHolder: 'Claims this one relies on' },
			) : [];
			if (dependencies === undefined) {
				return;
			}
			const selection = editor.selection;
			const endLine = selection.end.character === 0 && selection.end.line > selection.start.line ? selection.end.line : selection.end.line + 1;
			const report = model.service.declareClaim({
				statement,
				anchors: [{ file: editor.document.uri.fsPath, startLine: selection.start.line + 1, endLine }],
				dependsOn: dependencies.map(dependency => dependency.id),
			}, human());
			vscode.window.showInformationMessage(`Declared ${report.claim.id}: ${STATUS_LABEL[report.status]}.`);
		}),

		command('prooftree.runCheck', async (argument?: ClaimsNode | string) => {
			const report = await pickClaim(argument, 'Claim to check');
			if (!report) {
				return;
			}
			const checks = Object.entries(model.config.checks);
			if (!checks.length) {
				throw new Error('No checks configured. Add them to .prooftree/config.json (Prooftree: Open Config).');
			}
			const check = checks.length === 1 ? checks[0][0] : (await vscode.window.showQuickPick(
				checks.map(([name, commandLine]) => ({ label: name, description: commandLine })), { placeHolder: 'Check to run' }))?.label;
			if (!check) {
				return;
			}
			await vscode.workspace.saveAll(false);
			const outcome = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Prooftree: running ${check}` },
				() => model.service.runCheck(report.claim.id, check, human()),
			);
			if (outcome.run.result === 'pass') {
				vscode.window.showInformationMessage(`Check "${check}" passed for ${report.claim.id}.`);
			} else {
				const output = vscode.window.createOutputChannel('Prooftree');
				output.appendLine(`[${check}] ${outcome.evidence.summary}\n${outcome.run.output}`);
				const choice = await vscode.window.showWarningMessage(`Check "${check}" failed for ${report.claim.id}.`, 'Show Output');
				if (choice) {
					output.show();
				}
			}
		}),

		command('prooftree.approve', async (argument?: ClaimsNode | string) => {
			const report = await pickClaim(argument, 'Claim to approve');
			if (report) {
				model.service.review(report.claim.id, 'approved', undefined, human());
			}
		}),

		command('prooftree.reject', async (argument?: ClaimsNode | string) => {
			const report = await pickClaim(argument, 'Claim to reject');
			const note = report && await vscode.window.showInputBox({ title: `Reject ${report.claim.id}`, prompt: 'What is wrong?' });
			if (report && note) {
				model.service.review(report.claim.id, 'rejected', note, human());
			}
		}),

		command('prooftree.reanchor', async (argument?: ClaimsNode | string) => {
			const report = await pickClaim(argument, 'Claim to re-anchor at its current code');
			if (report) {
				await vscode.workspace.saveAll(false);
				model.service.updateClaim({ claim: report.claim.id }, human());
			}
		}),

		command('prooftree.retract', async (argument?: ClaimsNode | string) => {
			const report = await pickClaim(argument, 'Claim to retract');
			if (!report) {
				return;
			}
			const reason = await vscode.window.showInputBox({ title: `Retract ${report.claim.id}`, prompt: 'Why is the claim withdrawn? Its history stays in the ledger.' });
			if (reason !== undefined) {
				model.service.retract(report.claim.id, reason || undefined, human());
			}
		}),

		command('prooftree.revealClaim', async (claimId: string) => {
			const report = model.reports.get(claimId);
			if (!report) {
				return;
			}
			const anchor = report.anchors.find(candidate => candidate.kind !== 'missing');
			if (anchor) {
				await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, anchor.anchor.file), { selection: anchorRange(anchor), preview: true });
			}
		}),

		command('prooftree.openConfig', async () => {
			if (!fs.existsSync(model.service.configPath)) {
				fs.mkdirSync(path.dirname(model.service.configPath), { recursive: true });
				const template = { ...DEFAULT_CONFIG, checks: { test: 'npm test' } };
				fs.writeFileSync(model.service.configPath, JSON.stringify(template, undefined, '\t') + '\n');
			}
			await vscode.window.showTextDocument(vscode.Uri.file(model.service.configPath));
		}),

		command('prooftree.openLedger', async () => {
			if (!fs.existsSync(model.service.ledgerPath)) {
				throw new Error('No ledger yet. Declare a claim first.');
			}
			await vscode.window.showTextDocument(vscode.Uri.file(model.service.ledgerPath));
		}),

		command('prooftree.installAgentHooks', () => installAgentHooks(folder, context.asAbsolutePath(path.join('out', 'cli', 'main.js')))),
		command('prooftree.refresh', () => undefined),
	);
	updateStatusBar();
}

export function deactivate(): void { }
