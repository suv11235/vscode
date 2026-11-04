/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describeObligations, describeReport } from '../ledger/format';
import { Actor } from '../ledger/model';
import { AnchorInput, ProoftreeService } from '../ledger/service';

/**
 * Tools offered to agents, both as VS Code language model tools and over MCP. Agents can
 * state and revise claims and run the checks people configured; they cannot review or
 * retract. The schemas are repeated in package.json, which a test keeps in sync.
 */
export interface AgentTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
	run(service: ProoftreeService, input: any, actor: Actor): Promise<string>;
}

const anchorsSchema = {
	type: 'array',
	minItems: 1,
	description: 'Where the claim is made true. Line numbers are 1-based and inclusive; omit them to anchor the whole file.',
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
	description: 'Ids of existing claims this claim relies on. Their changes make this claim\'s evidence stale.',
};

export const AGENT_TOOLS: readonly AgentTool[] = [
	{
		name: 'prooftree_declare_claim',
		description: 'Declare a claim: one specific statement that is now true about the code (behavior, invariant or requirement), anchored to the lines that make it true. Returns the claim id and status. Declare a claim for each behavior you change, then discharge it with prooftree_run_check.',
		inputSchema: {
			type: 'object',
			properties: {
				statement: { type: 'string', description: 'A checkable statement, e.g. "parseDate rejects months above 12".' },
				anchors: anchorsSchema,
				dependsOn: dependsOnSchema,
			},
			required: ['statement', 'anchors'],
		},
		async run(service, input: { statement: string; anchors: AnchorInput[]; dependsOn?: string[] }, actor) {
			const report = service.declareClaim(input, actor);
			return 'Declared.\n' + describeReport(report, service.config());
		},
	},
	{
		name: 'prooftree_update_claim',
		description: 'Write a new revision of a claim after its code changed or its statement needs correcting. Without anchors, re-anchors to the current text at the existing locations. Earlier evidence does not carry over; run a check afterwards.',
		inputSchema: {
			type: 'object',
			properties: {
				claim: { type: 'string', description: 'Claim id.' },
				statement: { type: 'string' },
				anchors: anchorsSchema,
				dependsOn: dependsOnSchema,
			},
			required: ['claim'],
		},
		async run(service, input: { claim: string; statement?: string; anchors?: AnchorInput[]; dependsOn?: string[] }, actor) {
			const report = service.updateClaim(input, actor);
			return 'Updated.\n' + describeReport(report, service.config());
		},
	},
	{
		name: 'prooftree_run_check',
		description: 'Run one of the workspace\'s configured checks (from .prooftree/config.json) and record the result as evidence for a claim, bound to the current code. Only a passing check discharges a claim.',
		inputSchema: {
			type: 'object',
			properties: {
				claim: { type: 'string', description: 'Claim id.' },
				check: { type: 'string', description: 'Name of a configured check.' },
			},
			required: ['claim', 'check'],
		},
		async run(service, input: { claim: string; check: string }, actor) {
			const { run, report } = await service.runCheck(input.claim, input.check, actor);
			return `Check "${input.check}" ${run.result === 'pass' ? 'passed' : 'failed'}.\n${describeReport(report, service.config())}`
				+ (run.result === 'fail' ? `\n\nOutput (tail):\n${run.output}` : '');
		},
	},
	{
		name: 'prooftree_assert',
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
		description: 'List claims that are not yet discharged (stale, failed, changed, blocked or without a check), each with the next step and the configured checks.',
		inputSchema: { type: 'object', properties: {} },
		async run(service) {
			const config = service.config();
			const checks = Object.entries(config.checks).map(([name, command]) => `${name}: ${command}`);
			return describeObligations(service.obligations(), config)
				+ `\n\nConfigured checks:\n${checks.length ? checks.join('\n') : '(none)'}`;
		},
	},
	{
		name: 'prooftree_status',
		description: 'Show every open claim, or one claim, with its anchors, dependencies, machine result and human review.',
		inputSchema: {
			type: 'object',
			properties: { claim: { type: 'string', description: 'Optional claim id.' } },
		},
		async run(service, input: { claim?: string }) {
			const config = service.config();
			const reports = service.evaluate();
			if (input.claim) {
				return describeReport(service.report(input.claim, reports), config);
			}
			return reports.size ? [...reports.values()].map(report => describeReport(report, config)).join('\n\n') : 'No claims yet.';
		},
	},
];
