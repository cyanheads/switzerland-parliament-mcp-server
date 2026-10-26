<div align="center">
  <h1>@cyanheads/switzerland-parliament-mcp-server</h1>
  <p><b>Search Swiss parliamentary business, votes, debates, members, and declared interests via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/switzerland-parliament-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/switzerland-parliament-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/switzerland-parliament-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/switzerland-parliament-mcp-server/releases/latest/download/switzerland-parliament-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=switzerland-parliament-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc3dpdHplcmxhbmQtcGFybGlhbWVudC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22switzerland-parliament-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fswitzerland-parliament-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://switzerland-parliament.caseyjhand.com/mcp](https://switzerland-parliament.caseyjhand.com/mcp)

</div>

---

## Overview

Swiss Federal Assembly records from Curia Vista and the Amtliches Bulletin. Find parliamentary business, read its original texts and procedural history, follow the debate in either council, inspect Nationalrat roll calls, and look up members and declared interests. Uses the [public OData service](https://ws.parlament.ch/odata.svc/) without an API key; runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

Results credit **Parlamentsdienste der Bundesversammlung, Bern**, with source URLs and download dates. This is an unofficial reproduction. The [Parliament's open-data conditions](https://www.parlament.ch/de/%C3%BCber-das-parlament/fakten-und-zahlen/open-data-web-services) apply to source content; underlying author rights remain intact.

### Tools

| Tool | Description |
|:---|:---|
| `chparl_search_business` | Find business by title, submitter, type, status, submission session, dates, or committee role |
| `chparl_get_business` | Read business metadata, original texts, status history, bills, related business, committee consultations, or debate subjects |
| `chparl_get_votes` | Find Nationalrat roll calls, page member decisions, or read complete vote and parliamentary-group counts |
| `chparl_search_transcripts` | Find debate passages by business, subject, speaker, session, council, or dates; retrieve original text |
| `chparl_search_members` | Find current or former parliamentary affiliation records by name, council, canton, party, or group |
| `chparl_get_member` | Read parliamentary identity, council terms, committee memberships, or declared interests |
| `chparl_list_reference` | Resolve identifiers, coverage, languages, codes, committees, and sessions |

## Capability reference

### `chparl_search_business` <sub>tool</sub>

- `query` (title substring), `author` (published submitter label, not every co-signatory), `typeId`, `statusId`, `sessionId` (submission session), `committeeId`, and inclusive `submittedFrom` / `submittedTo`. Newest business IDs first, default 20/max 100
- Continue with `nextCursor` and unchanged filters; a cursor from other filters fails as `invalid_cursor`. `totalCount` is reported only without author or committee filters. Author searches use an extra matching row to establish continuation; committee searches page role candidates, so pages can be short

---

### `chparl_get_business` <sub>tool</sub>

- Canonical eight-digit `businessId` or an exact published short number such as `99.1234`. A short number matching several businesses fails as `ambiguous_business_number`, and a miss returns `found: false`
- `overview` (default) returns metadata and `availableTextFields` with UTF-8 sizes. `texts` returns `textDocument.kind: "full" | "outline"`: several large fields become an outline, and named `textFields` always return whole
- `status_history`, `bills`, `related_business`, `preconsultations`, and `subjects` page independently, default 20/max 100 with `nextOffset`. `subjects` IDs narrow `chparl_search_transcripts`; linked bills are parliamentary records, not enacted law

---

### `chparl_get_votes` <sub>tool</sub>

- `mode: "votes"` with `businessId`, `sessionId`, or both lists roll calls (default 10/max 50). A returned `voteId` feeds `mode: "members"` (default 50/max 100, optional `personNumber`) or `mode: "groups"` (unpaged). Paged modes continue with `nextOffset`
- `mode: "members"` with `personNumber` and no `voteId` pages that member's voting history, optionally narrowed by `businessId` and `sessionId`. Each history row carries its published vote, business, session, and time fields; selected-vote pages carry that context once in `vote`. `cantonId` uses the canton reference's numbering; `votingCantonId` preserves the source Voting identifier
- `members` counts carry `decisionCounts.scope: "page"`. `groups` reads every published member row and returns `scope: "vote"`, `complete: true`, and per-group totals by the affiliation recorded on the vote. Count buckets retain every distinct published label in `decisionTexts`. Decision codes: 1 yes, 2 no, 3 abstention, 4 present, 5 did not participate, 6 excused under Art. 57 para. 4, 7 president does not vote, 8 resigned
- **Nationalrat only, from the 2003 winter session.** An empty result does not establish that no vote occurred

---

### `chparl_search_transcripts` <sub>tool</sub>

- Both councils from the **1999 winter session**. Scope with `businessId` or `subjectId` (exclusive), `personNumber`, `sessionId`, or a date bound; `council` only narrows. `query` (original-text substring) also needs `sessionId` or a closed range of at most **31 calendar days**
- Metadata with `textSizeBytes` by default (20/max 100); `includeText: true` returns whole passages (3/max 10); an exact `transcriptId` defaults to full text. Continue with `nextOffset`
- A business search covers up to 20 debate subjects; more fails as `business_scope_too_broad`, so page `chparl_get_business` section `subjects` and pass one `subjectId`. `found` marks exact-ID misses, `scopeFound` a missing business

---

### `chparl_search_members` <sub>tool</sub>

- `query` (first, last, or official name substring), `membership` (`current` default, `former`, `all`), `council` (`N`/`S` or the German, French, or Italian council name), `cantonId`, `partyId`, `groupId`. Default 20/max 100, `nextOffset`
- Rows are **MemberCouncil affiliation records**, not deduplicated people. Their `personNumber`, which need not equal `Person.ID`, feeds `chparl_get_member`, `chparl_get_votes`, and `chparl_search_transcripts`

---

### `chparl_get_member` <sub>tool</sub>

- Requires `personNumber`. `overview` (default) returns identity and every MemberCouncil affiliation, unpaged; a miss returns `found: false`
- `council_terms`, `committees`, and `interests` page independently, default 20/max 100 with `nextOffset`. Committee rows are published memberships, not a historical ledger. A missing `paid` flag means unknown, and empty interests do not establish the absence of conflicts

---

### `chparl_list_reference` <sub>tool</sub>

- Static topics `identifiers`, `coverage`, `languages`, and `statuses` (the official vocabulary effective 1 July 2023, each code tagged `era: "legacy" | "current"`). Live dictionaries `business_types`, `councils`, `cantons`, `parties`, `groups`, `committees`, and `sessions`
- Default 50/max 100, `nextOffset`. Only `sessions` accepts dates: `dateFrom` bounds the start and `dateTo` the end, inclusively

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Swiss Parliament-specific:

- Keyless, read-only access to business, procedural relationships, Nationalrat roll calls, debate passages, members, and declared interests
- `de` (default), `fr`, and `it` metadata with no translation fallback; Italian completeness is not established. Bulletin text stays in the language the speaker used
- Published text and HTML are returned unchanged, with an index of their links and images carrying absolute HTTP(S) URLs where the source supplies one
- One 45-second deadline per complete workflow, covering joins and retries

Agent-friendly output:

- Provenance on every result: attribution to Parlamentsdienste der Bundesversammlung, plus the source URL and retrieval time of each upstream response
- Whole-record pages: replies fit a 24,000-byte budget by returning fewer records, never shorter fields, and report `returnedCount`, `hasMore`, `totalCount` when known, and the continuation
- One record on both surfaces: `content[]` carries every `structuredContent` field, with multiline text and HTML in JSON-encoded fenced blocks that decode back losslessly
- Unknown stays unknown: absent source values are omitted rather than defaulted, empty results carry next-step guidance, and failures carry typed reasons such as `upstream_rate_limited`

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http switzerland-parliament-mcp-server https://switzerland-parliament.caseyjhand.com/mcp
```

Or run it locally:

```sh
claude mcp add switzerland-parliament-mcp-server -- npx -y @cyanheads/switzerland-parliament-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "switzerland-parliament-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/switzerland-parliament-mcp-server"]
    }
  }
}
```

For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

No server-specific environment variables are required.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the common framework overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).

```sh
git clone https://github.com/cyanheads/switzerland-parliament-mcp-server.git
cd switzerland-parliament-mcp-server
bun install
cp .env.example .env
```

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/switzerland-parliament-mcp-server:latest
```

The image defaults to HTTP transport, stateless sessions, and logs to `/var/log/switzerland-parliament-mcp-server`. For stdio, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/switzerland-parliament-mcp-server:latest"]`. Build locally with `docker build -t switzerland-parliament-mcp-server .`; `--build-arg OTEL_ENABLED=false` omits OpenTelemetry peers.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point and service setup; seven tools, no resources or prompts. |
| `src/mcp-server/tools` | Tool definitions, shared lossless rendering, and whole-record page fitting. |
| `src/services/parliament` | OData client, workflow deadlines, domain schemas and services, provenance, and reference snapshots. |
| `tests/` | Unit and integration tests, mirroring the `src/` structure. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for logging, `ctx.state` for storage
- Register new tools and resources in the `createApp()` arrays in `src/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.

