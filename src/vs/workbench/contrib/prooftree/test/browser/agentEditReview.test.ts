/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Emitter } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { mock } from '../../../../../base/test/common/mock.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { IChatService, IChatUserActionEvent } from '../../../chat/common/chatService/chatService.js';
import { AgentEditReviewService, IKeptAgentEdit, RECORD_AGENT_EDIT_COMMAND } from '../../browser/agentEditReview.contribution.js';

suite('AgentEditReviewService', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function setup() {
		const actions = store.add(new Emitter<IChatUserActionEvent>());
		const recorded: IKeptAgentEdit[] = [];
		const chatService = new class extends mock<IChatService>() {
			override readonly onDidPerformUserAction = actions.event;
		};
		const commandService = new class extends mock<ICommandService>() {
			override async executeCommand<R>(id: string, ...args: unknown[]): Promise<R | undefined> {
				if (id === RECORD_AGENT_EDIT_COMMAND) {
					recorded.push(args[0] as IKeptAgentEdit);
				}
				return undefined;
			}
		};
		const service = store.add(new AgentEditReviewService(chatService, commandService, new NullLogService()));
		const uri = URI.file('/workspace/cart.js');
		const keep = (ranges: [number, number][], outcome: 'accepted' | 'rejected' = 'accepted') => actions.fire({
			action: {
				kind: 'chatEditingHunkAction', uri, outcome, hasRemainingEdits: false, lineCount: 1, linesAdded: 1, linesRemoved: 0,
				modifiedLineRanges: ranges.map(([startLineNumber, endLineNumberExclusive]) => ({ startLineNumber, endLineNumberExclusive })),
			},
			agentId: 'test.agent', modelId: 'test-model', command: undefined, sessionResource: URI.parse('chat-session:/1'), requestId: 'request-1', result: undefined,
		});
		return { service, recorded, keep, uri };
	}

	test('records kept hunks as accepted, and as reviewed when kept as reviewed', async () => {
		store.add(CommandsRegistry.registerCommand(RECORD_AGENT_EDIT_COMMAND, () => { }));
		const { service, recorded, keep, uri } = setup();

		keep([[3, 5], [9, 9]]);
		await service.keepAsReviewed(uri, async () => keep([[7, 8]]));
		keep([[12, 13]]);

		assert.deepStrictEqual(recorded.map(edit => [edit.decision, edit.ranges]), [
			['accepted', [{ startLine: 3, endLine: 4 }]],
			['reviewed', [{ startLine: 7, endLine: 7 }]],
			['accepted', [{ startLine: 12, endLine: 12 }]],
		]);
		assert.deepStrictEqual([recorded[0].agent, recorded[0].model, recorded[0].request, recorded[0].uri.toString()], ['test.agent', 'test-model', 'request-1', uri.toString()]);
	});

	test('ignores undone hunks, deletions, and workspaces without Prooftree', () => {
		const { recorded, keep } = setup();
		keep([[3, 5]]);
		assert.deepStrictEqual(recorded, [], 'no extension command registered');

		store.add(CommandsRegistry.registerCommand(RECORD_AGENT_EDIT_COMMAND, () => { }));
		keep([[3, 5]], 'rejected');
		keep([[4, 4]]);
		assert.deepStrictEqual(recorded, []);
	});
});
