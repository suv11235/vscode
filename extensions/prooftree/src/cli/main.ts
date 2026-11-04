/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import { handleHook } from '../agent/hook';
import { serveMcp } from '../agent/mcp';
import { localHuman } from '../ledger/actor';
import { ciSummary, githubAnnotations, runCi } from '../ledger/ci';
import { describeEdit } from '../ledger/edits';
import { describeObligations, describeOutline, describeReport, ReasoningDepth } from '../ledger/format';
import { buildGraph, describeGraph, findNode, neighborhood } from '../ledger/graph';
import { Actor, FormalLink } from '../ledger/model';
import { AnchorInput, findWorkspaceRoot, ProoftreeService } from '../ledger/service';

const USAGE = [
	'Usage: prooftree <command>',
	'',
	'  hook                                read an agent hook event (JSON) from stdin',
	'  mcp                                 serve the agent tools over MCP on stdio',
	'  status [claim] [--depth 1|2|3]      show claims',
	'  outline [--depth 1|2|3]             show goals and their numbered steps',
	'  obligations                         show claims that are not discharged',
	'  graph [focus] [--radius n]          show the knowledge graph, or what is connected to focus',
	'  claim <statement> [--at <file[:start[-end]]>]... [--dep <claim>]... [--parent <goal>]',
	'        [--why <reasoning>]... [--formal <file.lean#declaration>]',
	'  check <claim> <check>               run a configured check for a claim',
	'  review <claim> approve|reject [note]',
	'  edits [--all]                       show agent-written lines people kept without review',
	'  review-edits <file[:start[-end]]>   record that you reviewed the kept agent lines there',
	'  ci [--rerun] [--scope all|agent]    fail when claims are open; annotate them on GitHub',
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

function parseFormal(value: string | undefined): FormalLink | undefined {
	if (!value) {
		return undefined;
	}
	const [file, declaration] = value.split('#');
	if (!file || !declaration) {
		throw new Error('--formal takes <file.lean#declaration>.');
	}
	return { file, declaration };
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
	const flags = new Set(['rerun', 'all']);
	for (let i = 0; i < argv.length; i++) {
		if (argv[i].startsWith('--')) {
			const name = argv[i].slice(2);
			(options[name] ??= []).push(flags.has(name) ? 'true' : argv[++i] ?? '');
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
	const depth = Number(options.depth?.[0] ?? 1) as ReasoningDepth;

	switch (command) {
		case 'mcp':
			await serveMcp(service, process.stdin, process.stdout);
			return 0;
		case 'status': {
			const reports = service.evaluate();
			const selected = args[0] ? [service.report(args[0], reports)] : [...reports.values()];
			console.log(selected.length ? selected.map(report => describeReport(report, config, depth)).join('\n\n') : 'No claims yet.');
			return 0;
		}
		case 'outline':
			console.log(describeOutline(service.evaluate(), depth));
			return 0;
		case 'obligations': {
			const open = service.obligations();
			console.log(describeObligations(open, config));
			return open.length ? 1 : 0;
		}
		case 'graph': {
			const graph = buildGraph(service.evaluate());
			const focus = args[0] ? findNode(graph, args[0]) : undefined;
			if (args[0] && !focus) {
				console.error(`Nothing in the graph matches "${args[0]}".`);
				return 1;
			}
			console.log(describeGraph(focus ? neighborhood(graph, focus.id, Number(options.radius?.[0] ?? 2)) : graph));
			return 0;
		}
		case 'claim': {
			const report = service.declareClaim({
				statement: args.join(' '),
				anchors: (options.at ?? []).map(parseAt),
				dependsOn: options.dep,
				parent: options.parent?.[0],
				reasoning: options.why,
				formal: parseFormal(options.formal?.[0]),
			}, actor);
			console.log(describeReport(report, config, 3));
			return 0;
		}
		case 'check': {
			const { evidence, output, report } = await service.runCheck(args[0], args[1], actor);
			console.log(describeReport(report, config));
			if (evidence.result === 'fail') {
				console.log('\n' + output);
			}
			return evidence.result === 'pass' ? 0 : 1;
		}
		case 'review': {
			if (args[1] !== 'approve' && args[1] !== 'reject') {
				break;
			}
			const report = service.review(args[0], args[1] === 'approve' ? 'approved' : 'rejected', args.slice(2).join(' ') || undefined, actor);
			console.log(describeReport(report, config));
			return 0;
		}
		case 'edits': {
			const edits = service.edits().filter(edit => options.all || edit.status === 'unreviewed');
			console.log(edits.length ? edits.map(describeEdit).join('\n') : options.all ? 'No kept agent edits.' : 'Every kept agent edit has been reviewed.');
			return 0;
		}
		case 'review-edits': {
			if (!args[0]) {
				break;
			}
			const at = parseAt(args[0]);
			const lines = at.startLine !== undefined ? { startLine: at.startLine, endLine: at.endLine ?? at.startLine } : undefined;
			const reviews = service.reviewEdits(at.file, lines, actor);
			const count = reviews.reduce((sum, review) => sum + review.spans.reduce((lineCount, span) => lineCount + span.endLine - span.startLine + 1, 0), 0);
			console.log(count ? `Recorded your review of ${count} kept agent line${count === 1 ? '' : 's'} in ${at.file}.` : `No unreviewed kept agent lines in ${args[0]}.`);
			return 0;
		}
		case 'ci': {
			const scope = options.scope?.[0] === 'agent' ? 'agent' : 'all';
			const result = await runCi(service, { rerun: !!options.rerun, scope });
			const summary = ciSummary(result);
			console.log(summary);
			if (process.env.GITHUB_ACTIONS) {
				githubAnnotations(result, service).forEach(line => console.log(line));
			}
			if (process.env.GITHUB_STEP_SUMMARY) {
				fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
			}
			return result.ok ? 0 : 1;
		}
	}
	console.error(USAGE);
	return 64;
}

main(process.argv.slice(2)).then(code => process.exitCode = code, error => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
