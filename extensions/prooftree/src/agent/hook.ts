/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { agentContract, describeObligations } from '../ledger/format';
import { ProoftreeService } from '../ledger/service';

/**
 * Handles agent hook events. VS Code (`.github/hooks`, `.claude/settings.json`) and Claude
 * Code share the contract: JSON event on stdin, exit code 2 blocks with stderr shown to
 * the model, and `hookSpecificOutput.additionalContext` adds context.
 */
export interface HookResult {
	readonly exitCode: number;
	readonly stdout?: string;
	readonly stderr?: string;
}

const ALLOW: HookResult = { exitCode: 0 };

function additionalContext(hookEventName: string, text: string): HookResult {
	return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext: text } }) };
}

/** File paths named in a tool call: path-like fields, and files in an apply_patch body. */
export function editedFiles(toolInput: unknown): string[] {
	const files = new Set<string>();
	const visit = (value: unknown, key: string) => {
		if (typeof value === 'string') {
			if (/^(file_?path|path|file)s?$/i.test(key)) {
				files.add(value);
			}
			for (const match of value.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)) {
				files.add(match[1].trim());
			}
		} else if (Array.isArray(value)) {
			value.forEach(item => visit(item, key));
		} else if (value && typeof value === 'object') {
			Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
		}
	};
	visit(toolInput, '');
	return [...files];
}

export function handleHook(event: Record<string, any>, service: ProoftreeService): HookResult {
	const name: string = event.hook_event_name ?? event.hookEventName ?? '';
	const config = service.config();

	switch (name) {
		case 'SessionStart': {
			const open = service.obligations();
			return additionalContext(name, agentContract(config) + (open.length ? '\n\n' + describeObligations(open, config) : ''));
		}
		case 'PostToolUse': {
			const files = editedFiles(event.tool_input ?? event.toolInput).filter(file => {
				try {
					service.relativePath(file);
					return true;
				} catch {
					return false;
				}
			});
			if (!files.length) {
				return ALLOW;
			}
			const affected = service.claimsTouching(files).filter(report => !config.gate.accept.includes(report.status));
			return affected.length
				? additionalContext(name, 'Prooftree: this edit affects claims.\n' + describeObligations(affected, config))
				: ALLOW;
		}
		case 'Stop':
		case 'SubagentStop': {
			if (!config.gate.onStop) {
				return ALLOW;
			}
			const open = service.obligations();
			if (!open.length) {
				return ALLOW;
			}
			const message = describeObligations(open, config);
			// A second block in a row would loop an agent that cannot discharge a claim; warn the person instead.
			if (event.stop_hook_active) {
				return { exitCode: 1, stderr: `Prooftree: the agent stopped with open obligations.\n${message}` };
			}
			return { exitCode: 2, stderr: `Prooftree: you cannot finish yet.\n${message}\n\nDischarge these with prooftree_run_check, re-anchor changed claims with prooftree_update_claim, or tell the user which claims you could not discharge and why.` };
		}
		default:
			return ALLOW;
	}
}
