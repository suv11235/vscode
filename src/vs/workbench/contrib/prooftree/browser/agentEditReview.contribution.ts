/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Prooftree. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { ContextKeyExpr, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { AcceptAction, AcceptHunkAction } from '../../chat/browser/chatEditing/chatEditingEditorActions.js';
import { ctxHasEditorModification, ctxHasRequestInProgress, ctxIsCurrentlyBeingModified, ctxIsGlobalEditingSession } from '../../chat/browser/chatEditing/chatEditingEditorContextKeys.js';
import { IChatService, IChatUserActionEvent } from '../../chat/common/chatService/chatService.js';

/**
 * Keeping an agent's edit and reviewing it are different acts. Every hunk a person keeps is
 * reported to the Prooftree extension as accepted; the Keep as Reviewed actions report it as
 * reviewed. The extension records both in the workspace ledger with hashes of the kept lines.
 */

/** Set by the Prooftree extension when the workspace has a ledger. */
const ctxProoftreeEnabled = new RawContextKey<boolean>('prooftree.enabled', false);

/** Extension command that records kept agent edits. */
export const RECORD_AGENT_EDIT_COMMAND = '_prooftree.recordAgentEdit';

export interface IKeptAgentEdit {
	/** A URI rather than a string, so it is translated for a remote extension host. */
	readonly uri: URI;
	/** Lines of the file as kept, 1-based and inclusive. */
	readonly ranges: readonly { readonly startLine: number; readonly endLine: number }[];
	readonly decision: 'accepted' | 'reviewed';
	readonly agent?: string;
	readonly model?: string;
	readonly session: string;
	readonly request: string;
}

export const IAgentEditReviewService = createDecorator<IAgentEditReviewService>('prooftreeAgentEditReviewService');

export interface IAgentEditReviewService {
	readonly _serviceBrand: undefined;
	/** Runs a keep action and records the edits it keeps in `uri` as reviewed. */
	keepAsReviewed(uri: URI, keep: () => Promise<unknown>): Promise<void>;
}

export class AgentEditReviewService extends Disposable implements IAgentEditReviewService {

	declare readonly _serviceBrand: undefined;

	private readonly _reviewing = new ResourceMap<number>();

	constructor(
		@IChatService chatService: IChatService,
		@ICommandService private readonly _commandService: ICommandService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._register(chatService.onDidPerformUserAction(event => this._onUserAction(event)));
	}

	async keepAsReviewed(uri: URI, keep: () => Promise<unknown>): Promise<void> {
		this._reviewing.set(uri, (this._reviewing.get(uri) ?? 0) + 1);
		try {
			await keep();
		} finally {
			const count = (this._reviewing.get(uri) ?? 1) - 1;
			if (count > 0) {
				this._reviewing.set(uri, count);
			} else {
				this._reviewing.delete(uri);
			}
		}
	}

	private _onUserAction(event: IChatUserActionEvent): void {
		const action = event.action;
		if (action.kind !== 'chatEditingHunkAction' || action.outcome !== 'accepted' || !CommandsRegistry.getCommand(RECORD_AGENT_EDIT_COMMAND)) {
			return;
		}
		// A hunk that only deletes lines leaves nothing in the file to anchor to.
		const ranges = (action.modifiedLineRanges ?? [])
			.filter(range => range.endLineNumberExclusive > range.startLineNumber)
			.map(range => ({ startLine: range.startLineNumber, endLine: range.endLineNumberExclusive - 1 }));
		if (!ranges.length) {
			return;
		}
		const edit: IKeptAgentEdit = {
			uri: action.uri,
			ranges,
			decision: this._reviewing.has(action.uri) ? 'reviewed' : 'accepted',
			agent: event.agentId,
			model: event.modelId,
			session: event.sessionResource.toString(),
			request: event.requestId,
		};
		this._commandService.executeCommand(RECORD_AGENT_EDIT_COMMAND, edit).catch(error => {
			this._logService.warn('[prooftree] Could not record a kept agent edit', error);
		});
	}
}

registerSingleton(IAgentEditReviewService, AgentEditReviewService, InstantiationType.Eager);

class AgentEditReviewContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.prooftreeAgentEditReview';

	constructor(@IAgentEditReviewService _service: IAgentEditReviewService) { }
}

registerWorkbenchContribution2(AgentEditReviewContribution.ID, AgentEditReviewContribution, WorkbenchPhase.AfterRestored);

/** Runs one of the chat editing Keep actions, recording what it keeps as reviewed. */
abstract class KeepAsReviewedAction extends Action2 {

	protected abstract readonly keepCommand: string;

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);
		const reviewService = accessor.get(IAgentEditReviewService);

		const uri = EditorResourceAccessor.getOriginalUri(editorService.activeEditorPane?.input, { supportSideBySide: SideBySideEditor.PRIMARY });
		if (uri) {
			await reviewService.keepAsReviewed(uri, () => commandService.executeCommand(this.keepCommand, ...args));
		}
	}
}

const keepPrecondition = ContextKeyExpr.and(ctxHasEditorModification, ctxIsCurrentlyBeingModified.negate());
const category = localize2('prooftree', "Prooftree");

registerAction2(class KeepFileAsReviewedAction extends KeepAsReviewedAction {

	protected readonly keepCommand = AcceptAction.ID;

	constructor() {
		super({
			id: 'prooftree.chatEditor.keepAsReviewed',
			title: localize2('keepAsReviewed', "Keep Chat Edits as Reviewed"),
			shortTitle: localize2('keepAsReviewedShort', "Keep as Reviewed"),
			tooltip: localize2('keepAsReviewedTooltip', "Keep the chat edits in this file and record that you reviewed them"),
			category,
			precondition: ContextKeyExpr.and(keepPrecondition, ctxProoftreeEnabled),
			f1: true,
			menu: {
				// Sorts after Keep (same group and order, longer title).
				id: MenuId.ChatEditingEditorContent,
				group: 'a_resolve',
				order: 0,
				when: ContextKeyExpr.and(ctxProoftreeEnabled, ContextKeyExpr.or(ctxIsGlobalEditingSession, ctxHasRequestInProgress.negate())),
			},
		});
	}
});

registerAction2(class KeepHunkAsReviewedAction extends KeepAsReviewedAction {

	protected readonly keepCommand = AcceptHunkAction.ID;

	constructor() {
		super({
			id: 'prooftree.chatEditor.keepHunkAsReviewed',
			title: localize2('keepHunkAsReviewed', "Keep this Change as Reviewed"),
			shortTitle: localize2('keepHunkAsReviewedShort', "Keep as Reviewed"),
			category,
			precondition: ContextKeyExpr.and(keepPrecondition, ctxProoftreeEnabled),
			f1: true,
			menu: {
				// Sorts between Keep and Undo (same order, compared by title).
				id: MenuId.ChatEditingEditorHunk,
				order: 1,
				when: ctxProoftreeEnabled,
			},
		});
	}
});
