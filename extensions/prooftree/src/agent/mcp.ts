/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as readline from 'readline';
import { agentContract } from '../ledger/format';
import { Actor } from '../ledger/model';
import { ProoftreeService } from '../ledger/service';
import { AGENT_TOOLS } from './tools';

/**
 * Minimal MCP server over stdio (newline-delimited JSON-RPC) exposing {@link AGENT_TOOLS},
 * so terminal agents such as Claude Code share the workspace ledger with the IDE.
 */

interface Request {
	readonly jsonrpc: '2.0';
	readonly id?: number | string;
	readonly method: string;
	readonly params?: any;
}

export function serveMcp(service: ProoftreeService, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
	let actor: Actor = { kind: 'agent', name: 'mcp-client' };
	const send = (message: object) => output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

	const handle = async (request: Request): Promise<object | undefined> => {
		switch (request.method) {
			case 'initialize': {
				const client = request.params?.clientInfo?.name;
				if (typeof client === 'string' && client) {
					actor = { kind: 'agent', name: client };
				}
				return {
					protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
					capabilities: { tools: {} },
					serverInfo: { name: 'prooftree', version: '0.1.0' },
					instructions: agentContract(service.config()),
				};
			}
			case 'ping':
				return {};
			case 'tools/list':
				return { tools: AGENT_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
			case 'tools/call': {
				const tool = AGENT_TOOLS.find(candidate => candidate.name === request.params?.name);
				if (!tool) {
					throw Object.assign(new Error(`Unknown tool ${request.params?.name}`), { code: -32602 });
				}
				try {
					const text = await tool.run(service, request.params?.arguments ?? {}, actor);
					return { content: [{ type: 'text', text }] };
				} catch (error) {
					return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
				}
			}
			default:
				throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
		}
	};

	return new Promise(resolve => {
		const lines = readline.createInterface({ input });
		lines.on('line', async line => {
			if (!line.trim()) {
				return;
			}
			let request: Request;
			try {
				request = JSON.parse(line);
			} catch {
				send({ id: null, error: { code: -32700, message: 'Parse error' } });
				return;
			}
			// Notifications have no id and get no response.
			if (request.id === undefined) {
				return;
			}
			try {
				send({ id: request.id, result: await handle(request) });
			} catch (error: any) {
				send({ id: request.id, error: { code: error?.code ?? -32603, message: error?.message ?? String(error) } });
			}
		});
		lines.on('close', () => resolve());
	});
}
