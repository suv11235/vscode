/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { describeCheck, parseConfig } from '../ledger/config';
import { hashCheckInputs } from '../ledger/inputs';
import { runLeanCheck } from '../ledger/lean';

// A process fixture exercises the runner boundary independently of an installed Lean toolchain.
async function checkOutput(output: string, exitCode: number, permittedAxioms?: readonly string[]) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prooftree-policy-'));
	try {
		fs.writeFileSync(path.join(root, 'Proof.lean'), 'theorem target : True := by trivial');
		fs.writeFileSync(path.join(root, 'compiler.cjs'), `process.stdout.write(${JSON.stringify(output)}); process.exit(${exitCode});`);
		const result = await runLeanCheck(root, { file: 'Proof.lean', declaration: 'target' }, {
			kind: 'lean', command: 'node compiler.cjs', inputs: [], permittedAxioms,
		}, 5);
		assert.deepStrictEqual(fs.readdirSync(root).filter(file => file.startsWith('.prooftree-')), []);
		return result;
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
}

test('Lean proof text cannot override process failure', async () => {
	const result = await checkOutput("'target' does not depend on any axioms", 7);
	assert.strictEqual(result.result, 'fail');
	assert.match(result.summary, /exited with code 7/);
});

test('Lean dependency policy rejects extra axioms and always rejects sorryAx', async () => {
	assert.strictEqual((await checkOutput("'target' depends on axioms: [propext, Quot.sound]", 0, ['propext', 'Quot.sound'])).result, 'pass');
	assert.strictEqual((await checkOutput("'target' does not depend on any axioms", 0, [])).result, 'pass');
	assert.strictEqual((await checkOutput("'target' depends on axioms: [propext]", 0, [])).result, 'fail');
	const rejected = await checkOutput("'target' depends on axioms: [projectTrust]", 0, ['propext']);
	assert.strictEqual(rejected.result, 'fail');
	assert.match(rejected.summary, /unpermitted axioms: projectTrust/);
	assert.strictEqual((await checkOutput("'target' depends on axioms: [sorryAx]", 0, ['sorryAx'])).result, 'fail');
	assert.strictEqual((await checkOutput('', 0, [])).result, 'fail');
	assert.strictEqual((await checkOutput("'other' does not depend on any axioms", 0, [])).result, 'fail');
});

test('axiom policy is parsed and bound to evidence freshness', () => {
	const config = parseConfig(JSON.stringify({ checks: { proof: { kind: 'lean', permittedAxioms: [] } } }));
	assert.deepStrictEqual(config.checks.proof.permittedAxioms, []);
	assert.match(describeCheck(config.checks.proof), /axioms: none/);
	assert.throws(() => parseConfig('{"checks":{"proof":{"kind":"lean","permittedAxioms":"all"}}}'), /array of names/);
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prooftree-inputs-'));
	try {
		const original = { kind: 'lean' as const, inputs: [] };
		assert.notStrictEqual(hashCheckInputs(root, original, () => undefined), hashCheckInputs(root, { ...original, permittedAxioms: [] }, () => undefined));
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
