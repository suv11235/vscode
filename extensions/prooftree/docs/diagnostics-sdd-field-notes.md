# A feature built with Lean in the development loop

The worked feature is [DefyGravity troubleshooting diagnostics, PR #76](https://github.com/johspaeth/DefyGravity/pull/76). The request was diagnostic logs for the end user. The implementation adds a small diagnostics disclosure panel to the app, with inspect, refresh, export and clear. The point of this case study is the development workflow and its evidence, rather than the app's domain.

## A concrete path through the IDE

1. Open the feature's [specification](https://github.com/johspaeth/DefyGravity/blob/feature/end-user-diagnostics/docs/features/diagnostic-logs/spec.md). Review D1–D5 as a translation of intent; an agent-authored draft is not human approval. Separate the pure contract from HTTP behavior and user acceptance.
2. Open the [ProofTree ledger](https://github.com/johspaeth/DefyGravity/blob/feature/end-user-diagnostics/.prooftree/ledger.jsonl) in the claims view. It contains an agent-authored parent, four linked declarations, an HTTP obligation, and open Linux verification and human review obligations. The machine results were actually executed by this fork's CLI; no reviewer identity was invented.
3. Follow a declaration into `KaplaWeb.Diagnostics.lean`, then inspect `DiagnosticsModel.lean`, where the actual serializer and retention function are defined. The server calls those definitions. Follow the production anchor into `app/Main.lean` to inspect the boundary from HTTP replies to logged facts.
4. Rerun `diagnostic-proof` on a linked declaration. The configured allowlist is propext, Quot.sound and Classical.choice. A successful compile is accepted only after a successful process exit and a dependency report for that exact declaration. A placeholder dependency always fails, even if listed in the config.
5. Edit the definition module, independent spec statement, comparator config, toolchain or dependency policy. Earlier evidence becomes stale because those inputs are fingerprinted. Rerun the proof and inspect the newly changed statement; a proof can remain green after someone weakens the meaning.
6. Run `diagnostic-http` separately. It builds the actual server, starts an isolated instance, and tests schema, failures, private sentinel exclusion, origin rejection, retention and clearing. It is integration evidence; it does not increase the theorem's scope.
7. Inspect the actual panel and JSON download in a browser. Inspect Linux kernel replay and statement comparator in the PR. Keep independent review open until a person reviews the shared definitions and integration boundary.

The [example configuration](../examples/diagnostic-logs/config.json) is intended for a DefyGravity checkout, not for this VS Code repository. Open the app's feature branch to use its actual ledger. Build Lake imports before running linked declarations. Run only one Lean/Lake process at a time in that checkout.

## What was learned and changed

| Observation from doing the work | Framework response in this branch | Remaining design work |
| --- | --- | --- |
| A file can print dependency text even when its process fails. | Lean runner rejects nonzero exits before accepting dependency text; regression test covers a process that prints proof text and exits 7. | Structured compiler protocol and execution isolation. |
| The project's comparator has an explicit dependency policy. Merely excluding placeholders is weaker. | Optional `permittedAxioms` in config and JSON schema; dependency names outside it fail. An empty array requires none; omission preserves the previous policy. Check descriptions expose the policy. | Show kernel replay and comparator receipts as separate evidence types. |
| A policy change must invalidate old evidence. | Input fingerprints include `permittedAxioms`; config, hashing and runner regression tests cover it. | First-class immutable spec revisions and explicit reviewer acceptance of changes. |
| Source files can contain dependency output for multiple declarations. | Match dependency output to the linked declaration rather than the first declaration printed. | Replace text parsing with a structured Lean adapter. |
| Proofs of helpers are insufficient if the app implements another function. | The example anchors the real server and uses the exact proved retain/serializer functions. Definition modules are inputs. | Surface the implementation-to-contract link and trusted definitions directly in the workbench. |
| UI and HTTP requirements cannot all be justified by a list theorem. | Separate formal, HTTP, browser, Linux and human review obligations; open gates remain visible. | Typed evidence roles and conjunctive acceptance policies, rather than relying on naming conventions. |

The new allowlist is optional for compatibility. For new verification workflows, configure one explicitly. It checks reported dependencies; it is not a replacement for the independent Linux kernel/comparator workflow. The local runner executes trusted workspace commands and does not provide a security sandbox.

## Verification and limitations

The app passed `make check`, its existing smoke workflow, isolated diagnostic HTTP tests, and a dependency audit. A negative control that retained all events failed the retention contract. Edge inspection showed real records and a completed JSON download. The implementation has no free-form string field in an event; the formal schema statement fixes the three output fields and the operation theorem fixes its vocabulary. These checks do not prove every server call site free of covert channels, establish browser correctness, or verify the entire application.

This fork's targeted ProofTree suite passed 38 tests, including a real Lean proof/placeholder check and process fixtures for failure exit, unexpected dependencies, missing or wrong declaration reports, and policy freshness. A targeted strict TypeScript check covers the new policy test and its ledger dependencies. The complete VS Code application was not rebuilt for these isolated ledger/config changes.

The app's committed evidence intentionally leaves human review open. Linux status lives in the PR's **Kernel check and comparator** job; the existing app CI OK aggregate does not require that job. Do not infer its success from the aggregate alone.
