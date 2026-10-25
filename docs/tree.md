# switzerland-parliament-mcp-server - Directory Structure

Generated on: 2026-10-25 13:38:32

```text
switzerland-parliament-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── prune-musl-packages.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── mcp-server/
│   │   ├── prompts/
│   │   │   └── definitions/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── get-business.tool.ts
│   │       │   ├── get-member.tool.ts
│   │       │   ├── get-votes.tool.ts
│   │       │   ├── list-reference.tool.ts
│   │       │   ├── search-business.tool.ts
│   │       │   ├── search-members.tool.ts
│   │       │   └── search-transcripts.tool.ts
│   │       └── parliament-format.ts
│   ├── services/
│   │   └── parliament/
│   │       ├── business-cursor.ts
│   │       ├── business-model.ts
│   │       ├── business-relations.ts
│   │       ├── business-service.ts
│   │       ├── business-text.ts
│   │       ├── member-model.ts
│   │       ├── member-service.ts
│   │       ├── normalization.ts
│   │       ├── odata-client.ts
│   │       ├── parliament-service.ts
│   │       ├── provenance.ts
│   │       ├── reference-model.ts
│   │       ├── static-reference.ts
│   │       ├── status-catalog.ts
│   │       ├── transcript-model.ts
│   │       ├── transcript-service.ts
│   │       ├── vote-model.ts
│   │       ├── vote-service.ts
│   │       └── workflow.ts
│   └── index.ts
├── tests/
│   ├── fuzz/
│   ├── helpers/
│   │   ├── business.ts
│   │   ├── member-fixtures.ts
│   │   ├── parliament.ts
│   │   ├── transcript-fixtures.ts
│   │   └── vote-fixtures.ts
│   ├── integration/
│   ├── mcp-server/
│   │   └── tools/
│   │       ├── business-detail.test.ts
│   │       ├── business-search.test.ts
│   │       ├── list-reference.test.ts
│   │       ├── member-tools.test.ts
│   │       ├── parliament-format.test.ts
│   │       ├── transcripts.test.ts
│   │       └── votes.test.ts
│   ├── prompts/
│   ├── resources/
│   ├── services/
│   │   └── parliament/
│   │       ├── business-text.test.ts
│   │       ├── member-service.test.ts
│   │       ├── normalization.test.ts
│   │       ├── odata-client.test.ts
│   │       ├── reference.test.ts
│   │       ├── transcript-service.test.ts
│   │       ├── vote-service.test.ts
│   │       └── workflow.test.ts
│   ├── smoke/
│   └── tools/
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
