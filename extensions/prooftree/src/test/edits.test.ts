/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { ciSummary, githubAnnotations, runCi } from '../ledger/ci';
import { createEditSpan, EditReport, lineHash, locateSpan } from '../ledger/edits';
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

function workspace(gate: object = {}): ProoftreeService {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prooftree-edits-'));
	fs.mkdirSync(path.join(root, '.prooftree'));
	fs.writeFileSync(path.join(root, '.prooftree', 'config.json'), JSON.stringify({ gate }));
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

test('kept agent lines stay unreviewed until a person reviews them', () => {
	const service = workspace();
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 5, endLine: 8 }], decision: 'accepted', model: 'gpt-test' }, person);
	assert.deepStrictEqual(summarize(service.edits()), ['5-8 unreviewed']);
	assert.strictEqual(service.edits()[0].kept.model, 'gpt-test');

	const reviews = service.reviewEdits('cart.js', undefined, person);
	assert.strictEqual(reviews.length, 1);
	assert.strictEqual(reviews[0].reviewOf, service.edits()[0].kept.id);
	assert.deepStrictEqual(summarize(service.edits()), ['5-8 reviewed']);
	// Who kept the lines is unchanged by the review.
	assert.strictEqual(service.edits()[0].kept.decision, 'accepted');
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
	assert.deepStrictEqual(summarize(service.edits()), ['5-5 unreviewed', '6-7 reviewed', '8-8 unreviewed']);
});

test('kept lines follow code that moves', () => {
	const service = workspace();
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 5, endLine: 8 }], decision: 'accepted' }, person);
	edit(service, lines => lines.unshift('// header', '// more'));
	assert.deepStrictEqual(summarize(service.edits()), ['7-10 unreviewed']);
});

test('changing part of a kept edit leaves the rest tracked', () => {
	const service = workspace();
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 5, endLine: 8 }], decision: 'accepted' }, person);
	edit(service, lines => {
		lines[5] = '\tif (total >= 75) return 0;';
		lines.unshift('// header');
	});
	// The changed line is someone else's now; the closing brace still sits next to a kept line.
	assert.deepStrictEqual(summarize(service.edits()), ['6-6 unreviewed', '8-9 unreviewed']);
});

test('a review does not carry over to lines changed after it', () => {
	const service = workspace();
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 5, endLine: 8 }], decision: 'reviewed' }, person);
	edit(service, lines => lines[6] = '\treturn 7;');
	// The agent's new line comes back through Keep as a new record, unreviewed.
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 7, endLine: 7 }], decision: 'accepted' }, person);
	assert.deepStrictEqual(summarize(service.edits()), ['5-6 reviewed', '7-7 unreviewed', '8-8 reviewed']);
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
	assert.deepStrictEqual(summarize(service.edits()), ['1-99 unreviewed', '101-150 unreviewed']);
});

test('only people keep or review agent edits', () => {
	const service = workspace();
	assert.throws(() => service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 1, endLine: 3 }], decision: 'reviewed' }, agent), /Only a person/);
	service.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 1, endLine: 3 }], decision: 'accepted' }, person);
	assert.throws(() => service.reviewEdits('cart.js', undefined, agent), /Only a person/);
});

test('ci warns about unreviewed agent edits by default and can block on them', async () => {
	const warn = workspace();
	warn.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 10, endLine: 13 }], decision: 'accepted', model: 'gpt-test' }, person);
	const warned = await runCi(warn, { rerun: false });
	assert.strictEqual(warned.ok, true);
	assert.deepStrictEqual(githubAnnotations(warned, warn).map(line => line.split('::')[1].split(' ')[0]), ['warning']);
	assert.match(githubAnnotations(warned, warn)[0], /file=cart\.js,line=10,endLine=13/);
	assert.match(ciSummary(warned), /1 agent edit kept without review/);
	assert.match(ciSummary(warned), /\| cart\.js:10-13 \| gpt-test \| Ada, /);

	const block = workspace({ unreviewedEdits: 'block' });
	block.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 10, endLine: 13 }], decision: 'accepted' }, person);
	const blocked = await runCi(block, { rerun: false });
	assert.strictEqual(blocked.ok, false);
	assert.match(githubAnnotations(blocked, block)[0], /^::error /);
	block.reviewEdits('cart.js', undefined, person);
	assert.strictEqual((await runCi(block, { rerun: false })).ok, true);

	const allow = workspace({ unreviewedEdits: 'allow' });
	allow.recordKeptEdit({ file: 'cart.js', ranges: [{ startLine: 10, endLine: 13 }], decision: 'accepted' }, person);
	assert.deepStrictEqual(githubAnnotations(await runCi(allow, { rerun: false }), allow), []);
});
