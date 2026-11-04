/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256 } from '../ledger/anchors';
import { agentContract, describeObligations } from '../ledger/format';
import { Actor } from '../ledger/model';
import { ProoftreeService } from '../ledger/service';

/**
 * Handles agent hook events. VS Code (`.github/hooks`, `.claude/settings.json`) and Claude
 * Code share the contract: JSON event on stdin, exit code 2 blocks with stderr shown to
 * the model, and `hookSpecificOutput.additionalContext` adds context. Around each tool call
 * that writes files, PreToolUse snapshots the files and PostToolUse records the lines the
 * agent wrote, so its code is tracked whether or not it passes through Keep in the editor.
 */
export interface HookResult {
	readonly exitCode: number;
	readonly stdout?: string;
	readonly stderr?: string;
}

const ALLOW: HookResult = { exitCode: 0 };

/** Tools that write files: Edit, Write and MultiEdit in Claude Code; create_file, apply_patch and the replace tools in VS Code. */
const WRITE_TOOL = /edit|write|patch|create|replace|insert/i;
/** Larger files are not snapshotted, so their lines are not recorded. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const SNAPSHOT_TTL_MS = 60 * 60 * 1000;

/** Workspace files as they were before a tool call (null: did not exist), by relative path. */
type Snapshot = Record<string, string | null>;

/**
 * Keeps files between an agent's PreToolUse and PostToolUse hooks, which run as separate
 * processes, so the lines the tool changed can be found by diffing.
 */
export class SnapshotStore {

	constructor(private readonly dir = path.join(os.tmpdir(), 'prooftree-hook-snapshots')) { }

	save(key: string, snapshot: Snapshot): void {
		fs.mkdirSync(this.dir, { recursive: true });
		this.prune();
		fs.writeFileSync(path.join(this.dir, key + '.json'), JSON.stringify(snapshot));
	}

	/** Returns and deletes the snapshot. */
	take(key: string): Snapshot | undefined {
		const file = path.join(this.dir, key + '.json');
		try {
			const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
			fs.rmSync(file, { force: true });
			return snapshot;
		} catch {
			return undefined;
		}
	}

	/** Drops snapshots of tool calls that never finished. */
	private prune(): void {
		for (const name of fs.readdirSync(this.dir)) {
			const file = path.join(this.dir, name);
			try {
				if (Date.now() - fs.statSync(file).mtimeMs > SNAPSHOT_TTL_MS) {
					fs.rmSync(file, { force: true });
				}
			} catch {
				// removed by another hook
			}
		}
	}
}

export interface HookOptions {
	/** The agent running the hook, when the hook command names it. */
	readonly agent?: string;
	readonly snapshots?: SnapshotStore;
}

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

/** Workspace-relative paths of the workspace files a tool call names. */
function workspaceFiles(event: Record<string, any>, service: ProoftreeService): string[] {
	return editedFiles(event.tool_input ?? event.toolInput).flatMap(file => {
		try {
			return [service.relativePath(file)];
		} catch {
			return [];
		}
	});
}

/** Pairs a tool call's PreToolUse and PostToolUse events. */
function snapshotKey(event: Record<string, any>, service: ProoftreeService): string {
	const call = event.tool_use_id ?? `${event.tool_name}\0${JSON.stringify(event.tool_input ?? event.toolInput)}`;
	return sha256(`${service.root}\0${event.session_id ?? ''}\0${call}`).slice(0, 32);
}

/** Claude Code reports the file before an Edit or Write; used when there is no snapshot. */
function originalFiles(event: Record<string, any>, service: ProoftreeService): Snapshot {
	const response = event.tool_response;
	if (!response || typeof response !== 'object' || typeof response.filePath !== 'string') {
		return {};
	}
	try {
		const file = service.relativePath(response.filePath);
		if (typeof response.originalFile === 'string') {
			return { [file]: response.originalFile };
		}
		return response.type === 'create' ? { [file]: null } : {};
	} catch {
		return {};
	}
}

/** Who is running the hook: named by the hook command, or recognized from the event. */
function hookAgent(event: Record<string, any>, named: string | undefined): Actor {
	// VS Code stamps its hook events; Claude Code sends the permission mode and sets CLAUDE_PROJECT_DIR.
	const name = named ?? (typeof event.timestamp === 'string' ? 'VS Code agent' : 'permission_mode' in event || process.env.CLAUDE_PROJECT_DIR ? 'Claude Code' : 'agent');
	return { kind: 'agent', name };
}

/** Records the lines a tool call changed, by diffing against the files before it ran. */
function recordWrites(event: Record<string, any>, service: ProoftreeService, snapshots: SnapshotStore, agent: string | undefined): void {
	const before = snapshots.take(snapshotKey(event, service)) ?? originalFiles(event, service);
	for (const [file, content] of Object.entries(before)) {
		try {
			service.recordAgentWrite({
				file, before: content ?? undefined, session: event.session_id, request: event.tool_use_id, tool: event.tool_name,
			}, hookAgent(event, agent));
		} catch {
			// The file is gone or unreadable; there are no lines to record.
		}
	}
}

export function handleHook(event: Record<string, any>, service: ProoftreeService, options: HookOptions = {}): HookResult {
	const name: string = event.hook_event_name ?? event.hookEventName ?? '';
	const config = service.config();
	const snapshots = options.snapshots ?? new SnapshotStore();
	const writes = WRITE_TOOL.test(event.tool_name ?? '') && service.exists();

	switch (name) {
		case 'SessionStart': {
			const open = service.obligations();
			return additionalContext(name, agentContract(config) + (open.length ? '\n\n' + describeObligations(open, config) : ''));
		}
		case 'PreToolUse': {
			const files = writes ? workspaceFiles(event, service) : [];
			if (files.length) {
				const snapshot: Snapshot = {};
				for (const file of files) {
					const stat = fs.statSync(path.join(service.root, file), { throwIfNoEntry: false });
					if (!stat) {
						snapshot[file] = null;
					} else if (stat.isFile() && stat.size <= MAX_SNAPSHOT_BYTES) {
						snapshot[file] = fs.readFileSync(path.join(service.root, file), 'utf8');
					}
				}
				snapshots.save(snapshotKey(event, service), snapshot);
			}
			return ALLOW;
		}
		case 'PostToolUse': {
			if (writes) {
				recordWrites(event, service, snapshots, options.agent);
			}
			const files = workspaceFiles(event, service);
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
