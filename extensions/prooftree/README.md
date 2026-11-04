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
	"gate": { "onStop": true, "scope": "agent", "accept": ["checked", "reviewed", "proved"] }
}
```

## Surfaces

| Who | Where |
| --- | --- |
| People in VS Code | Claims view (goals with numbered steps), CodeLens and status borders on code and Lean files, hover with +/- reasoning depth, status bar, knowledge graph tab, commands to declare, add steps, link Lean, check, approve/reject, re-anchor and retract |
| VS Code chat agents | Language model tools `#declareClaim`, `#decompose`, `#updateClaim`, `#runCheck`, `#assert`, `#listObligations`, `#status`, `#outline`, `#graph` |
| Claude Code and other MCP clients | `node out/cli/main.js mcp` exposes the same tools |
| Any agent with hooks | `node out/cli/main.js hook`: `SessionStart` explains the contract, `PostToolUse` reports claims an edit affected (including goals above them), `Stop` blocks (exit 2) while the agent's claims are open |
| CI | `node .prooftree/bin/prooftree.cjs ci --rerun` re-runs stale or failed checks, writes a job summary, annotates open claims on their lines, and fails the build. **Prooftree: Add CI Workflow** writes the GitHub workflow, the bundled CLI and a union merge rule for the ledger |

Agents cannot review or retract, and can only run checks a person configured.
**Prooftree: Connect Agents** writes `.claude/settings.json` hooks (read by both Claude
Code and VS Code), `.github/hooks/prooftree.json` (VS Code only) and `.mcp.json`.

The hover's depth buttons use the proposed `editorHoverVerbosityLevel` API, which this
built-in extension may use because it ships with the fork.

## Develop

```sh
export PATH=~/.local/share/node/node-v24.22.1-darwin-arm64/bin:$PATH   # Node from .nvmrc
cd extensions/prooftree
../../node_modules/.bin/tsc -p .   # or: pnpm run gulp compile-extension:prooftree
npm test                           # node:test unit tests; the Lean test runs when `lean` is installed
npm run build-cli                  # dist/prooftree.cjs, the single-file CLI that CI uses
```

Run the whole IDE with `./scripts/code.sh <folder>` from the repository root.

The `languageModelTools` entries in package.json mirror `src/agent/tools.ts`; a test fails
if they drift. The graph webview's page lives in `src/workbench/graphPage.ts` without VS Code
API dependencies, so it can be rendered on its own.

## Not yet

Separating "accepted" from "reviewed" in chat edit review, highlighting unverified
agent-written code from edit provenance, Lean code-to-spec extraction, and Prooftree cloud
sync. See the exploration doc in the prooftree docs repo.
