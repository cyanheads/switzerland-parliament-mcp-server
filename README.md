<div align="center">
  <h1>@cyanheads/switzerland-parliament-mcp-server</h1>
  <p><b>Search Swiss parliamentary business, votes, debates, members, and declared interests via MCP. STDIO or Streamable HTTP.</b>
  <div>7 Tools • 0 Resources • 0 Prompts</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/switzerland-parliament-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/switzerland-parliament-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/switzerland-parliament-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/switzerland-parliament-mcp-server/releases/latest/download/switzerland-parliament-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=switzerland-parliament-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvc3dpdHplcmxhbmQtcGFybGlhbWVudC1tY3Atc2VydmVyIl19) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22switzerland-parliament-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fswitzerland-parliament-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

Swiss Federal Assembly records from Curia Vista and the Amtliches Bulletin. Find parliamentary business, read its original texts and procedural history, follow the debate in either council, inspect Nationalrat roll calls, and look up members and declared interests. Uses the [public OData service](https://ws.parlament.ch/odata.svc/) without an API key; runs as a stdio process or a local Streamable HTTP server.

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

- `query` matches one title substring; `author` matches the published submitter label, not every co-signatory. Optional `typeId`, `statusId`, `sessionId`, `committeeId`, `submittedFrom`, and `submittedTo` refine it; dates are inclusive and session means submission session
- Newest canonical business IDs first, default 20/max 100 per page. Continue with `nextCursor` and unchanged filters; a mismatched cursor fails as `invalid_cursor`
- Committee searches examine role candidates and return distinct businesses, so pages can be short and omit `totalCount`. Without a committee filter, `totalCount` is the original-filter business count when supplied
- Pass a returned `businessId` to `chparl_get_business`, `chparl_get_votes`, or `chparl_search_transcripts`

---

### `chparl_get_business` <sub>tool</sub>

- Accepts a canonical eight-digit `businessId` or exact published short number, such as `99.1234`; ambiguous short numbers fail as `ambiguous_business_number`. `overview` (default) returns metadata and `availableTextFields` with UTF-8 sizes
- `section: "texts"` returns `textDocument.kind: "full" | "outline"`. Automatic disclosure becomes a field-size outline when several populated fields make the complete result reach 24,000 bytes; explicit `textFields` selections or one populated field return whole, even above that threshold
- Select `description`, `initialSituation`, `proceedings`, `draftText`, `submittedText`, `reasonText`, `documentationText`, `motionText`, `federalCouncilResponseText`, or `federalCouncilProposalText`. Unpublished selections appear in `unavailableTextFields`; original HTML, whitespace, and line endings stay intact
- `status_history`, `bills`, `related_business`, `preconsultations`, and `subjects` page independently: default 20/max 100 with `nextOffset`. Paging belongs only to these sections; `textFields` belongs only to `texts`
- Missing business returns `found: false`. Linked bills are parliamentary records, not enacted-law text; use `subjects` to narrow a large debate

---

### `chparl_get_votes` <sub>tool</sub>

- Start with `mode: "votes"` and `businessId` for roll-call metadata, default 10/max 50 per page. Then use a returned `voteId` with `mode: "members"` (default 50/max 100, optional `personNumber`) or `mode: "groups"` (complete, unpaged)
- Member roll calls cover the **Nationalrat from the 2003 winter session**. Ständerat member decisions are unavailable here; an empty result does not establish that no vote occurred
- `members` returns `decisionCounts.scope: "page"`; `groups` reads all published member rows before returning `scope: "vote"`, `complete: true`, and group totals. When member data is unavailable, complete zero-vote totals are not inferred
- Counts use affiliations published on vote rows, not current memberships. Original decision labels, unknown codes, and missing decisions remain visible; documented codes include 1 yes, 2 no, 3 abstention, 6 excused under Art. 57 para. 4, and 7 president does not vote
- Continue paged modes with `nextOffset`; `found: false` distinguishes a missing business or selected vote from an empty child collection

---

### `chparl_search_transcripts` <sub>tool</sub>

- Bulletin coverage begins with the **1999 winter session** and includes both councils. Supply at least `businessId`, `subjectId`, `personNumber`, `sessionId`, a date bound, or exact `transcriptId`; council alone is insufficient
- `query` searches one original-text substring and additionally requires `sessionId` or a closed `dateFrom`/`dateTo` range of at most **31 inclusive calendar days**
- Searches return metadata and `textSizeBytes` by default, default 20/max 100 per page. `includeText: true` returns whole passages, default 3/max 10. Continue with `nextOffset` and unchanged filters
- Exact `transcriptId` defaults to full text and accepts only `language` and `includeText` alongside it; explicit `includeText: false` returns metadata. Transcript and subject IDs stay decimal strings
- `businessId` and `subjectId` are mutually exclusive. A business search covers every associated subject up to 20; `business_scope_too_broad` directs larger debates through `chparl_get_business` section `subjects`, then one `subjectId`
- `metadataLanguage` never translates the speaker's text; absent `languageOfText` stays unknown. `found` identifies exact-ID misses; `scopeFound` distinguishes a missing business from one with no passages

---

### `chparl_search_members` <sub>tool</sub>

- `query` matches a published first, last, or official name substring. `membership` is `current` (default), `former`, or `all`; optional `council`, `cantonId`, `partyId`, and `groupId` refine it
- Results are **MemberCouncil affiliation records**, not deduplicated people. Default 20/max 100 per page, continued with `nextOffset`
- Use `personNumber` for profiles and member-decision filters; it need not equal `Person.ID`. Council selectors accept `N`/`S` and the exact German, French, or Italian council names

---

### `chparl_get_member` <sub>tool</sub>

- Requires `personNumber`. `overview` (default) returns parliamentary identity and every base MemberCouncil affiliation without paging
- `council_terms`, `committees`, and `interests` page independently, default 20/max 100 with `nextOffset`; omit paging for `overview`
- Committee rows are published memberships, not a complete historical committee ledger. A missing `paid` flag means unknown, and empty interests do not establish absence of conflicts of interest
- Missing identity returns `found: false` with discovery guidance

---

### `chparl_list_reference` <sub>tool</sub>

- Topics: `identifiers`, `coverage`, `languages`, `business_types`, `statuses`, `councils`, `cantons`, `parties`, `groups`, `committees`, and `sessions`. Use returned IDs in the other tools
- Default 50/max 100 per page, continued with `nextOffset`. Only `sessions` accepts dates: `dateFrom` bounds session start, `dateTo` bounds session end, both inclusively
- `statuses` is the official legacy/current vocabulary snapshot effective 1 July 2023, carrying `era`; unknown live codes remain visible. Identifier, coverage, and language explanations are static; other dictionaries are live

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

Swiss Parliament-specific:

- Keyless, read-only access to business, procedural relationships, Nationalrat roll calls, debate passages, members, and declared interests
- `de` (default), `fr`, and `it` metadata without translation fallback. Completeness of every Italian field is not established; English and Romansh translations are not offered
- Published text and HTML remain unchanged; an accompanying link/image reference index preserves original attributes and supplies clickable absolute HTTP(S) URLs where available
- One 45-second deadline per complete workflow; narrow text scopes help with slow upstream searches

Agent-friendly output:

- Both `content[]` and `structuredContent` carry the same records, provenance, filters, notices, and paging information. Multiline text and HTML are JSON-encoded in fenced text blocks for lossless recovery
- Collections report `returnedCount`, `effectiveLimit` where paged, `hasMore`, and a continuation when available; `totalCount` appears only when known. Offset pages can change as live data updates
- Collection replies fit whole records around a 24,000-byte result budget; fitting can shorten a page, never a returned field. An indivisible oversized record is returned whole with a notice; text selections, member overviews, and group totals also remain complete
- Missing values stay unknown; empty results carry guidance, and rate limits return `upstream_rate_limited` with retry guidance

## Getting started

### Self-Hosted / Local

Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "switzerland-parliament-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/switzerland-parliament-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "switzerland-parliament-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/switzerland-parliament-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "switzerland-parliament-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/switzerland-parliament-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key or account is required.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/switzerland-parliament-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd switzerland-parliament-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# Optional: edit framework transport, auth, logging, or telemetry settings
```

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

