# Prooftree for VS Code (MVP)

Claims, evidence and reviews for code written by agents and people, after Prooftree's
statement / step / review model.

- A **claim** states something true about the code and is anchored to the lines that make
  it true (`file:start-end`, SHA-256 of the text). Claims can depend on other claims.
- **Evidence** is either a configured **check** the tooling ran itself, or an
  **assertion** (reasoning without a check). A **review** is a person's approval or
  rejection. All three are bound to the claim's fingerprint: its statement, the current
  anchored text and the fingerprints of its dependencies.
- Editing anchored code makes the claim `drifted` until it is re-anchored. A new revision
  never inherits old evidence, and changing a premise makes dependent claims `stale` or
  `blocked`. Moving code without changing it keeps evidence valid.
- Everything is appended to `.prooftree/ledger.jsonl`; people configure checks and the
  stop gate in `.prooftree/config.json`.

Statuses: `checked`, `reviewed`, `asserted`, `unsupported`, `stale`, `failed`,
`drifted`, `blocked`. By default only `checked` and `reviewed` discharge a claim.

## Surfaces

| Who | Where |
| --- | --- |
| People in VS Code | Prooftree activity bar view, CodeLens and colored borders on anchored lines, status bar, commands (declare from selection, run check, approve/reject, re-anchor, retract) |
| VS Code chat agents | Language model tools `#declareClaim`, `#updateClaim`, `#runCheck`, `#assert`, `#listObligations`, `#status` |
| Claude Code and other MCP clients | `node out/cli/main.js mcp` exposes the same tools |
| Any agent with hooks | `node out/cli/main.js hook`: `SessionStart` explains the contract, `PostToolUse` reports claims an edit affected, `Stop` blocks (exit 2) while the agent's claims are open |

Agents cannot review or retract, and can only run checks a person configured.
**Prooftree: Connect Agents** writes `.claude/settings.json` hooks (read by both Claude
Code and VS Code), `.github/hooks/prooftree.json` (VS Code only) and `.mcp.json`.

## Develop

```sh
export PATH=~/.local/share/node/node-v24.22.1-darwin-arm64/bin:$PATH   # Node from .nvmrc
cd extensions/prooftree
../../node_modules/.bin/tsc -p .   # or: pnpm run gulp compile-extension:prooftree
npm test                           # node:test unit tests for ledger, hook and MCP
```

Run the whole IDE with `./scripts/code.sh <folder>` from the repository root.

The `languageModelTools` entries in package.json mirror `src/agent/tools.ts`; a test fails
if they drift.

## Not yet

Reasoning-depth hovers, a reasoning graph, separating "accepted" from "reviewed" in chat
edit review, unverified-agent-code overlay from edit provenance, formal verifier backends,
and Prooftree cloud sync. See the exploration doc in the prooftree docs repo.
