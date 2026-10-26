# Developer Protocol

**Server:** switzerland-parliament-mcp-server
**Version:** 0.1.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.18`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.4.0
**Zod:** ^4.6.7

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool workflows

All seven tools are read-only, idempotent public-source lookups. Definitions live in `src/mcp-server/tools/definitions/`, register directly in `src/index.ts`, and use `chparl_` names.

`chparl_search_business` discovers canonical IDs; `chparl_get_business` reads one section at a time. `chparl_get_votes` discovers roll calls by business/session, reads a person's voting history directly, or selects a roll call for member decisions and complete group counts. `chparl_search_transcripts` joins business through debate subjects. Member workflows use `PersonNumber`, never assume it equals `Person.ID`.

`chparl_list_reference` resolves source codes before discovery. For example:

```json
{"topic":"sessions","language":"fr","limit":50}
```

Its definition validates topic-specific dates, resolves effective filters, calls `getParliamentService().listReference` inside `withWorkflow`, fits complete rows with `fitCollectionPage`, and publishes the prepared enrichment through `ctx.enrich`. Declare enrichment as one `EnrichmentSchema` object and pass `enrichmentTrailer: fieldTrailer(EnrichmentSchema.shape)`, so every trailer field renders through `renderField`. That, with `formatParliamentResult` for the domain block, keeps byte measurement equal to the actual output. Build notices with `joinNotices`, `clampNotice`, and `isPastEnd` from `parliament-format.ts`. Keep every field and enrichment value on both `content[]` and `structuredContent`.

### Source fidelity and pagination

- Metadata language is `de`, `fr`, or `it`; it never translates Bulletin text. Preserve source strings, HTML, line endings, unknown codes, and absent values.
- Every successful result carries `provenance` with attribution, source URLs, and actual download or snapshot dates.
- Collection pages fit whole rows to the 24,000-byte complete-result budget. Preserve an indivisible oversized row with a notice; never shorten fields.
- Business searches continue with `nextCursor`; other paged sections use `nextOffset` based on delivered rows. Author searches omit counts and use one extra matching row; committee pages count role candidates and omit a distinct business total.
- Vote rows use canonical `CantonNumber` for `cantonId` and retain source `Voting.CantonID` as `votingCantonId`. Decision buckets preserve all distinct published labels in `decisionTexts`, including unknown codes.
- Business text selection returns whole named fields; automatic overflow can return `textDocument.kind: "outline"`. Member page counts have `scope: "page"`; complete vote/group counts require `mode: "groups"`.
- No domain environment variables, credentials, resources, prompts, persistent cache, or background tasks are required.

### Server identity and lifecycle

```ts
await createApp({
  name: 'switzerland-parliament-mcp-server',
  title: 'switzerland-parliament-mcp-server',
  tools: [searchBusinessTool, getBusinessTool, getVotesTool, searchTranscriptsTool,
    searchMembersTool, getMemberTool, listReferenceTool],
  resources: [],
  prompts: [],
  sessionMode: 'stateless',
  setup() {
    initParliamentService();
  },
});
```

`src/index.ts` also supplies the full server instructions. The framework reads the description from `package.json`. Install identity is `@cyanheads/switzerland-parliament-mcp-server`; registry identity is `io.github.cyanheads/switzerland-parliament-mcp-server`; display/machine identity is the bare repository name.

---

## Context

| Property | Server usage |
|:---------|:-------------|
| `ctx.signal` | Composed with one 45-second workflow deadline; every request, join, retry, and continuation shares it. |
| `ctx.enrich` | Effective filters, delivered counts, known totals, continuation, and notices on both result surfaces. |
| `ctx.fail` | Typed failure reasons declared inline on each tool. |
| `ctx.log` | Request-scoped, client-visible logging; never raw response bodies or source stacks. |

---

## Errors

Handlers throw; the framework catches, classifies, and renders. Declare contracts inline on each tool with `reason`, `code`, `when`, and actionable `recovery`; use `thrownBy: 'service'` for service-layer reasons.

For example, `chparl_get_votes` declares `incompatible_fields` and rejects identifiers or paging that belong to another mode:

```ts
if (input.mode === 'groups' && (input.personNumber !== undefined ||
  input.limit !== undefined || input.offset !== undefined)) {
  throw ctx.fail('incompatible_fields');
}
```

Service errors carry stable reasons such as `ambiguous_business_number`, `invalid_cursor`, and `upstream_rate_limited`. Exact identifier misses use the documented `found: false` result; valid empty collections remain successful. Never convert upstream outages, malformed payloads, or failed joins into empty data.

Catch only to classify a boundary failure or preserve cancellation/deadline precedence. Every tool workflow uses `withWorkflow`; services take its explicit context. See the framework protocol and `api-errors` skill for the full error reference.

---

## Structure

```text
src/
  index.ts                              # createApp() registration and setup
  mcp-server/tools/
    definitions/                        # Seven chparl_ tool definitions
    parliament-format.ts                # Lossless rendering and whole-row fitting
  services/parliament/                   # Domain schemas/services, OData client,
                                        # deadlines, provenance, static references
tests/
  helpers/                              # Source fixtures and workflow helpers
  mcp-server/tools/                      # Tool behavior and rendering tests
  services/parliament/                   # Network boundary and domain tests
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-business.tool.ts` |
| Tool/resource/prompt names | snake_case | `chparl_search_business` |
| Directories | kebab-case | `src/services/parliament/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search Swiss parliamentary business by title and filters.'` |

---

## Skills

Development skills live in `framework-skills/`; read them when a task matches, or run `bun run list-skills` for the registry. Framework-managed skills carry `metadata.audience: external` and are synced by maintenance. Server-owned development skills omit that marker.

Root `skills/` is a separate, opt-in tree for agents that install the server, authored with `add-skill`. Maintenance never creates or modifies it. A published tree ships through npm, plugins, and MCPB; Docker delivery and `createApp({ skills: 'skills' })` require explicit adoption. This server does not publish skills.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-skill` | Author a skill the server publishes in root `skills/` for agents that use it |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging checks — registry/bundle env parity, MCPB exclusions, plugin manifests, and published skills (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run Vitest with Istanbul coverage |
| `bun run start` | Run the built server with Node; transport from environment |
| `bun run release:github` | Create release assets through the authorized release workflow |
| `bun run publish-mcp` | Publish registry metadata through the authorized release workflow |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/<major.minor>.x/<version>.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`bun run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. Every excluded root path needs a root-anchored `.mcpbignore` line; root `skills/` is never excluded. After packing, `scripts/clean-mcpb.ts` prunes dev dependencies, dependency-shipped agent docs, platform-specific native bindings, node-gyp generator/intermediate files that expose packing-machine paths (compiled `*.node` addons stay), and build-only framework and better-sqlite3 files. `lint:packaging` checks the exclusions and packed content. MCPB uses Node and stdio; Streamable HTTP runs separately. This keyless server needs no bundle user configuration.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `bun run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `bun run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the release digest: theme line, `## Changes`, `## Gates`, changelog link last); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getParliamentService } from '@/services/parliament/parliament-service.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
```

---

## Checklist

- [ ] Tool-facing Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered directly in the `createApp()` arrays in `src/index.ts`
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] Root `plugin.json` and `mcp.json` match package identity and the fixed environment in `.codex-plugin/mcp.json`; the Codex manifest retains its overlay pointer
- [ ] MCPB exclusions are root-anchored; `bun run bundle` and `lint:packaging` pass
- [ ] If publishing root `skills/`: validate the tree and field-test every gate and identifier claim
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] `bun run devcheck` passes with zero warnings; `bun run test` and `bun run lint:packaging` pass
