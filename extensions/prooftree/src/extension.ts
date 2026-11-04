/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { localHuman } from './ledger/actor';
import { WORKFLOW_FILE, workflowTemplate } from './ledger/ci';
import { describeCheck } from './ledger/config';
import { STATUS_LABEL } from './ledger/format';
import { Actor } from './ledger/model';
import { LEDGER_DIR } from './ledger/ledger';
import { AnchorInput, KeptEditInput, LineRange } from './ledger/service';
import { ClaimReport } from './ledger/status';
import { registerAgentTools } from './workbench/agentTools';
import { ClaimsNode, ClaimsView } from './workbench/claimsView';
import { ClaimCodeLensProvider, ClaimDecorations, ClaimHoverProvider, EditDecorations, EditHoverProvider } from './workbench/editor';
import { GraphPanel } from './workbench/graphView';
import { installAgentHooks } from './workbench/installAgentHooks';
import { anchorRange, ProoftreeModel } from './workbench/model';

const CONFIG_TEMPLATE = {
	checks: {
		test: { command: 'npm test', inputs: ['test/**', 'package.json'] },
		lean: { kind: 'lean', inputs: ['lakefile.*', 'lean-toolchain'] },
	},
	checkTimeoutSeconds: 300,
	gate: { onStop: true, scope: 'agent', accept: ['checked', 'reviewed', 'proved'], unreviewedEdits: 'warn' },
};

/** What the workbench reports when a person keeps an agent's edit (see contrib/prooftree). */
interface KeptAgentEdit {
	readonly uri: vscode.Uri;
	readonly ranges: readonly LineRange[];
	readonly decision: KeptEditInput['decision'];
	readonly agent?: string;
	readonly model?: string;
	readonly session?: string;
	readonly request?: string;
}

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
		const unreviewed = model.unreviewedEdits.length;
		vscode.commands.executeCommand('setContext', 'prooftree.hasClaims', total > 0);
		// Tells the workbench to offer Keep as Reviewed on agent edits.
		vscode.commands.executeCommand('setContext', 'prooftree.enabled', fs.existsSync(path.join(folder.uri.fsPath, LEDGER_DIR)));
		if (!total && !unreviewed && !model.error) {
			statusBar.hide();
			return;
		}
		const claims = open ? `$(shield) ${total} · $(warning) ${open} open` : `$(verified-filled) ${total} claims`;
		statusBar.text = model.error ? '$(warning) Prooftree' : claims + (unreviewed ? ` · $(eye-closed) ${unreviewed}` : '');
		statusBar.tooltip = model.error ?? `${total} claims, ${open} not discharged` + (unreviewed ? `\n${unreviewed} kept agent edit${unreviewed === 1 ? '' : 's'} not reviewed` : '');
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
		if (argument && (argument.kind === 'claim' || argument.kind === 'anchor')) {
			return argument.report;
		}
		const picked = await vscode.window.showQuickPick([...model.reports.values()].map(report => ({
			label: report.claim.statement,
			description: `${STATUS_LABEL[report.status]} · ${report.claim.id}`,
			report,
		})), { placeHolder });
		return picked?.report;
	};

	/** The selected lines of the active editor, if it shows a workspace file. */
	const selectionAnchor = async (): Promise<AnchorInput | undefined> => {
		const editor = vscode.window.activeTextEditor;
		if (!editor || !model.relativePath(editor.document.uri)) {
			return undefined;
		}
		await editor.document.save();
		const { start, end } = editor.selection;
		const endLine = end.character === 0 && end.line > start.line ? end.line : end.line + 1;
		return { file: editor.document.uri.fsPath, startLine: start.line + 1, endLine };
	};

	const pickPremises = async (): Promise<string[] | undefined> => {
		if (!model.reports.size) {
			return [];
		}
		const picked = await vscode.window.showQuickPick(
			[...model.reports.values()].map(report => ({ label: report.claim.statement, description: report.claim.id, id: report.claim.id })),
			{ canPickMany: true, title: 'Depends on (optional)', placeHolder: 'Claims this one relies on' },
		);
		return picked?.map(item => item.id);
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
		new EditDecorations(model),
		vscode.languages.registerCodeLensProvider({ scheme: 'file' }, new ClaimCodeLensProvider(model)),
		vscode.languages.registerHoverProvider({ scheme: 'file' }, new ClaimHoverProvider(model)),
		vscode.languages.registerHoverProvider({ scheme: 'file' }, new EditHoverProvider(model)),
		registerAgentTools(model),
		model.onDidChange(updateStatusBar),

		command('prooftree.declareClaim', async () => {
			const anchor = await selectionAnchor();
			if (!anchor) {
				throw new Error('Open a workspace file and select the lines the claim is about.');
			}
			const statement = await vscode.window.showInputBox({
				title: 'Declare claim',
				prompt: 'What is true about the selected code?',
				placeHolder: 'e.g. parseDate rejects months above 12',
			});
			const dependsOn = statement ? await pickPremises() : undefined;
			if (!statement || !dependsOn) {
				return;
			}
			const report = model.service.declareClaim({ statement, anchors: [anchor], dependsOn }, human());
			vscode.window.showInformationMessage(`Declared ${report.claim.id}: ${STATUS_LABEL[report.status]}.`);
		}),

		command('prooftree.addStep', async (argument?: ClaimsNode | string) => {
			const goal = await pickClaim(argument, 'Goal to add a step to');
			if (!goal) {
				return;
			}
			const anchor = await selectionAnchor();
			const statement = await vscode.window.showInputBox({
				title: `Add step ${goal.steps.length + 1} to ${goal.claim.id}`,
				prompt: anchor ? 'What does this step establish about the selected code?' : 'What does this step establish? (No code is selected, so the step has no anchor.)',
			});
			if (!statement) {
				return;
			}
			const report = model.service.declareClaim({ statement, anchors: anchor ? [anchor] : [], parent: goal.claim.id }, human());
			vscode.window.showInformationMessage(`Added ${report.claim.id} as step ${goal.steps.length + 1} of ${goal.claim.id}.`);
		}),

		command('prooftree.linkLean', async (argument?: ClaimsNode | string) => {
			const report = await pickClaim(argument, 'Claim to state in Lean');
			if (!report) {
				return;
			}
			const files = await vscode.workspace.findFiles('**/*.lean', '{**/.lake/**,**/node_modules/**}', 500);
			const file = await vscode.window.showQuickPick(files.map(uri => ({ label: vscode.workspace.asRelativePath(uri), uri })), { placeHolder: 'Lean file with the theorem' });
			const declaration = file && await vscode.window.showInputBox({ title: 'Lean declaration', prompt: `Theorem or lemma in ${file.label} that states "${report.claim.statement}"` });
			if (file && declaration) {
				model.service.updateClaim({ claim: report.claim.id, formal: { file: file.uri.fsPath, declaration } }, human());
			}
		}),

		command('prooftree.runCheck', async (argument?: ClaimsNode | string) => {
			const report = await pickClaim(argument, 'Claim to check');
			if (!report) {
				return;
			}
			const checks = Object.entries(model.config.checks).filter(([, check]) => check.kind !== 'lean' || report.claim.formal);
			if (!checks.length) {
				throw new Error('No checks apply. Add them to .prooftree/config.json (Prooftree: Open Config); Lean checks need a linked Lean declaration.');
			}
			const name = checks.length === 1 ? checks[0][0] : (await vscode.window.showQuickPick(
				checks.map(([checkName, check]) => ({ label: checkName, description: describeCheck(check) })), { placeHolder: 'Check to run' }))?.label;
			if (!name) {
				return;
			}
			await vscode.workspace.saveAll(false);
			const outcome = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `Prooftree: running ${name}` },
				() => model.service.runCheck(report.claim.id, name, human()),
			);
			if (outcome.evidence.result === 'pass') {
				vscode.window.showInformationMessage(`Check "${name}" passed for ${report.claim.id}: ${outcome.evidence.summary}.`);
			} else {
				const output = vscode.window.createOutputChannel('Prooftree');
				output.appendLine(`[${name}] ${outcome.evidence.summary}\n${outcome.output}`);
				const choice = await vscode.window.showWarningMessage(`Check "${name}" failed for ${report.claim.id}: ${outcome.evidence.summary}.`, 'Show Output');
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
			const anchor = report?.anchors.find(candidate => candidate.kind !== 'missing');
			if (anchor) {
				await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, anchor.anchor.file), { selection: anchorRange(anchor), preview: true });
			}
		}),

		// Called by the workbench when a person keeps an agent's edit, with or without reviewing it.
		vscode.commands.registerCommand('_prooftree.recordAgentEdit', (edit: KeptAgentEdit) => {
			if (!fs.existsSync(path.join(folder.uri.fsPath, LEDGER_DIR)) || !model.relativePath(edit.uri)) {
				return;
			}
			try {
				model.service.recordKeptEdit({ ...edit, file: edit.uri.fsPath }, human());
			} finally {
				model.refresh();
			}
		}),

		command('prooftree.reviewEdit', async (argument?: ClaimsNode | { file: string; startLine: number; endLine: number }) => {
			let file: string;
			let lines: LineRange | undefined;
			if (argument && 'kind' in argument) {
				if (argument.kind !== 'edit') {
					return;
				}
				file = argument.edit.file;
				lines = { startLine: argument.edit.startLine, endLine: argument.edit.endLine };
			} else if (argument) {
				({ file } = argument);
				lines = { startLine: argument.startLine, endLine: argument.endLine };
			} else {
				const editor = vscode.window.activeTextEditor;
				const relative = editor && model.relativePath(editor.document.uri);
				if (!editor || !relative) {
					throw new Error('Open a file with kept agent edits, or pick one in the Claims view.');
				}
				file = relative;
				const { start, end } = editor.selection;
				const line = start.line + 1;
				// With a selection, review just those lines; otherwise the kept edit under the cursor.
				const atCursor = model.editsIn(editor.document.uri).find(edit => edit.status === 'unreviewed' && edit.startLine <= line && line <= edit.endLine);
				lines = editor.selection.isEmpty
					? atCursor && { startLine: atCursor.startLine, endLine: atCursor.endLine }
					: { startLine: line, endLine: end.character === 0 && end.line > start.line ? end.line : end.line + 1 };
				if (!lines) {
					throw new Error('No unreviewed agent edit at the cursor. Select lines to review, or pick an edit in the Claims view.');
				}
			}
			const reviews = model.service.reviewEdits(vscode.Uri.joinPath(folder.uri, file).fsPath, lines, human());
			if (!reviews.length) {
				vscode.window.showInformationMessage('Prooftree: those lines have no unreviewed agent edits.');
			}
		}),

		command('prooftree.showGraph', () => GraphPanel.show(model)),

		command('prooftree.setReasoningDepth', async () => {
			const options = [
				{ label: '1', description: 'Summary', depth: 1 },
				{ label: '2', description: 'Explanation', depth: 2 },
				{ label: '3', description: 'Full detail', depth: 3 },
			];
			const picked = await vscode.window.showQuickPick(options.map(option => ({ ...option, picked: option.depth === model.depth })), {
				title: 'Reasoning depth',
				placeHolder: 'How much reasoning to show in the claims view and hovers. Deeper shows more explanation, not more certainty.',
			});
			if (picked) {
				await vscode.workspace.getConfiguration('prooftree').update('reasoningDepth', picked.depth, vscode.ConfigurationTarget.Global);
			}
		}),

		command('prooftree.addCiWorkflow', async () => {
			const bundled = context.asAbsolutePath(path.join('dist', 'prooftree.cjs'));
			if (!fs.existsSync(bundled)) {
				throw new Error('The bundled CLI is missing. Run `npm run build-cli` in extensions/prooftree.');
			}
			const root = folder.uri.fsPath;
			const workflow = path.join(root, WORKFLOW_FILE);
			if (fs.existsSync(workflow)) {
				const replace = await vscode.window.showWarningMessage(`${WORKFLOW_FILE} already exists.`, { modal: true }, 'Replace');
				if (replace !== 'Replace') {
					return;
				}
			}
			const usesLean = Object.values(model.config.checks).some(check => check.kind === 'lean');
			fs.mkdirSync(path.dirname(workflow), { recursive: true });
			fs.writeFileSync(workflow, workflowTemplate(usesLean));
			fs.mkdirSync(path.join(root, '.prooftree', 'bin'), { recursive: true });
			fs.copyFileSync(bundled, path.join(root, '.prooftree', 'bin', 'prooftree.cjs'));
			// Ledger lines are independent records, so concurrent branches merge by keeping both.
			const attributes = path.join(root, '.gitattributes');
			const line = '.prooftree/ledger.jsonl merge=union';
			const existing = fs.existsSync(attributes) ? fs.readFileSync(attributes, 'utf8') : '';
			if (!existing.includes(line)) {
				fs.writeFileSync(attributes, existing + (existing && !existing.endsWith('\n') ? '\n' : '') + line + '\n');
			}
			const opened = await vscode.window.showInformationMessage(`Prooftree: wrote ${WORKFLOW_FILE}, .prooftree/bin/prooftree.cjs and a union merge rule for the ledger. Install your checks' dependencies in the workflow.`, 'Open Workflow');
			if (opened) {
				await vscode.window.showTextDocument(vscode.Uri.file(workflow));
			}
		}),

		command('prooftree.openConfig', async () => {
			if (!fs.existsSync(model.service.configPath)) {
				fs.mkdirSync(path.dirname(model.service.configPath), { recursive: true });
				fs.writeFileSync(model.service.configPath, JSON.stringify(CONFIG_TEMPLATE, undefined, '\t') + '\n');
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
