# Prooftree for VS Code

Claims, evidence and reviews for code written by agents and people, after Prooftree's
statement / step / review model.

- A **claim** states something true about the code and is anchored to the lines that make
  it true (`file:start-end`, SHA-256 of the text). Claims can rely on other claims
  (**premises**).
- A **goal** is broken into ordered **steps**, each a claim of its own. A goal is
  **proved** when every step is discharged; changing a step's code reopens it.
- Each claim can carry **reasoning** at three depths: a summary, an explanation and full
  detail. Readers pick the depth; deeper levels show more explanation, not more certainty.
- A claim can be **stated in Lean**: link a theorem, and a `lean` check compiles it and
  fails if the proof uses `sorry`. The Lean declaration is anchored like code, so editing
  the statement makes the claim drift.
- **Evidence** is either a configured **check** the tooling ran itself, or an
  **assertion** (reasoning without a check). A **review** is a person's approval or
  rejection. All three are bound to the claim's fingerprint: its statement, the current
  anchored text, and the fingerprints of its premises and steps. Checks also record a hash
  of their command and input files, so weakening a test makes old results stale.
- **Agent-written code is tracked until something vouches for it.** An agent's hooks
  record the lines each of its tool calls writes (*written*), from Claude Code in a terminal
  as well as VS Code chat. When a person keeps chat edits, the kept lines are recorded as
  *accepted*: keeping an edit is not reviewing it. **Keep as Reviewed** (or **Mark Agent
  Edit Reviewed** later) records that they also read them. Agent lines that no person
  reviewed and no claim's passing check or approval covers are **unverified**: tinted in the
  editor, listed in the Claims view and annotated in CI. A check does not vouch for its own
  input files: an agent's new tests stay unverified until a person reviews them. Each line
  is hashed, so a review or a check covers exactly the text it saw, and lines that change
  afterwards drop out.
- Everything is appended to `.prooftree/ledger.jsonl`; people configure checks and the
  stop gate in `.prooftree/config.json`.

Statuses: `checked`, `reviewed`, `proved` (by steps), `asserted`, `unsupported`, `stale`,
`failed`, `drifted`, `blocked`. By default `checked`, `reviewed` and `proved` discharge a
claim.

```json
{
	"checks": {
		"unit": { "command": "npm test", "inputs": ["test/**", "package.json"] },
		"lean": { "kind": "lean", "inputs": ["lakefile.*", "lean-toolchain"] }
	},
	"gate": { "onStop": true, "scope": "agent", "accept": ["checked", "reviewed", "proved"], "unverifiedAgentCode": "warn" }
}
```

## Surfaces

| Who | Where |
| --- | --- |
| People in VS Code | Claims view (goals with numbered steps), CodeLens and status borders on code and Lean files, hover with +/- reasoning depth, status bar, knowledge graph tab, commands to declare, add steps, link Lean, check, approve/reject, re-anchor and retract. On agent code: **Keep as Reviewed** next to Keep, a tint and hover on unverified agent lines with **Mark reviewed** and **Declare a claim**, and an "Agent code without evidence" list |
| VS Code chat agents | Language model tools `#declareClaim`, `#decompose`, `#updateClaim`, `#runCheck`, `#assert`, `#listObligations`, `#status`, `#outline`, `#graph` |
| Claude Code and other MCP clients | `node out/cli/main.js mcp` exposes the same tools |
| Any agent with hooks | `node out/cli/main.js hook`: `SessionStart` explains the contract and notes which claims were already open; `PreToolUse` and `PostToolUse` record the lines each file-writing tool call changed (from a snapshot of the files before it ran) and report claims the edit affected, through their code or the files their checks read, including goals above them; `Stop` blocks (exit 2) while claims the session opened or changed are not discharged. Claims left open by earlier work don't hold up a new session unless it touches them (`"scope": "all"` holds every session to every open claim) |
| CI | `node .prooftree/bin/prooftree.cjs ci --rerun` re-runs stale or failed checks, writes a job summary, annotates open claims on their lines, and fails the build. Unverified agent code is annotated as warnings, or fails the build with `"unverifiedAgentCode": "block"`. **Prooftree: Add CI Workflow** writes the GitHub workflow, the bundled CLI and a union merge rule for the ledger |
| Terminal | `prooftree edits` lists unverified agent lines (`--all` for every agent line and what covers it); `prooftree review-edits <file[:start-end]>` records your review |

Agents cannot review, keep edits or retract, and can only run checks a person configured.
**Prooftree: Connect Agents** writes `.claude/settings.json` hooks (read by both Claude
Code and VS Code), `.github/hooks/prooftree.json` (VS Code only) and `.mcp.json`.

The hover's depth buttons use the proposed `editorHoverVerbosityLevel` API, which this
built-in extension may use because it ships with the fork.

Keep as Reviewed needs the workbench, because only it sees which hunk a person kept. The fork
adds the kept line ranges to chat editing's hunk events and a small contribution in
`src/vs/workbench/contrib/prooftree` that forwards each keep to `_prooftree.recordAgentEdit`
and adds the Keep as Reviewed buttons when the workspace has a ledger (`prooftree.enabled`).

## Develop

```sh
export PATH=~/.local/share/node/node-v24.22.1-darwin-arm64/bin:$PATH   # Node from .nvmrc
cd extensions/prooftree
../../node_modules/.bin/tsc -p .   # or: pnpm run gulp compile-extension:prooftree
npm test                           # node:test unit tests; the Lean test runs when `lean` is installed
npm run build-cli                  # dist/prooftree.cjs, the single-file CLI that CI uses
```

Run the whole IDE with `./scripts/code.sh <folder>` from the repository root.

The [Lean-in-the-loop development plan](docs/lean-in-loop-development-plan.md) describes the proposed work-spec model, native IDE surfaces, Lean execution service, agent workflows, milestones, and acceptance criteria. It distinguishes the existing implementation from planned capabilities.

The `languageModelTools` entries in package.json mirror `src/agent/tools.ts`; a test fails
if they drift. The graph webview's page lives in `src/workbench/graphPage.ts` without VS Code
API dependencies, so it can be rendered on its own.

## Not yet

Recording files an agent changes through a shell command rather than an edit tool (such as
`sed -i`), inline completions, Lean code-to-spec extraction, and Prooftree cloud sync. See the
exploration doc in the prooftree docs repo.

### Worked SDD feature: troubleshooting diagnostics

The [diagnostic logging field notes](docs/diagnostics-sdd-field-notes.md) walk through an implemented feature with requirements, production-linked Lean contracts, HTTP/browser evidence, stale-result handling and open human review obligations. The [example config](examples/diagnostic-logs/config.json) separates declaration checks, integration checks and Linux statement comparison.

Lean checks can set `permittedAxioms` to an explicit dependency allowlist, such as `["propext", "Quot.sound", "Classical.choice"]`. `[]` requires no dependencies; omitting the field retains the previous policy. Placeholder dependencies are always rejected. Changing the list makes prior evidence stale. A check requires a successful compiler exit and dependency output naming the linked declaration; proof text alone cannot override process failure.
