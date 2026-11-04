/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { handleHook, SnapshotStore } from '../agent/hook';
import { ciSummary, githubAnnotations, runCi } from '../ledger/ci';
import { changedLines, createEditSpan, describeEdit, EditReport, lineHash, locateSpan } from '../ledger/edits';
import { Actor } from '../ledger/model';
import { ProoftreeService } from '../ledger/service';

const person: Actor = { kind: 'human', name: 'Ada' };
const agent: Actor = { kind: 'agent', name: 'test-agent' };

const CART = [
	'export function subtotal(items) {',
	'\treturn items.reduce((sum, item) => sum + item.price * item.qty, 0);',
	'}',
	'',
	'export function shipping(total) {',
	'\tif (total >= 50) return 0;',
	'\treturn 5;',
	'}',
	'',
	'export function total(items) {',
	'\tconst sub = subtotal(items);',
	'\treturn sub + shipping(sub);',
	'}',
].join('\n');

function workspace(gate: object = {}, checks: object = {}): ProoftreeService {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prooftree-edits-'));
	fs.mkdirSync(path.join(root, '.prooftree'));
	fs.writeFileSync(path.join(root, '.prooftree', 'config.json'), JSON.stringify({ gate, checks }));
	fs.writeFileSync(path.join(root, 'cart.js'), CART);
	return new ProoftreeService(root);
}

function edit(service: ProoftreeService, change: (lines: string[]) => void): void {
	const lines = fs.readFileSync(path.join(service.root, 'cart.js'), 'utf8').split('\n');
	change(lines);
	fs.writeFileSync(path.join(service.root, 'cart.js'), lines.join('\n'));
}

function summarize(edits: readonly EditReport[]): string[] {
	return edits.map(report => `${report.startLine}-${report.endLine} ${report.status}`);
}

test('kept agent lines stay unverified until a person reviews them', () => {
	const service = workspace();
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 5, endLine: 8 }], decision: 'accepted', model: 'gpt-test' }, person);
	assert.deepStrictEqual(summarize(service.edits()), ['5-8 unverified']);
	assert.strictEqual(service.edits()[0].source.model, 'gpt-test');

	const reviews = service.reviewEdits('cart.js', undefined, person);
	assert.strictEqual(reviews.length, 1);
	assert.strictEqual(reviews[0].reviewOf, service.edits()[0].source.id);
	assert.deepStrictEqual(summarize(service.edits()), ['5-8 reviewed']);
	// Who kept the lines is unchanged by the review.
	assert.strictEqual(service.edits()[0].source.decision, 'accepted');
	assert.strictEqual(service.edits()[0].review?.by.name, 'Ada');
});

test('keep as reviewed records both at once', () => {
	const service = workspace();
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 10, endLine: 13 }], decision: 'reviewed' }, person);
	assert.deepStrictEqual(summarize(service.edits()), ['10-13 reviewed']);
	assert.deepStrictEqual(service.reviewEdits('cart.js', undefined, person), []);
});

test('reviewing a selection covers only those lines', () => {
	const service = workspace();
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 5, endLine: 8 }], decision: 'accepted' }, person);
	service.reviewEdits('cart.js', { startLine: 6, endLine: 7 }, person);
	assert.deepStrictEqual(summarize(service.edits()), ['5-5 unverified', '6-7 reviewed', '8-8 unverified']);
});

test('kept lines follow code that moves', () => {
	const service = workspace();
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 5, endLine: 8 }], decision: 'accepted' }, person);
	edit(service, lines => lines.unshift('// header', '// more'));
	assert.deepStrictEqual(summarize(service.edits()), ['7-10 unverified']);
});

test('changing part of a kept edit leaves the rest tracked', () => {
	const service = workspace();
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 5, endLine: 8 }], decision: 'accepted' }, person);
	edit(service, lines => {
		lines[5] = '\tif (total >= 75) return 0;';
		lines.unshift('// header');
	});
	// The changed line is someone else's now; the closing brace still sits next to a kept line.
	assert.deepStrictEqual(summarize(service.edits()), ['6-6 unverified', '8-9 unverified']);
});

test('a review does not carry over to lines changed after it', () => {
	const service = workspace();
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 5, endLine: 8 }], decision: 'reviewed' }, person);
	edit(service, lines => lines[6] = '\treturn 7;');
	// The agent's new line comes back through Keep as a new record, unverified.
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 7, endLine: 7 }], decision: 'accepted' }, person);
	assert.deepStrictEqual(summarize(service.edits()), ['5-6 reviewed', '7-7 unverified', '8-8 reviewed']);
});

test('lone braces do not match elsewhere', () => {
	const lines = CART.split('\n');
	const span = createEditSpan('cart.js', CART, 3, 3);
	const moved = ['// a', ...lines.slice(0, 2), '\treturn 0;', ...lines.slice(3)];
	assert.deepStrictEqual(locateSpan(span, moved, moved.map(lineHash)), []);
});

test('long kept edits are followed in chunks', () => {
	const service = workspace();
	const body = Array.from({ length: 150 }, (_, index) => `const value${index} = ${index};`);
	fs.writeFileSync(path.join(service.root, 'cart.js'), body.join('\n'));
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 1, endLine: 150 }], decision: 'accepted' }, person);
	edit(service, lines => lines[99] = 'const changed = true;');
	assert.deepStrictEqual(summarize(service.edits()), ['1-99 unverified', '101-150 unverified']);
});

test('only people keep or review agent edits', () => {
	const service = workspace();
	assert.throws(() => service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 1, endLine: 3 }], decision: 'reviewed' }, agent), /Only a person/);
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 1, endLine: 3 }], decision: 'accepted' }, person);
	assert.throws(() => service.reviewEdits('cart.js', undefined, agent), /Only a person/);
});

test('ci warns about unverified agent code by default and can block on it', async () => {
	const warn = workspace();
	warn.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 10, endLine: 13 }], decision: 'accepted', model: 'gpt-test' }, person);
	const warned = await runCi(warn, { rerun: false });
	assert.strictEqual(warned.ok, true);
	assert.deepStrictEqual(githubAnnotations(warned, warn).map(line => line.split('::')[1].split(' ')[0]), ['warning']);
	assert.match(githubAnnotations(warned, warn)[0], /file=cart\.js,line=10,endLine=13/);
	assert.match(ciSummary(warned), /1 agent edit without evidence/);
	assert.match(ciSummary(warned), /\| cart\.js:10-13 \| gpt-test \| kept by Ada, /);

	const block = workspace({ unverifiedAgentCode: 'block' });
	block.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 10, endLine: 13 }], decision: 'accepted' }, person);
	const blocked = await runCi(block, { rerun: false });
	assert.strictEqual(blocked.ok, false);
	assert.match(githubAnnotations(blocked, block)[0], /^::error /);
	block.reviewEdits('cart.js', undefined, person);
	assert.strictEqual((await runCi(block, { rerun: false })).ok, true);

	const allow = workspace({ unverifiedAgentCode: 'allow' });
	allow.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 10, endLine: 13 }], decision: 'accepted' }, person);
	assert.deepStrictEqual(githubAnnotations(await runCi(allow, { rerun: false }), allow), []);
});

function snapshotStore(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prooftree-snapshots-'))): SnapshotStore {
	return new SnapshotStore(dir);
}

test('changed lines are what a diff adds, without runs of blank lines', () => {
	const lines = CART.split('\n');
	const insert = (at: number, ...added: string[]) => [...lines.slice(0, at), ...added, ...lines.slice(at)].join('\n');
	assert.deepStrictEqual(changedLines(CART, insert(6, '\tif (total >= 25) return 2;')), [{ startLine: 7, endLine: 7 }]);
	assert.deepStrictEqual(changedLines(CART, insert(3, '')), []);
	assert.deepStrictEqual(changedLines(CART, insert(3, '// note', '', '// more')), [{ startLine: 4, endLine: 6 }]);
	assert.deepStrictEqual(changedLines('', 'a\nb\n'), [{ startLine: 1, endLine: 2 }]);
	assert.deepStrictEqual(changedLines(CART, CART.replace('item.qty', 'item.quantity')), [{ startLine: 2, endLine: 2 }]);
});

test('agent hooks record the lines an agent writes from a terminal', async () => {
	const service = workspace();
	const snapshots = snapshotStore();
	const call = { session_id: 's1', tool_use_id: 't1', tool_name: 'Edit', permission_mode: 'default', tool_input: { file_path: path.join(service.root, 'cart.js') } };
	assert.strictEqual(handleHook({ ...call, hook_event_name: 'PreToolUse' }, service, { snapshots }).exitCode, 0);
	edit(service, lines => lines.splice(6, 0, '\tif (total >= 25) return 2;'));
	handleHook({ ...call, hook_event_name: 'PostToolUse' }, service, { snapshots });

	const [written] = service.edits();
	assert.deepStrictEqual(summarize(service.edits()), ['7-7 unverified']);
	assert.strictEqual(written.source.decision, 'written');
	assert.deepStrictEqual([written.source.by.name, written.source.tool, written.source.session], ['Claude Code', 'Edit', 's1']);
	assert.match(describeEdit(written), /^cart\.js line 7: written by Claude Code \(Edit\) on \d{4}-\d\d-\d\d; no review and no passing check$/);
	assert.match(ciSummary(await runCi(service, { rerun: false })), /\| cart\.js:7 \| Claude Code \| written with Edit, /);

	// A person can review what an agent wrote outside the editor, too.
	service.reviewEdits('cart.js', undefined, person);
	assert.deepStrictEqual(summarize(service.edits()), ['7-7 reviewed']);
});

test('without a snapshot, the file Claude Code reports from before the edit is used', () => {
	const service = workspace();
	const file = path.join(service.root, 'cart.js');
	edit(service, lines => lines.push('export const FREE_SHIPPING = 50;'));
	handleHook({
		hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: file },
		tool_response: { filePath: file, originalFile: CART },
	}, service, { snapshots: snapshotStore(), agent: 'codex' });
	assert.deepStrictEqual(summarize(service.edits()), ['14-14 unverified']);
	assert.strictEqual(service.edits()[0].source.by.name, 'codex');
});

test('VS Code agents are recognized, and new files count in full', () => {
	const service = workspace();
	const snapshots = snapshotStore();
	const call = { timestamp: new Date().toISOString(), tool_use_id: 't3', tool_name: 'create_file', tool_input: { filePath: path.join(service.root, 'fees.js') } };
	handleHook({ ...call, hook_event_name: 'PreToolUse' }, service, { snapshots });
	fs.writeFileSync(path.join(service.root, 'fees.js'), 'export const FEE = 2;\n\nexport function fee() {\n\treturn FEE;\n}\n');
	handleHook({ ...call, hook_event_name: 'PostToolUse' }, service, { snapshots });
	assert.deepStrictEqual(summarize(service.edits()), ['1-5 unverified']);
	assert.strictEqual(service.edits()[0].source.by.name, 'VS Code agent');
});

test('reads, and workspaces without Prooftree, are not recorded', () => {
	const service = workspace();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prooftree-snapshots-'));
	const snapshots = snapshotStore(dir);
	const read = { tool_use_id: 't4', tool_name: 'Read', tool_input: { file_path: path.join(service.root, 'cart.js') } };
	handleHook({ ...read, hook_event_name: 'PreToolUse' }, service, { snapshots });
	assert.deepStrictEqual(fs.readdirSync(dir), []);
	handleHook({ ...read, hook_event_name: 'PostToolUse' }, service, { snapshots });
	assert.deepStrictEqual(service.edits(), []);

	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prooftree-none-'));
	fs.writeFileSync(path.join(root, 'cart.js'), CART);
	const plain = new ProoftreeService(root);
	const call = { tool_use_id: 't5', tool_name: 'Write', tool_input: { file_path: path.join(root, 'cart.js') } };
	handleHook({ ...call, hook_event_name: 'PreToolUse' }, plain, { snapshots });
	fs.writeFileSync(path.join(root, 'cart.js'), CART + '\n// more');
	handleHook({ ...call, hook_event_name: 'PostToolUse' }, plain, { snapshots });
	assert.strictEqual(fs.existsSync(path.join(root, '.prooftree')), false);

	assert.throws(() => service.recordAgentWrite({ file: 'cart.js', before: '' }, person), /Only agents/);
});

test('a checked or approved claim covers the agent lines in its code until they change', async () => {
	const service = workspace({}, { pass: 'true' });
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 5, endLine: 8 }], decision: 'accepted' }, person);
	const { claim } = service.declareClaim({ statement: 'Orders of 50 or more ship free', anchors: [{ file: 'cart.js', startLine: 6, endLine: 7 }] }, agent);
	service.assert(claim.id, 'I read it', agent);
	// An agent's assertion is not evidence.
	assert.deepStrictEqual(summarize(service.edits()), ['5-8 unverified']);

	await service.runCheck(claim.id, 'pass', agent);
	assert.deepStrictEqual(summarize(service.edits()), ['5-5 unverified', '6-7 covered', '8-8 unverified']);
	assert.deepStrictEqual(service.edits()[1].claims, [claim.id]);
	assert.match(describeEdit(service.edits()[1]), new RegExp(`; covered by ${claim.id}$`));

	// Changing the code drifts the claim, so its check no longer covers anything.
	edit(service, lines => lines[6] = '\treturn 7;');
	assert.deepStrictEqual(summarize(service.edits()), ['5-6 unverified', '8-8 unverified']);

	const approved = service.declareClaim({ statement: 'The shipping function is unchanged', anchors: [{ file: 'cart.js', startLine: 5, endLine: 8 }] }, agent);
	service.review(approved.claim.id, 'approved', undefined, person);
	assert.deepStrictEqual(summarize(service.edits()), ['5-6 covered', '8-8 covered']);
});
