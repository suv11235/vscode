# Diagnostic logging: SDD + Lean example

This is the check configuration used for the [DefyGravity feature](https://github.com/johspaeth/DefyGravity/pull/76). Paths and commands are relative to that app's checkout. Its feature branch already contains the config, requirements, implementation, proofs, independent spec statements, comparator and real ledger.

Use the updated ProofTree extension/CLI from this branch. Open the app and inspect its existing claims. If building the CLI from a complete VS Code checkout, run `node extensions/prooftree/build-cli.mjs`; then use `node /path/to/vscode/extensions/prooftree/dist/prooftree.cjs --root /path/to/DefyGravity outline` and `check CLAIM_ID diagnostic-proof`. Run `lake build kapla` first and run checks sequentially.

| Requirement | Formal link or check | Boundary to inspect |
| --- | --- | --- |
| Exactly three metadata fields | `KaplaWeb.Diagnostics.event_schema` | `Event.json` and actual HTTP reply wrapper |
| Fixed operation vocabulary | `KaplaWeb.Diagnostics.operation_allowlist` | Route classification drops supplied path segments |
| At most 200 records | `KaplaWeb.Diagnostics.retain_bounded` | Server calls retain with capacity 200 |
| Most recent survives | `KaplaWeb.Diagnostics.retain_latest` | Production appends completed reply before trimming |
| HTTP access, failure and export behavior | `diagnostic-http` | Live server tests; not a theorem |
| Statements and implementations agree | `diagnostic-comparator` | Independent spec module; Linux only |
| Intent and definitions are appropriate | Human review | Remains open until a person reviews it |

`inputs` include shared definitions, spec statements, comparator policy and toolchain files. Keep this broad initially; narrow only after auditing the check's dependencies. The copyable config is a baseline for review, not a universal verification policy. See the [field notes](../../docs/diagnostics-sdd-field-notes.md) for results and limitations.
