/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { test } from 'node:test';
import { editedFiles, handleHook } from '../agent/hook';
import { serveMcp } from '../agent/mcp';
import { AGENT_TOOLS } from '../agent/tools';
import { createAnchor, resolveAnchor } from '../ledger/anchors';
import { Actor } from '../ledger/model';
import { ProoftreeService } from '../ledger/service';

const agent: Actor = { kind: 'agent', name: 'test-agent' };
const person: Actor = { kind: 'human', name: 'Ada' };

const SOURCE = [
	'export function parseMonth(value: string): number {',
	'\tconst month = Number(value);',
	'\tif (month < 1 || month > 12) {',
	'\t\tthrow new Error("bad month");',
	'\t}',
	'\treturn month;',
	'}',
	'',
	'export function parseYear(value: string): number {',
	'\treturn Number(value);',
	'}',
].join('\n');

function workspace(config: object = { checks: { pass: 'node -e "process.exit(0)"', fail: 'node -e "process.exit(3)"' } }): ProoftreeService {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prooftree-'));
	fs.mkdirSync(path.join(root, '.prooftree'));
	fs.writeFileSync(path.join(root, '.prooftree', 'config.json'), JSON.stringify(config));
	fs.writeFileSync(path.join(root, 'date.ts'), SOURCE);
	return new ProoftreeService(root);
}

function edit(service: ProoftreeService, transform: (text: string) => string): void {
	const file = path.join(service.root, 'date.ts');
	fs.writeFileSync(file, transform(fs.readFileSync(file, 'utf8')));
}

test('anchors survive moves and detect changes', () => {
	const anchor = createAnchor('date.ts', SOURCE, 3, 5);
	assert.strictEqual(resolveAnchor(anchor, SOURCE).kind, 'intact');

	const moved = resolveAnchor(anchor, '// header\n// more\n' + SOURCE);
	assert.strictEqual(moved.kind, 'moved');
	assert.deepStrictEqual([moved.startLine, moved.endLine], [5, 7]);

	assert.strictEqual(resolveAnchor(anchor, SOURCE.replace('> 12', '>= 13')).kind, 'changed');
	assert.strictEqual(resolveAnchor(anchor, undefined).kind, 'missing');
	assert.throws(() => createAnchor('date.ts', SOURCE, 10, 40));
});

test('a passing check discharges a claim until its code changes', async () => {
	const service = workspace();
	const claim = service.declareClaim({ statement: 'parseMonth rejects months above 12', anchors: [{ file: 'date.ts', startLine: 3, endLine: 5 }] }, agent);
	assert.strictEqual(claim.status, 'unsupported');

	assert.strictEqual(service.assert(claim.claim.id, 'the guard is right there', agent).status, 'asserted');
	assert.strictEqual((await service.runCheck(claim.claim.id, 'pass', agent)).report.status, 'checked');

	// Unrelated lines above the anchor move it without invalidating the evidence.
	edit(service, text => '// leading comment\n' + text);
	assert.strictEqual(service.report(claim.claim.id).status, 'checked');

	edit(service, text => text.replace('month > 12', 'month > 13'));
	assert.strictEqual(service.report(claim.claim.id).status, 'drifted');

	// A new revision over the current code does not inherit the old check.
	assert.strictEqual(service.updateClaim({ claim: claim.claim.id }, agent).status, 'stale');
	assert.strictEqual((await service.runCheck(claim.claim.id, 'fail', agent)).report.status, 'failed');
	assert.strictEqual((await service.runCheck(claim.claim.id, 'pass', agent)).report.status, 'checked');
	assert.strictEqual(service.state().claims.get(claim.claim.id)?.revision, 2);
});

test('changing a premise invalidates dependent claims', async () => {
	const service = workspace();
	const premise = service.declareClaim({ statement: 'parseMonth returns 1..12', anchors: [{ file: 'date.ts', startLine: 1, endLine: 7 }] }, agent).claim.id;
	const dependent = service.declareClaim({ statement: 'parseYear never sees a month', anchors: [{ file: 'date.ts', startLine: 9, endLine: 11 }], dependsOn: [premise] }, agent).claim.id;
	assert.strictEqual(service.report(dependent).status, 'blocked');

	await service.runCheck(premise, 'pass', agent);
	await service.runCheck(dependent, 'pass', agent);
	assert.strictEqual(service.report(dependent).status, 'checked');

	edit(service, text => text.replace('throw new Error("bad month")', 'return 0'));
	assert.strictEqual(service.report(premise).status, 'drifted');
	assert.deepStrictEqual(service.report(dependent).blockedBy, [premise]);

	service.updateClaim({ claim: premise }, agent);
	await service.runCheck(premise, 'pass', agent);
	// The premise is discharged again, but the dependent's evidence was for the old premise.
	assert.strictEqual(service.report(dependent).status, 'stale');

	assert.throws(() => service.updateClaim({ claim: premise, dependsOn: [dependent] }, agent), /cycle/);
});

test('only people review, and reviews are bound to the code they saw', () => {
	const service = workspace();
	const id = service.declareClaim({ statement: 'parseYear is total', anchors: [{ file: 'date.ts', startLine: 9, endLine: 11 }] }, agent).claim.id;
	assert.throws(() => service.review(id, 'approved', undefined, agent), /Only a person/);
	assert.strictEqual(service.review(id, 'approved', undefined, person).status, 'reviewed');
	edit(service, text => text.replace('return Number(value);', 'return Number.parseInt(value);'));
	assert.strictEqual(service.report(id).status, 'drifted');
	assert.strictEqual(service.updateClaim({ claim: id }, person).status, 'stale');
});

test('obligations cover agent claims by default', () => {
	const service = workspace();
	service.declareClaim({ statement: 'a person noted this', anchors: [{ file: 'date.ts' }] }, person);
	const agentClaim = service.declareClaim({ statement: 'an agent claimed this', anchors: [{ file: 'date.ts' }] }, agent).claim.id;
	assert.deepStrictEqual(service.obligations().map(report => report.claim.id), [agentClaim]);
});

test('the stop hook blocks once, then warns', async () => {
	const service = workspace();
	assert.strictEqual(handleHook({ hook_event_name: 'Stop' }, service).exitCode, 0);

	const id = service.declareClaim({ statement: 'parseMonth rejects 13', anchors: [{ file: 'date.ts', startLine: 3, endLine: 5 }] }, agent).claim.id;
	const blocked = handleHook({ hook_event_name: 'Stop', stop_hook_active: false }, service);
	assert.strictEqual(blocked.exitCode, 2);
	assert.match(blocked.stderr ?? '', new RegExp(id));
	assert.strictEqual(handleHook({ hook_event_name: 'Stop', stop_hook_active: true }, service).exitCode, 1);

	await service.runCheck(id, 'pass', agent);
	assert.strictEqual(handleHook({ hookEventName: 'Stop' }, service).exitCode, 0);
});

test('the post-edit hook reports affected claims', async () => {
	const service = workspace();
	const id = service.declareClaim({ statement: 'parseMonth rejects 13', anchors: [{ file: 'date.ts', startLine: 3, endLine: 5 }] }, agent).claim.id;
	await service.runCheck(id, 'pass', agent);
	edit(service, text => text.replace('> 12', '> 13'));

	const result = handleHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(service.root, 'date.ts') } }, service);
	const output = JSON.parse(result.stdout ?? '{}');
	assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PostToolUse');
	assert.match(output.hookSpecificOutput.additionalContext, new RegExp(`${id} \\[code changed\\]`));

	assert.strictEqual(handleHook({ hook_event_name: 'PostToolUse', tool_input: { file_path: '/elsewhere/x.ts' } }, service).stdout, undefined);
	assert.deepStrictEqual(editedFiles({ input: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n' }), ['src/a.ts', 'src/b.ts']);
});

test('the MCP server lists and calls the agent tools', async () => {
	const service = workspace();
	const input = new PassThrough();
	const output = new PassThrough();
	const responses: any[] = [];
	output.on('data', chunk => chunk.toString().split('\n').filter(Boolean).forEach((line: string) => responses.push(JSON.parse(line))));
	const done = serveMcp(service, input, output);

	const call = (id: number, method: string, params?: object) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
	call(1, 'initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } });
	input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
	call(2, 'tools/list');
	call(3, 'tools/call', { name: 'prooftree_declare_claim', arguments: { statement: 'parseYear is total', anchors: [{ file: 'date.ts', startLine: 9, endLine: 11 }] } });
	call(4, 'tools/call', { name: 'prooftree_run_check', arguments: { claim: 'c_missing', check: 'pass' } });
	call(5, 'nope');
	input.end();
	await done;
	await new Promise(resolve => setImmediate(resolve));

	const byId = new Map(responses.map(response => [response.id, response]));
	assert.match(byId.get(1).result.instructions, /Prooftree/);
	assert.deepStrictEqual(byId.get(2).result.tools.map((tool: any) => tool.name), AGENT_TOOLS.map(tool => tool.name));
	assert.match(byId.get(3).result.content[0].text, /Declared/);
	assert.strictEqual(byId.get(4).result.isError, true);
	assert.strictEqual(byId.get(5).error.code, -32601);
	assert.strictEqual([...service.state().claims.values()][0].by.name, 'claude-code');
});

test('package.json declares the same tools as the MCP server', () => {
	const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
	const declared = manifest.contributes.languageModelTools.map((tool: any) => ({ name: tool.name, description: tool.modelDescription, inputSchema: tool.inputSchema }));
	assert.deepStrictEqual(declared, AGENT_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
});
