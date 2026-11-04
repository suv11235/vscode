/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { handleHook } from '../agent/hook';
import { ciSummary, githubAnnotations, runCi } from '../ledger/ci';
import { describeOutline, describeReport } from '../ledger/format';
import { buildGraph, describeGraph, findNode, layoutGraph, neighborhood } from '../ledger/graph';
import { globToRegExp, listInputs } from '../ledger/inputs';
import { locateDeclaration } from '../ledger/lean';
import { Actor } from '../ledger/model';
import { ProoftreeService } from '../ledger/service';

const agent: Actor = { kind: 'agent', name: 'test-agent' };

const CART = [
	'export function subtotal(items) {',
	'\treturn items.reduce((sum, item) => sum + item.price * item.qty, 0);',
	'}',
	'',
	'export function shipping(total) {',
	'\treturn total >= 50 ? 0 : 5;',
	'}',
	'',
	'export function total(items) {',
	'\tconst sub = subtotal(items);',
	'\treturn sub + shipping(sub);',
	'}',
].join('\n');

function workspace(files: Record<string, string> = {}, config: object = {}): ProoftreeService {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prooftree-'));
	const all: Record<string, string> = {
		'cart.js': CART,
		'test/cart.test.js': 'process.exit(0);\n',
		'.prooftree/config.json': JSON.stringify({ checks: { unit: { command: 'node test/cart.test.js', inputs: ['test/**/*.js'] } }, ...config }),
		...files,
	};
	for (const [file, content] of Object.entries(all)) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), content);
	}
	return new ProoftreeService(root);
}

function write(service: ProoftreeService, file: string, content: string): void {
	fs.writeFileSync(path.join(service.root, file), content);
}

test('globs match nested paths', () => {
	assert.ok(globToRegExp('test/**/*.js').test('test/a/b.js'));
	assert.ok(globToRegExp('test/**/*.js').test('test/b.js'));
	assert.ok(!globToRegExp('test/*.js').test('test/a/b.js'));
	const service = workspace({ 'test/unit/more.test.js': '' });
	assert.deepStrictEqual(listInputs(service.root, ['test/**/*.js', 'cart.js', 'missing.js']), ['cart.js', 'test/cart.test.js', 'test/unit/more.test.js']);
});

test('editing a check\'s inputs or command makes its results stale', async () => {
	const service = workspace();
	const id = service.declareClaim({ statement: 'shipping is free from 50', anchors: [{ file: 'cart.js', startLine: 5, endLine: 7 }] }, agent).claim.id;
	assert.strictEqual((await service.runCheck(id, 'unit', agent)).report.status, 'checked');

	write(service, 'test/cart.test.js', '// weakened\nprocess.exit(0);\n');
	assert.strictEqual(service.report(id).status, 'stale');
	assert.strictEqual((await service.runCheck(id, 'unit', agent)).report.status, 'checked');

	write(service, '.prooftree/config.json', JSON.stringify({ checks: { unit: { command: 'node test/cart.test.js --quick', inputs: ['test/**/*.js'] } } }));
	assert.strictEqual(service.report(id).status, 'stale');
});

test('a goal is proved when all its steps are discharged', async () => {
	const service = workspace();
	const [goal, first, second] = service.decompose({
		statement: 'total charges shipping only under 50',
		reasoning: ['total adds shipping to the subtotal', 'shipping is 0 from 50 up', 'so orders of 50 or more pay only the subtotal'],
		steps: [
			{ statement: 'subtotal sums price times quantity', anchors: [{ file: 'cart.js', startLine: 1, endLine: 3 }] },
			{ statement: 'shipping is 0 from 50 up, else 5', anchors: [{ file: 'cart.js', startLine: 5, endLine: 7 }] },
		],
	}, agent);
	assert.deepStrictEqual(goal.steps, [first.claim.id, second.claim.id]);
	assert.strictEqual(service.report(goal.claim.id).status, 'blocked');

	await service.runCheck(first.claim.id, 'unit', agent);
	await service.runCheck(second.claim.id, 'unit', agent);
	assert.strictEqual(service.report(goal.claim.id).status, 'proved');
	assert.deepStrictEqual(service.obligations(), []);

	// Changing a step's code reopens the goal, and the post-edit hook reports both.
	write(service, 'cart.js', CART.replace('total >= 50', 'total > 50'));
	assert.strictEqual(service.report(second.claim.id).status, 'drifted');
	assert.deepStrictEqual(service.report(goal.claim.id).blockedBy, [second.claim.id]);
	const context = JSON.parse(handleHook({ hook_event_name: 'PostToolUse', tool_input: { file_path: 'cart.js' } }, service).stdout!).hookSpecificOutput.additionalContext;
	assert.match(context, new RegExp(goal.claim.id));

	assert.throws(() => service.declareClaim({ statement: 'loops', parent: goal.claim.id, dependsOn: [goal.claim.id] }, agent), /cycle/);
	assert.throws(() => service.updateClaim({ claim: goal.claim.id, dependsOn: [first.claim.id] }, agent), /cycle/);
});

test('reasoning is shown to the requested depth', () => {
	const service = workspace();
	const [goal] = service.decompose({
		statement: 'goal', reasoning: ['summary', 'explanation', 'detail'],
		steps: [{ statement: 'step one', anchors: [{ file: 'cart.js' }] }, { statement: 'step two' }],
	}, agent);
	const config = service.config();
	assert.strictEqual(describeReport(goal, config, 1).match(/why:/g)?.length, 1);
	assert.strictEqual(describeReport(goal, config, 3).match(/why:/g)?.length, 3);
	const outline = describeOutline(service.evaluate(), 2);
	assert.match(outline, /^goal {2}\[blocked/m);
	assert.match(outline, /^ {2}1\. step one/m);
	assert.match(outline, /^ {2}2\. step two/m);
	assert.match(outline, /^ {4}explanation$/m);
});

test('CI reruns stale checks and reports what stays open', async () => {
	const service = workspace();
	const checked = service.declareClaim({ statement: 'subtotal sums lines', anchors: [{ file: 'cart.js', startLine: 1, endLine: 3 }] }, agent).claim.id;
	await service.runCheck(checked, 'unit', agent);
	const unsupported = service.declareClaim({ statement: 'total is subtotal plus shipping', anchors: [{ file: 'cart.js', startLine: 9, endLine: 12 }] }, agent).claim.id;
	write(service, 'test/cart.test.js', '// changed\nprocess.exit(0);\n');

	const without = await runCi(service, { rerun: false });
	assert.strictEqual(without.ok, false);
	assert.deepStrictEqual(without.open.map(report => report.claim.id).sort(), [checked, unsupported].sort());

	const rerun = await runCi(service, { rerun: true });
	assert.deepStrictEqual(rerun.reran.map(run => [run.claim, run.result]), [[checked, 'pass']]);
	assert.deepStrictEqual(rerun.open.map(report => report.claim.id), [unsupported]);
	assert.strictEqual(service.state().evidence.get(checked)!.at(-1)!.by.kind, 'ci');

	const annotations = githubAnnotations(rerun, service);
	assert.deepStrictEqual(annotations.length, 1);
	assert.match(annotations[0], /^::error file=cart\.js,line=9,endLine=12,title=Prooftree c_[0-9a-f]+%3A no evidence::total is subtotal plus shipping%0ANext: run a check \(unit\)$/);
	assert.match(ciSummary(rerun), /## Prooftree: 1 open claim\n/);
	assert.match(ciSummary(rerun), /Re-ran 1 check: `unit` for c_[0-9a-f]+ passed/);
});

test('the knowledge graph links goals, steps, premises, files and checks', async () => {
	const service = workspace();
	const premise = service.declareClaim({ statement: 'subtotal sums lines', anchors: [{ file: 'cart.js', startLine: 1, endLine: 3 }] }, agent).claim.id;
	await service.runCheck(premise, 'unit', agent);
	const [goal, step] = service.decompose({
		statement: 'total is correct',
		steps: [{ statement: 'total adds shipping', anchors: [{ file: 'cart.js', startLine: 9, endLine: 12 }], dependsOn: [premise] }],
	}, agent);
	const graph = buildGraph(service.evaluate());
	assert.deepStrictEqual(
		graph.edges.map(edge => `${edge.kind}:${edge.from}->${edge.to}`).sort(),
		[
			`anchor:${premise}->file:cart.js`,
			`anchor:${step.claim.id}->file:cart.js`,
			`evidence:${premise}->check:unit`,
			`premise:${step.claim.id}->${premise}`,
			`step:${goal.claim.id}->${step.claim.id}`,
		].sort());

	const layout = layoutGraph(graph);
	const layer = (id: string) => layout.nodes.find(node => node.id === id)!.layer;
	assert.ok(layer(goal.claim.id) < layer(step.claim.id));
	assert.ok(layer(step.claim.id) < layer(premise));
	assert.strictEqual(layer('file:cart.js'), Math.max(...layout.nodes.map(node => node.layer)));
	const xs = layout.nodes.filter(node => node.layer === layer('file:cart.js')).map(node => node.x);
	assert.strictEqual(new Set(xs).size, xs.length);

	const around = neighborhood(graph, findNode(graph, 'cart.js')!.id, 1);
	assert.deepStrictEqual(around.nodes.map(node => node.id).sort(), ['file:cart.js', premise, step.claim.id].sort());
	assert.match(describeGraph(graph), new RegExp(`${goal.claim.id} "total is correct" \\[blocked\\] has step ${step.claim.id}`));
});

const LEAN_SPEC = [
	'/-- Free shipping from 50. -/',
	'theorem shipping_free (t : Nat) (h : 50 ≤ t) : (if 50 ≤ t then 0 else 5) = 0 := by',
	'  simp [h]',
	'',
	'@[simp]',
	'theorem shipping_paid (t : Nat) (h : t < 50) : (if 50 ≤ t then 0 else 5) = 5 := by',
	'  sorry',
	'',
	'def unrelated := 1',
].join('\n');

test('Lean declarations are located with their doc comments and attributes', () => {
	assert.deepStrictEqual(locateDeclaration(LEAN_SPEC, 'shipping_free'), { startLine: 1, endLine: 3 });
	assert.deepStrictEqual(locateDeclaration(LEAN_SPEC, 'Cart.shipping_paid'), { startLine: 5, endLine: 7 });
	assert.strictEqual(locateDeclaration(LEAN_SPEC, 'shipping'), undefined);
});

function hasLean(): boolean {
	try {
		execFileSync('lean', ['--version'], { stdio: 'ignore', timeout: 30000 });
		return true;
	} catch {
		return false;
	}
}

test('a Lean check passes a proof and fails sorry', { skip: !hasLean() && 'lean is not installed' }, async () => {
	const service = workspace({ 'Spec.lean': LEAN_SPEC }, { checks: { lean: { kind: 'lean', inputs: [] } } });
	const free = service.declareClaim({ statement: 'shipping is free from 50', anchors: [{ file: 'cart.js', startLine: 5, endLine: 7 }], formal: { file: 'Spec.lean', declaration: 'shipping_free' } }, agent);
	assert.strictEqual(free.anchors.find(anchor => anchor.anchor.role === 'formal')?.startLine, 1);
	const proved = await service.runCheck(free.claim.id, 'lean', agent);
	assert.strictEqual(proved.evidence.result, 'pass', proved.output);
	assert.match(proved.evidence.summary!, /shipping_free proved/);
	assert.strictEqual(proved.report.status, 'checked');
	assert.deepStrictEqual(fs.readdirSync(service.root).filter(file => file.startsWith('.prooftree-')), []);

	const paid = service.declareClaim({ statement: 'shipping is 5 under 50', formal: { file: 'Spec.lean', declaration: 'shipping_paid' } }, agent);
	const unproved = await service.runCheck(paid.claim.id, 'lean', agent);
	assert.strictEqual(unproved.evidence.result, 'fail');
	assert.match(unproved.evidence.summary!, /uses sorry/);

	// Editing the Lean statement drifts the claim like editing code does.
	write(service, 'Spec.lean', LEAN_SPEC.replace('simp [h]', 'simp [h]; done'));
	assert.strictEqual(service.report(free.claim.id).status, 'drifted');
	assert.strictEqual(service.updateClaim({ claim: free.claim.id }, agent).anchors.find(anchor => anchor.anchor.role === 'formal')?.kind, 'intact');

	assert.throws(() => service.declareClaim({ statement: 'x', formal: { file: 'Spec.lean', declaration: 'nope' } }, agent), /No declaration named nope/);
});
