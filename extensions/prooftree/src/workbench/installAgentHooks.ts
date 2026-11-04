/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const HOOK_EVENTS = ['SessionStart', 'PostToolUse', 'Stop', 'SubagentStop'] as const;

interface Target {
	readonly label: string;
	readonly detail: string;
	readonly file: string;
	update(existing: any, cli: string): any;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Drops hooks a previous install added, so installing again does not duplicate them. */
function withoutOurs<T>(entries: T[] | undefined, isOurs: (entry: T) => boolean): T[] {
	return (entries ?? []).filter(entry => !isOurs(entry));
}

const TARGETS: readonly Target[] = [
	{
		label: '.claude/settings.json',
		detail: 'Hooks for Claude Code and for VS Code agents (VS Code reads this file too).',
		file: '.claude/settings.json',
		update(existing, cli) {
			const hooks = { ...existing.hooks };
			const isOurs = (entry: any) => entry?.hooks?.some((hook: any) => typeof hook.command === 'string' && hook.command.includes(cli));
			for (const event of HOOK_EVENTS) {
				hooks[event] = [...withoutOurs(hooks[event], isOurs), { hooks: [{ type: 'command', command: `node ${shellQuote(cli)} hook` }] }];
			}
			return { ...existing, hooks };
		},
	},
	{
		label: '.github/hooks/prooftree.json',
		detail: 'Hooks for VS Code agents only.',
		file: '.github/hooks/prooftree.json',
		update(_existing, cli) {
			const command = { type: 'command', command: `node ${shellQuote(cli)} hook` };
			return { hooks: Object.fromEntries(HOOK_EVENTS.map(event => [event, [command]])) };
		},
	},
	{
		label: '.mcp.json',
		detail: 'The Prooftree MCP server, so Claude Code gets the same claim tools as VS Code chat.',
		file: '.mcp.json',
		update(existing, cli) {
			return { ...existing, mcpServers: { ...existing.mcpServers, prooftree: { command: 'node', args: [cli, 'mcp'] } } };
		},
	},
];

export async function installAgentHooks(folder: vscode.WorkspaceFolder, cli: string): Promise<void> {
	const picked = await vscode.window.showQuickPick(TARGETS.map(target => ({ ...target, picked: target.file !== '.github/hooks/prooftree.json' })), {
		canPickMany: true,
		title: 'Connect agents to Prooftree',
		placeHolder: 'Files to write in this workspace. Do not pick both hook files: VS Code would run the hooks twice.',
	});
	if (!picked?.length) {
		return;
	}
	const written: string[] = [];
	for (const target of picked) {
		const file = path.join(folder.uri.fsPath, target.file);
		let existing: any = {};
		if (fs.existsSync(file)) {
			try {
				existing = JSON.parse(fs.readFileSync(file, 'utf8'));
			} catch {
				vscode.window.showErrorMessage(`${target.file} is not valid JSON; it was left unchanged.`);
				continue;
			}
		}
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify(target.update(existing, cli), undefined, '\t') + '\n');
		written.push(target.file);
	}
	if (written.length) {
		vscode.window.showInformationMessage(`Prooftree: updated ${written.join(', ')}. Hooks call ${cli} with \`node\` from PATH.`);
	}
}
