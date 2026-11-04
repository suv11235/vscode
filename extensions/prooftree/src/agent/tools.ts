/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describeCheck } from '../ledger/config';
import { describeObligations, describeOutline, describeReport, ReasoningDepth } from '../ledger/format';
import { buildGraph, describeGraph, findNode, neighborhood } from '../ledger/graph';
import { Actor } from '../ledger/model';
import { DecomposeInput, DeclareClaimInput, ProoftreeService, UpdateClaimInput } from '../ledger/service';

/**
 * Tools offered to agents, both as VS Code language model tools and over MCP. Agents can
 * state and revise claims and run the checks people configured; they cannot review or
 * retract. The schemas are repeated in package.json, which a test keeps in sync.
 */
export interface AgentTool {
	readonly name: string;
	readonly displayName: string;
	readonly description: string;
	readonly inputSchema: object;
	readonly readOnly?: boolean;
	run(service: ProoftreeService, input: any, actor: Actor): Promise<string>;
}

const anchorsSchema = {
	type: 'array',
	description: 'Where the claim is made true. Line numbers are 1-based and inclusive; omit them to anchor the whole file. A goal stated only through its steps may omit anchors.',
	items: {
		type: 'object',
		properties: {
			file: { type: 'string', description: 'Workspace-relative or absolute path.' },
			startLine: { type: 'number' },
			endLine: { type: 'number' },
		},
		required: ['file'],
	},
};

const dependsOnSchema = {
	type: 'array',
	items: { type: 'string' },
	description: 'Ids of existing claims this claim relies on (premises). Their changes make this claim\'s evidence stale.',
};

const reasoningSchema = {
	type: 'array',
	items: { type: 'string' },
	maxItems: 3,
	description: 'Why the claim holds, from shortest to most detailed: a one-line summary, then an explanation, then full detail. Readers choose how deep to read.',
};

const formalSchema = {
	type: 'object',
	description: 'A Lean declaration that states this claim formally, checked by a "lean" check. It fails if the proof uses sorry.',
	properties: {
		file: { type: 'string', description: 'Path of the .lean file.' },
		declaration: { type: 'string', description: 'Name of the theorem or lemma.' },
	},
	required: ['file', 'declaration'],
};

const claimProperties = {
	statement: { type: 'string', description: 'A checkable statement, e.g. "parseDate rejects months above 12".' },
	anchors: anchorsSchema,
	dependsOn: dependsOnSchema,
	reasoning: reasoningSchema,
	formal: formalSchema,
};

const depthSchema = { type: 'number', minimum: 1, maximum: 3, description: 'Reasoning depth to show: 1 summary, 2 explanation, 3 full detail.' };

function depthOf(value: unknown): ReasoningDepth {
	return value === 2 || value === 3 ? value : 1;
}

export const AGENT_TOOLS: readonly AgentTool[] = [
	{
		name: 'prooftree_declare_claim',
		displayName: 'Declare Claim',
		description: 'Declare a claim: one specific statement that is now true about the code (behavior, invariant or requirement), anchored to the lines that make it true. Give `parent` to add it as a step of an existing goal. Returns the claim id and status. Then discharge it with prooftree_run_check.',
		inputSchema: {
			type: 'object',
			properties: { ...claimProperties, parent: { type: 'string', description: 'Id of the goal this claim is a step of.' } },
			required: ['statement'],
		},
		async run(service, input: DeclareClaimInput, actor) {
			const report = service.declareClaim(input, actor);
			return 'Declared.\n' + describeReport(report, service.config(), 3);
		},
	},
	{
		name: 'prooftree_decompose',
		displayName: 'Decompose Goal',
		description: 'State a goal and break it into ordered steps in one call, like a proof outline. The goal is proved when every step is discharged; each step is a normal claim with its own anchors and checks. Use this to plan a change before making it.',
		inputSchema: {
			type: 'object',
			properties: {
				...claimProperties,
				steps: {
					type: 'array',
					minItems: 1,
					description: 'The steps, in order. Each is a claim.',
					items: { type: 'object', properties: claimProperties, required: ['statement'] },
				},
			},
			required: ['statement', 'steps'],
		},
		async run(service, input: DecomposeInput, actor) {
			const [goal, ...steps] = service.decompose(input, actor);
			const config = service.config();
			return `Stated goal ${goal.claim.id} with ${steps.length} steps.\n\n` + [goal, ...steps].map(report => describeReport(report, config)).join('\n\n');
		},
	},
	{
		name: 'prooftree_update_claim',
		displayName: 'Update Claim',
		description: 'Write a new revision of a claim after its code changed or its statement, reasoning or Lean link needs correcting. Without anchors, re-anchors to the current text at the existing locations. Earlier evidence does not carry over; run a check afterwards.',
		inputSchema: {
			type: 'object',
			properties: { claim: { type: 'string', description: 'Claim id.' }, ...claimProperties },
			required: ['claim'],
		},
		async run(service, input: UpdateClaimInput, actor) {
			const report = service.updateClaim(input, actor);
			return 'Updated.\n' + describeReport(report, service.config(), 3);
		},
	},
	{
		name: 'prooftree_run_check',
		displayName: 'Run Check',
		description: 'Run one of the workspace\'s configured checks (from .prooftree/config.json) and record the result as evidence for a claim, bound to the current code and the check\'s inputs. A "lean" check compiles the claim\'s Lean declaration. Only a passing check discharges a claim.',
		inputSchema: {
			type: 'object',
			properties: {
				claim: { type: 'string', description: 'Claim id.' },
				check: { type: 'string', description: 'Name of a configured check.' },
			},
			required: ['claim', 'check'],
		},
		async run(service, input: { claim: string; check: string }, actor) {
			const { evidence, output, report } = await service.runCheck(input.claim, input.check, actor);
			return `Check "${input.check}" ${evidence.result === 'pass' ? 'passed' : 'failed'}: ${evidence.summary}.\n${describeReport(report, service.config())}`
				+ (evidence.result === 'fail' ? `\n\nOutput (tail):\n${output}` : '');
		},
	},
	{
		name: 'prooftree_assert',
		displayName: 'Assert Claim',
		description: 'Record your reasoning that a claim holds without a machine check. Shown to reviewers as "asserted only"; it does not discharge the claim unless the workspace accepts assertions.',
		inputSchema: {
			type: 'object',
			properties: {
				claim: { type: 'string', description: 'Claim id.' },
				note: { type: 'string', description: 'Why the claim holds.' },
			},
			required: ['claim', 'note'],
		},
		async run(service, input: { claim: string; note: string }, actor) {
			return describeReport(service.assert(input.claim, input.note, actor), service.config());
		},
	},
	{
		name: 'prooftree_list_obligations',
		displayName: 'List Obligations',
		readOnly: true,
		description: 'List claims that are not yet discharged (stale, failed, changed, blocked or without a check), each with the next step and the configured checks.',
		inputSchema: { type: 'object', properties: {} },
		async run(service) {
			const config = service.config();
			const checks = Object.entries(config.checks).map(([name, check]) => `${name}: ${describeCheck(check)}`);
			return describeObligations(service.obligations(), config)
				+ `\n\nConfigured checks:\n${checks.length ? checks.join('\n') : '(none)'}`;
		},
	},
	{
		name: 'prooftree_status',
		displayName: 'Claim Status',
		readOnly: true,
		description: 'Show every open claim, or one claim, with its reasoning, steps, anchors, premises, Lean link, machine result and human review.',
		inputSchema: {
			type: 'object',
			properties: { claim: { type: 'string', description: 'Optional claim id.' }, depth: depthSchema },
		},
		async run(service, input: { claim?: string; depth?: number }) {
			const config = service.config();
			const reports = service.evaluate();
			const depth = depthOf(input.depth);
			if (input.claim) {
				return describeReport(service.report(input.claim, reports), config, depth);
			}
			return reports.size ? [...reports.values()].map(report => describeReport(report, config, depth)).join('\n\n') : 'No claims yet.';
		},
	},
	{
		name: 'prooftree_outline',
		displayName: 'Proof Outline',
		readOnly: true,
		description: 'Show goals and their numbered steps as an outline with statuses, with reasoning at the chosen depth.',
		inputSchema: { type: 'object', properties: { depth: depthSchema } },
		async run(service, input: { depth?: number }) {
			return describeOutline(service.evaluate(), depthOf(input.depth));
		},
	},
	{
		name: 'prooftree_graph',
		displayName: 'Knowledge Graph',
		readOnly: true,
		description: 'Query the knowledge graph of claims, steps, premises, files, Lean declarations and checks. Give `focus` (a claim id, file path, Lean declaration or check name) to see what is connected to it, for example which claims cover a file you are about to edit.',
		inputSchema: {
			type: 'object',
			properties: {
				focus: { type: 'string', description: 'Claim id, workspace-relative file path, Lean declaration or check name.' },
				radius: { type: 'number', minimum: 1, maximum: 4, description: 'How many edges away to include (default 2).' },
			},
		},
		async run(service, input: { focus?: string; radius?: number }) {
			const graph = buildGraph(service.evaluate());
			if (!input.focus) {
				return describeGraph(graph);
			}
			const focus = findNode(graph, input.focus) ?? findNode(graph, safeRelative(service, input.focus));
			if (!focus) {
				return `Nothing in the graph matches "${input.focus}".`;
			}
			return describeGraph(neighborhood(graph, focus.id, Math.min(Math.max(input.radius ?? 2, 1), 4)));
		},
	},
];

function safeRelative(service: ProoftreeService, file: string): string {
	try {
		return service.relativePath(file);
	} catch {
		return file;
	}
}
