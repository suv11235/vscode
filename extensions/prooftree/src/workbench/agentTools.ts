/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AGENT_TOOLS, AgentTool } from '../agent/tools';
import { Actor } from '../ledger/model';
import { ProoftreeModel } from './model';

const CHAT_AGENT: Actor = { kind: 'agent', name: 'vscode-chat' };

const READ_ONLY_TOOLS = new Set(['prooftree_list_obligations', 'prooftree_status']);

/** Registers {@link AGENT_TOOLS} as language model tools for chat agents. */
export function registerAgentTools(model: ProoftreeModel): vscode.Disposable {
	return vscode.Disposable.from(...AGENT_TOOLS.map(tool => vscode.lm.registerTool(tool.name, new LanguageModelTool(tool, model))));
}

class LanguageModelTool implements vscode.LanguageModelTool<any> {

	constructor(private readonly tool: AgentTool, private readonly model: ProoftreeModel) { }

	prepareInvocation(options: vscode.LanguageModelToolInvocationPrepareOptions<any>): vscode.PreparedToolInvocation {
		if (this.tool.name !== 'prooftree_run_check') {
			return {};
		}
		const { claim, check } = options.input as { claim: string; check: string };
		const command = this.model.config.checks[check];
		return {
			invocationMessage: `Running Prooftree check "${check}" for ${claim}`,
			confirmationMessages: command ? {
				title: `Run check "${check}"?`,
				message: new vscode.MarkdownString(`Runs \`${command}\` in the workspace and records the result for claim \`${claim}\`.`),
			} : undefined,
		};
	}

	async invoke(options: vscode.LanguageModelToolInvocationOptions<any>): Promise<vscode.LanguageModelToolResult> {
		// The hook command and checks read files from disk, so agent edits must be saved first.
		if (!READ_ONLY_TOOLS.has(this.tool.name)) {
			await vscode.workspace.saveAll(false);
		}
		let text: string;
		try {
			text = await this.tool.run(this.model.service, options.input, CHAT_AGENT);
		} catch (error) {
			text = `Error: ${error instanceof Error ? error.message : String(error)}`;
		} finally {
			this.model.refresh();
		}
		return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
	}
}
