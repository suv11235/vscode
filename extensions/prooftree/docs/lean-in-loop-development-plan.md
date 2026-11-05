<!-- Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License. -->

# Lean-in-the-loop feature development

Status: proposed development plan. This document changes no runtime behavior and does not claim that the planned integrations or example proofs already exist.

Baseline: `prooftree/mvp` at `7c32e782f1799960329d2db0716dfc6f7910f4a5`, inspected on 2026-11-05. Develop the implementation as incremental changes on top of that branch; its Prooftree implementation is not on the fork's default `main` branch.

## 1. Product outcome

Make VS Code a practical interface for developing useful software while preserving explicit, machine-checked guarantees. The developer works on a feature, bug fix, or optimization. Its spec names the intended behavior, acceptance requirements, assumptions, and verification boundary. An agent can propose implementations and proofs; the developer can inspect the statement, executable code, evidence, application behavior, and remaining obligations together.

The core loop is:

```text
work spec → reviewed formal contract → implementation or proposal
          → check → proof obligation or checked counterexample
          → repair → recheck → review → reproducible handoff
```

A formal statement is one part of a work spec. A work spec can have several requirements, and each requirement can have different evidence: a Lean proof, a verified checker's verdict for a concrete input, a test, a reviewed model correspondence, or no evidence yet. Plans and tasks describe a chosen development process; completing them does not establish correctness.

### Design constraints

- Keep the normal VS Code workbench: Explorer, source control, editor tabs and groups, Problems, Terminal, Test Explorer, and agent chat.
- Add task-focused native views and contextual editor affordances. Use a webview only for content that needs a graph, rich comparison, or application-specific visualization.
- Support spec-led development, bug investigation, direct changes, proof repair, and optimization as optional workflows over the same work/evidence model.
- Let developers use the existing Lean extension and Infoview. Do not build another Lean language server or copy the Infoview into a separate proof editor.
- Keep formal checks, tests, human meaning review, human code review, agent assertions, and application-instance verdicts distinct.
- Make unsupported scope visible. A theorem about a core function or an extracted model does not certify an entire application.

### Non-goals for the first release

Automatic formalization of arbitrary applications, arbitrary source-to-Lean translation, mandatory Lean rewrites of all application code, universal proof search, a replacement for existing agent chat, a prescribed Spec Kit pipeline, cloud synchronization, and an adversarial-agent sandbox are outside the first release.

## 2. Existing foundation and gaps

The baseline already provides an append-only ledger, code anchors, claim dependencies and goal steps, evidence fingerprints, configurable checks, human reviews, agent tools through chat and MCP, agent hooks, CI reporting, a graph view, and editor presentation. It also records written/accepted/reviewed agent lines and adds Keep as Reviewed through a small workbench contribution.

| Area | Existing implementation | Planned extension |
| --- | --- | --- |
| Evidence domain | `src/ledger/model.ts`, `service.ts`, `status.ts` | Work specs and requirement identities; explicit evidence kinds and execution boundaries |
| Versioning | Anchors, claim fingerprints, configured input hashes | Statement/definition/import/toolchain closure; immutable run inputs; late-result rejection |
| Lean runner | `src/ledger/lean.ts` | Fail-closed process handling, approved axioms, structured declaration receipts, cancellation and provenance |
| IDE | `src/workbench/claimsView.ts`, `editor.ts`, `graphView.ts` | Current Work hierarchy, requirement evidence panel, related-file navigation, proof repair and preview links |
| Agents | `src/agent/tools.ts`, `mcp.ts`, `hook.ts` | Work context and structured obligations; revision-scoped tools; spec-change proposals |
| Review | Claim reviews and agent edit records | Separate meaning review, code review, and source-pair discussions |
| CI | `src/ledger/ci.ts` and bundled CLI | Formal requirements policy, pinned proof receipts, reproducible scoped handoff |
| Workbench | `src/vs/workbench/contrib/prooftree` | Keep the existing kept-hunk bridge; add further core integration only when an extension API cannot supply the event or surface |

Important gaps to resolve before advertising formal assurance:

1. A generic passing check or human review can currently discharge a claim. Neither should satisfy a requirement that explicitly demands a formal proof.
2. `proved` currently means a goal's steps were discharged. It is not a Lean proof that those steps compose into the parent theorem.
3. The Lean runner rejects `sorryAx`, but does not enforce an explicit allowlist for other axioms. It also needs process exit status to be a mandatory success condition, independent of text found in output.
4. The Lean declaration locator is text-based. A simple file span does not establish exact declaration identity, elaborated statement identity, or imported dependency coverage.
5. The stop hook deliberately warns rather than repeatedly blocks when `stop_hook_active` is set. It is a development feedback mechanism, not the release gate.
6. Shell-generated edits and changes to transitive verification inputs need broader reconciliation. An absent tool hook must never imply that unchanged evidence is current.
7. A claim anchored near a theorem does not establish that the application executes that function or a verified refinement of it.

## 3. Work and evidence model

Extend the existing ledger/service rather than creating an independent status database in each view. Add a versioned schema with explicit migration rules. Existing v1 records remain readable and retain their historical semantics; they must not be silently promoted to formal evidence.

### Proposed domain objects

| Object | Required meaning |
| --- | --- |
| Work item | Stable ID, title, feature/fix/optimization kind, owning workspace, spec URI and revision, selected workflow |
| Requirement | Stable ID within the work, prose and scope, assumptions, required evidence policy, related claims and executable bindings |
| Formal contract | Fully qualified declaration, elaborated statement and referenced-definition identity, preconditions, toolchain context |
| Executable binding | The running entry point and relation to the contract: same verified core, verified checker, verified refinement, or model with separate correspondence evidence |
| Verification run | Frozen inputs, requested declarations, configuration and command identity, toolchain/dependency versions, exit status, timestamps, artifacts and structured result |
| Evidence | Kind, producer, exact input fingerprint, result, scope and run reference; never only an editable status label |
| Meaning review | Exact prose/formal-source pair and assumptions reviewed by a person |
| Code review | Exact implementation or agent-written text reviewed by a person |
| Discussion excerpt | Immutable excerpt, source version and optional run reference; independent of its current graph position |

Use ordinary repository files for authoring. The following is an illustrative layout, not a required framework:

```text
work/014-job-dedup/
  spec.md
  plan.md
  tasks.md
  requirements.json
src/Core/Queue.lean
proofs/QueueSafety.lean
.prooftree/config.json
.prooftree/ledger.jsonl
```

Define the authoritative fields and precedence before implementation: Markdown is the authoring surface for narrative requirements; the manifest supplies stable IDs and explicit links; the ledger records immutable evidence and reviews. Conflicts between these representations block promotion of evidence until resolved. Do not infer identity from line numbers or generated graph titles.

### Independent state dimensions

Store a run's result separately from freshness and review state. A passed run can become stale. A human-reviewed statement can have no proof. A compiler failure does not establish a counterexample. An accepted proposal does not replace the proof of the checker's soundness.

Required dimensions are:

- Execution: queued, running, passed, failed, cancelled, unavailable, or timed out.
- Freshness: current, stale, missing input, or unresolved dependency coverage.
- Meaning review: pending, approved, rejected, or stale for the exact source pair.
- Code review: pending, accepted without review, reviewed, or stale for the exact text.
- Assurance kind: formal proof, instance verdict, test, reviewed correspondence, or assertion.

Derive requirement and work summaries from these dimensions and the declared policy. Preserve legacy statuses for compatibility, but label a composed goal as steps discharged unless a checked formal composition establishes the parent proposition.

## 4. Workbench design

| Surface | Behavior | Implementation direction |
| --- | --- | --- |
| Explorer | Show normal spec, plan, task, implementation and proof files | Ordinary files; avoid replacing the Explorer with an application dashboard |
| ProofTree activity view | Current Work → requirements → obligations, artifacts and related source | Extend the existing tree provider and commands |
| Editor tabs/groups | Open a spec beside source, a formal contract or an application preview | Native editor commands; custom text editor only if a richer spec view provides enough value to justify undo/save integration |
| CodeLens/hover | Show requirement links, evidence kind, freshness, scope, and Open Proof/Recheck actions | Extend current editor presentation and use theme tokens |
| Lean Infoview | Show proof state and goals for the current Lean source | Reuse the official Lean extension; establish an adapter contract before consuming its non-public internals |
| Problems | Diagnose open formal obligations and stale/missing verification inputs at precise locations | Diagnostics and related information; do not report ordinary prose without formal coverage as a compiler error |
| Verification runs | Run, rerun and cancel named checks, with source locations and logs | Evaluate the Testing API for run lifecycle; retain explicit Formal Proof/Test labels and the evidence panel as the authority for assurance kind |
| ProofTree bottom panel | Requirement coverage, exact run receipts, assumptions and current review state | One derived model, shared with tree, CLI and CI |
| Source control/diff | Identify affected requirements, unreviewed agent text and evidence invalidated by the diff | Keep the existing hunk bridge; distinguish Keep from Keep as Reviewed |
| Agent chat | Attach the current work, selected requirement, source revision and open obligations | Existing LM tools and MCP; do not require a new proprietary chat UI |
| Evidence graph | Navigate recorded dependencies and explain invalidation | Reuse and extend the existing graph webview; distinguish recorded dependencies from generated explanatory readings |
| App preview | Run the actual demo application and associate a visible action or verdict with its contract | Standard webview or an external local app; an explicit adapter passes typed inputs and run/verdict references |

The desktop layout is a normal Explorer on the left, native source/spec editor groups in the center, the existing agent chat in the secondary sidebar, and Problems/Terminal/ProofTree below. A work context control selects the current feature and workflow. Avoid mandatory panels that consume space when no work or formal contract is selected.

Accessibility, keyboard navigation, high contrast, theme compatibility, focus restoration, and non-color status labels are acceptance requirements. Rich views must preserve ordinary file navigation and save/undo behavior.

## 5. Lean integration and execution service

Use two distinct paths:

1. Interactive feedback reuses the Lean extension's diagnostics and Infoview for the current document. It may describe unsaved buffers and is not automatically durable evidence.
2. A verification run checks a frozen source snapshot under a pinned toolchain and produces an immutable receipt. Only a successful, current run that meets the requirement's policy can supply formal evidence.

### Runner requirements

- A run freezes the spec/contract revision, implementation inputs, imported definitions and modules, `lean-toolchain`, Lake manifests, options, checker command and approved axiom policy. Record the dependency-coverage strategy; when the closure is unresolved, invalidate conservatively and do not label it complete.
- Begin with a conservative project-source fingerprint plus pinned dependency manifests. Add module-aware incremental invalidation only after the baseline is correct. Changes to assumptions or referenced definitions matter even if the theorem's displayed name and statement text do not change.
- Require successful exit, complete expected output, the exact requested declaration, and allowed axioms. Cancellation, nonzero exit, timeout, missing declarations, incomplete output and unexpected axioms cannot pass.
- Replace broad output regex matching with a versioned Lean-side inspection helper that emits a typed declaration receipt. Specify and test the helper protocol and its trust boundary. Keep raw output for diagnosis.
- Resolve fully qualified declaration identities and source positions through Lean-supported inspection rather than the current short-name/regex heuristic. Ambiguous declarations fail clearly.
- Capture kernel-check status, elaborated statement identity, assumptions and axioms. Reject `sorry` and unexpected axioms. Any proof technique that expands the trust base must be explicitly allowed and shown in the receipt.
- Publish a result only for its frozen fingerprint. If the user edits while a run is in progress, retain the historical result and mark it stale; do not attach it to the new draft.
- Support cancellation, a bounded queue, subprocess cleanup, debounced invalidation and cached results keyed by all material inputs. Do not start a second Lean language server merely to duplicate editor feedback.
- Respect workspace trust and existing user authorization. Do not run arbitrary workspace commands or install toolchains just because a webview opened. Use the configured execution environment for local and remote workspaces.

### Evidence-to-application boundary

Every demonstration declares one of four bindings:

- Same core: the app calls the function named by the checked contract.
- Verified checker: a soundness theorem covers the checker; a separate verdict covers the particular candidate and exact input.
- Verified refinement: a checked relation connects the optimized/alternate executable representation to the reference specification.
- Extracted model: the theorem is about a model. Reviewed extraction and conformance tests are shown separately unless correspondence itself is formally established.

Record source/build identity for the runtime binding. If the preview uses a different or untracked build, show that discrepancy. A generic Lean compilation failure supplies diagnostics; a counterexample is displayed only when a suitable procedure supplies and validates a witness. Never synthesize a counterexample label from an agent explanation alone.

## 6. Agent and human workflow

Extend the existing tools with work selection, requirement inspection, formal-contract linking, structured obligation listing, named-run execution/cancellation, and run-result inspection. Keep the same behavior through native tools, MCP and the CLI; avoid implementing three different evaluation engines.

The agent loop is: read the current work and exact inputs, propose an implementation or proof change, inspect affected requirements, run the named checks, read structured diagnostics or validated witnesses, repair, and present evidence for review. Bounded retries must end with an explicit incomplete result when obligations remain.

Spec edits are proposals. Changes to requirement text, preconditions, definitions, imported assumptions, axiom policies, correspondence scope, or gate configuration require a separate semantic diff and renewed review. Treat a syntactically unchanged theorem with a weakened referenced definition as a spec change.

Humans retain separate actions for Approve Meaning, Keep Changes, Mark Code Reviewed, and Accept a Spec Revision. A review records the exact text or source pair. Updating a dependency or test does not transfer an old approval to new code.

The current agent actor checks and append-only workspace ledger are workflow accountability mechanisms. They are not a security boundary against an agent with unrestricted filesystem access. A stronger threat model requires a trusted check runner, independently protected review/policy records, and an execution boundary the agent cannot modify. Until that exists, the product must not claim containment of malicious agents.

## 7. Milestones and reviewable implementation slices

These are dependency-ordered milestones, not calendar estimates. Each row should be delivered in small PRs with its own reviewable behavior and validation.

| Milestone | Deliverables | Exit criteria |
| --- | --- | --- |
| M0: formal-evidence correctness | Fail-closed Lean result handling, axiom allowlist, evidence-kind distinctions, baseline negative controls | A test result, human approval, unknown axiom, nonzero process exit or stale input cannot satisfy a formal-proof requirement |
| M1: work specs and migration | Versioned work/requirement records, manifest validation, v1 compatibility, exact meaning-review pairs, conservative input fingerprinting | An existing ledger loads without losing history; changing prose, contract definitions, source or check inputs reopens the appropriate evidence |
| M2: native IDE loop | Current Work tree, source/spec links, evidence panel, Problems integration, run/cancel controls, existing chat tool integration | A developer completes the queue vertical slice using real Lean runs, not mock statuses or manually edited result labels |
| M3: proof repair and review | Interactive/durable evidence separation, Lean adapter, structured receipts, goal navigation, semantic spec diff, precise agent edit coverage | Late run results cannot turn a new draft green; Keep leaves review pending; reviewing one revision does not approve the next |
| M4: executable app binding | Original rule-authoring app, verified checker, explicit build/input binding and application-instance receipts | An unsafe proposed rule is rejected, the last accepted rule remains active, and the app can reveal the exact checker theorem and candidate verdict |
| M5: impact and reproducibility | Recorded dependency graph, cross-interface parity, strict scoped CI policy, clean-checkout receipt/manifest generation | Helper/import/toolchain/check-policy edits invalidate affected evidence; CI reproduces named guarantees without trusting a locally edited status |
| M6: broader portfolio | Existing-code arithmetic example, a refinement example, protocol or geometric adapter, optional discussion integration | Every example states whether it runs proved code, uses a proved checker, relies on a refinement, or uses an extracted model |

### First vertical slice: pending-job deduplication

Use a small executable Lean queue with requirements R1, pending keys remain unique; R2, distinct existing jobs retain their order; and R3, the API rejects malformed keys. R1 and R2 require formal proof evidence. R3 initially requires an integration test. Start with a valid saved implementation and receipts, then propose a head-only duplicate check.

The developer opens `spec.md`, follows R1 to `enqueue`, sees evidence become stale on edit, runs the actual check, inspects the failed proof and an independently checked non-head-duplicate example, repairs the full-key guard, reruns the formal obligations, and reviews the changed code. The app preview calls the same core. The handoff states that durable storage and worker execution are outside these queue proofs.

### First product demonstration: constrained automation

Build an original report/approval rule authoring feature, not a reproduction of a hackathon entry. An agent proposes an urgent-action rule, a verified checker rejects a bypass of approval for the current request revision, and a repaired rule executes in the preview. The UI displays checker soundness separately from the instance verdict. Identity and external side effects retain explicit boundaries.

Do not use a proof about a disconnected model as the same-core demonstration. If a later existing-code example uses a reviewed arithmetic extraction, present it explicitly as extracted-model assurance and retain the correspondence tests.

## 8. Portfolio coverage

The following design studies are capability targets, not twelve separate IDE implementations. They share the model, runner, agent tools and native surfaces above.

| Design | Implementation anchor | Earliest milestone |
| --- | --- | --- |
| Work specification and clarification | Work tree, Markdown authoring, exact spec revision and reviewed assumptions | M1–M2 |
| Agent-centered implementation | Existing chat/MCP tools with current work and obligations | M2 |
| Bug investigation | Source comparison, negative controls, diagnostics and validated examples | M2, broader example in M6 |
| Formal contract meaning review | Exact prose/formal pair, assumptions and semantic diff | M1–M3 |
| Proof repair | Lean editor/Infoview plus durable verification runs | M3 |
| Agent edit review | Existing kept-hunk bridge and text-bound reviews | Existing foundation, extended in M3 |
| Verified app preview | Typed runtime binding and separate candidate verdict | M4 |
| Safe optimization | Reference/implementation binding and checked refinement | M6 |
| Protocol workbench | State/trace renderer connected to the actual transition core | M6 |
| Change-impact graph | Recorded input/contract dependencies and stale propagation | M5 |
| Revision-bound discussion | Immutable source/run excerpts; local record first, shared service optional | M3–M6 |
| Release evidence | Pinned scoped checks, approved policy and assurance manifest | M5 |

## 9. Verification and product acceptance

Keep the baseline unit suites under `extensions/prooftree/src/test/` and workbench tests near the changed contribution. Add focused tests for behavior boundaries, not snapshots that merely mirror implementation. Implementation PRs should run the smallest relevant checks under the repository's pnpm workflow; this documentation-only plan does not require a full build.

Required cases:

1. Valid theorem succeeds; direct or transitive `sorry`, unexpected axioms, wrong declaration, nonzero exit, timeout, cancellation and malformed/incomplete receipts do not.
2. Changing an imported definition, precondition, toolchain, dependency manifest, command or declared input invalidates the affected evidence. An unresolved dependency closure is visible rather than silently treated as complete.
3. Editing during a run stores the old result without promoting the new revision. Undoing to exact known inputs may reuse evidence only under the complete cache identity.
4. Human meaning review does not count as a proof; a passing test does not count as a formal proof; discharged steps do not imply checked composition; an instance verdict does not establish checker soundness.
5. The original bad implementation fails the same formal requirement that the repaired implementation passes. Include wrong-scope, weakened-definition and forged/stale-receipt negative controls.
6. Keep does not create a code review. Partial review covers only the reviewed text. Test-source edits invalidate the relevant review and run inputs. Missing edit hooks trigger reconciliation rather than leaving evidence green.
7. A human spec change updates the expected obligation only after review. An agent cannot satisfy the old requirement by silently weakening its formal statement or referenced definitions.
8. CLI, IDE, native tools and MCP evaluate the same requirement policy for the same frozen inputs. Remote and multi-root workspaces do not cross-link source or runs between projects.
9. Webviews expose only authorized workspace data, use restrictive CSP and validate messages/paths. Navigating graphs and previews cannot execute a check or start an agent run as a side effect.
10. The complete workflow works with keyboard navigation and both themes. Closing an editor, cancelling a run, restarting the extension host or opening an unavailable toolchain leaves an honest recoverable state.

Release acceptance requires a clean-checkout run of the first vertical slice and constrained-automation demonstration, with raw receipts, negative controls and an assurance manifest. Record actual time to locate an invalidated property, repair/recheck it, and identify the trust boundary in a user walkthrough. Do not invent productivity or correctness rates.

## 10. CI and trusted handoff

Use the bundled CLI and the same frozen-input evaluation model in CI. An explicitly formal requirement must demand current formal evidence under the approved axiom policy; human approval or a generic passing command is not an alternative. Allow deliberate policy differences for non-formal requirements.

The release job fails on unresolved required properties, stale required evidence, invalid receipts, rejected semantic changes, and unreviewed agent code when the project's policy requires review. Keep development stop-hook behavior independent of this policy.

Define where trusted policy and review authority come from. A workflow, axiom policy or receipt edited by the same untrusted change cannot approve itself. Use protected review controls and independently selected trusted configuration for any adversarial demonstration; otherwise label the workflow as cooperative development. Execute untrusted code without privileged credentials, with workspace trust and runner isolation appropriate to the selected environment.

The handoff records the source/build revision, formal declarations and their statements, executable bindings, assumptions and allowed axioms, proof/toolchain inputs, test evidence, human reviews and exclusions. It makes named property claims rather than one undifferentiated verified badge for the application.

## 11. Decisions to settle during M0–M1

| Decision | Starting recommendation | Evidence needed before expanding |
| --- | --- | --- |
| Extension versus core workbench | Built-in extension plus the existing kept-hunk bridge | A concrete interaction that cannot be implemented through supported APIs |
| Lean editor integration | Official Lean extension for editing; separate reproducible runner for evidence | A documented/versioned adapter spike for goals and navigation, with graceful fallback |
| Dependency invalidation | Conservative project closure first | Verified module-aware extraction before claiming finer-grained coverage |
| Spec storage | Files plus versioned manifest and existing ledger | Conflict/revision behavior tested across CLI and IDE |
| Formal policy | Requirement-level typed evidence rules | Compatibility behavior for legacy generic check/review statuses |
| UI for running checks | Evaluate Testing API; retain the ProofTree evidence panel | Clear distinction between formal proofs, tests and instance checks in the actual interface |
| Preview adapter | One concrete same-core/checker app first | Evidence that its running build corresponds to the checked source |
| Collaborative review | Local exact-version records first | A separately reviewed authenticated backend integration; no cloud dependency for local/CI checks |

## 12. Public references and design provenance

The examples below inspire verification patterns and product experiences. Their project descriptions are not an independent audit, and this plan does not propose copying their applications.

- [Spec Kit](https://github.com/github/spec-kit): reviewable specs, plans, tasks, and configurable agent workflows.
- [Lean VS Code extension](https://github.com/leanprover/vscode-lean4): language support and the existing proof-editing experience.
- [VS Code Tree View API](https://code.visualstudio.com/api/extension-guides/tree-view), [Testing API](https://code.visualstudio.com/api/extension-guides/testing), [Language Model Tool API](https://code.visualstudio.com/api/extension-guides/ai/tools), and [Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors): candidate extension surfaces; validate compatibility with this fork's pinned API before implementation.
- [Charter](https://github.com/parthavshergill/charter): constrained rule authoring over an executable verified core.
- [DefyGravity](https://github.com/johspaeth/DefyGravity): untrusted proposals, a verified checker, instance verdicts and explicit model assumptions.
- [Verified Cut](https://github.com/Philogy/verified-cut): a user application calling a proved core, with refinement for optimized representations.
- [One Token Wedge](https://github.com/iamjustoutthere/sglang-one-token): a scoped arithmetic proof and an explicit distinction between model evidence and production correspondence.
- [zrdt](https://github.com/l-adic/zrdt): verification integrated into an existing application through a checked core and explicit boundaries.
- [Choreo](https://github.com/prrpavani/choreo-helper): visual edits, geometric checks, and user-visible failure diagnosis.

## Implementation feedback: diagnostic logging feature

The first concrete SDD exercise is [DefyGravity diagnostics](https://github.com/johspaeth/DefyGravity/pull/76). [Field notes](diagnostics-sdd-field-notes.md) connect real requirements, code, four Lean contracts, integration/browser results and open review gates. This branch now implements explicit dependency allowlists, policy-sensitive evidence fingerprints, declaration-specific dependency parsing and rejection of failed compiler processes. These are incremental runner improvements, not completion of M0–M6. The exercise confirms the need for independent statement comparison, visible trusted definitions and evidence roles that cannot be mistaken for whole-feature assurance.
