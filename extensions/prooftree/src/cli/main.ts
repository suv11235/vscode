/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { handleHook } from '../agent/hook';
import { serveMcp } from '../agent/mcp';
import { localHuman } from '../ledger/actor';
import { describeObligations, describeReport } from '../ledger/format';
import { Actor } from '../ledger/model';
import { AnchorInput, findWorkspaceRoot, ProoftreeService } from '../ledger/service';

const USAGE = [
	'Usage: prooftree <command>',
	'',
	'  hook                                read an agent hook event (JSON) from stdin',
	'  mcp                                 serve the agent tools over MCP on stdio',
	'  status [claim]                      show claims',
	'  obligations                         show claims that are not discharged',
	'  claim <statement> --at <file[:start[-end]]>... [--dep <claim>]...',
	'  check <claim> <check>               run a configured check for a claim',
	'  review <claim> approve|reject [note]',
	'',
	'Options: --root <dir> (default: nearest folder with .prooftree or .git), --agent <name> (act as an agent)',
].join('\n');

function parseAt(value: string): AnchorInput {
	const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(value)!;
	return {
		file: match[1],
		startLine: match[2] ? Number(match[2]) : undefined,
		endLine: match[3] ? Number(match[3]) : match[2] ? Number(match[2]) : undefined,
	};
}

function readStdin(): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = '';
		process.stdin.setEncoding('utf8');
		process.stdin.on('data', chunk => data += chunk);
		process.stdin.on('end', () => resolve(data));
		process.stdin.on('error', reject);
	});
}

async function main(argv: string[]): Promise<number> {
	const positional: string[] = [];
	const options: Record<string, string[]> = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) {
			(options[argv[i].slice(2)] ??= []).push(argv[++i] ?? '');
		} else {
			positional.push(argv[i]);
		}
	}
	const [command, ...args] = positional;

	if (command === 'hook') {
		const event = JSON.parse((await readStdin()) || '{}');
		const service = new ProoftreeService(findWorkspaceRoot(options.root?.[0] ?? event.cwd ?? process.cwd()));
		const result = handleHook(event, service);
		if (result.stdout) {
			process.stdout.write(result.stdout + '\n');
		}
		if (result.stderr) {
			process.stderr.write(result.stderr + '\n');
		}
		return result.exitCode;
	}

	const service = new ProoftreeService(findWorkspaceRoot(options.root?.[0] ?? process.cwd()));
	const actor: Actor = options.agent ? { kind: 'agent', name: options.agent[0] } : localHuman(service.root);
	const config = service.config();

	switch (command) {
		case 'mcp':
			await serveMcp(service, process.stdin, process.stdout);
			return 0;
		case 'status': {
			const reports = service.evaluate();
			const selected = args[0] ? [service.report(args[0], reports)] : [...reports.values()];
			console.log(selected.length ? selected.map(report => describeReport(report, config)).join('\n\n') : 'No claims yet.');
			return 0;
		}
		case 'obligations': {
			const open = service.obligations();
			console.log(describeObligations(open, config));
			return open.length ? 1 : 0;
		}
		case 'claim': {
			const report = service.declareClaim({ statement: args.join(' '), anchors: (options.at ?? []).map(parseAt), dependsOn: options.dep }, actor);
			console.log(describeReport(report, config));
			return 0;
		}
		case 'check': {
			const { run, report } = await service.runCheck(args[0], args[1], actor);
			console.log(describeReport(report, config));
			if (run.result === 'fail') {
				console.log('\n' + run.output);
			}
			return run.result === 'pass' ? 0 : 1;
		}
		case 'review': {
			if (args[1] !== 'approve' && args[1] !== 'reject') {
				break;
			}
			const report = service.review(args[0], args[1] === 'approve' ? 'approved' : 'rejected', args.slice(2).join(' ') || undefined, actor);
			console.log(describeReport(report, config));
			return 0;
		}
	}
	console.error(USAGE);
	return 64;
}

main(process.argv.slice(2)).then(code => process.exitCode = code, error => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
