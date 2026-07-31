# ris-austria-mcp-server - Directory Structure

Generated on: 2026-07-31 11:33:54

```text
ris-austria-mcp-server/
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
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   └── template.md
├── docs/
│   └── design.md
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
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── skills/
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
├── src/
│   ├── config/
│   │   └── server-config.ts
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       └── ris-document.resource.ts
│   │   └── tools/
│   │       └── definitions/
│   │           ├── _shared.ts
│   │           ├── ris-get-document.tool.ts
│   │           ├── ris-list-reference.tool.ts
│   │           ├── ris-lookup-citation.tool.ts
│   │           ├── ris-search-announcements.tool.ts
│   │           ├── ris-search-case-law.tool.ts
│   │           ├── ris-search-drafts.tool.ts
│   │           ├── ris-search-gazette.tool.ts
│   │           ├── ris-search-legislation.tool.ts
│   │           └── ris-track-changes.tool.ts
│   ├── services/
│   │   └── ris/
│   │       ├── reference/
│   │       │   ├── applications.ts
│   │       │   ├── changed-since-intervals.ts
│   │       │   ├── citation-formats.ts
│   │       │   ├── collections.ts
│   │       │   ├── courts.ts
│   │       │   ├── decision-kinds.ts
│   │       │   ├── decision-types.ts
│   │       │   ├── district-authorities.ts
│   │       │   ├── gazette-parts.ts
│   │       │   ├── index.ts
│   │       │   ├── issuing-bodies.ts
│   │       │   ├── justiz-subject-areas.ts
│   │       │   ├── law-types.ts
│   │       │   ├── ministries.ts
│   │       │   ├── search-syntax.ts
│   │       │   ├── section-types.ts
│   │       │   ├── stages.ts
│   │       │   └── states.ts
│   │       ├── normalizer.ts
│   │       ├── request-builder.ts
│   │       ├── ris-service.ts
│   │       └── types.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   └── ris/
│   │       ├── document-brkons-sr-only.html
│   │       ├── document-regv-artikel-sections.html
│   │       ├── error-500-fulltext-landesrecht.json
│   │       ├── error-500-fulltext-wildcard.json
│   │       ├── error-500-page-overflow.json
│   │       ├── error-500-unknown-application.json
│   │       ├── error-500-vbl-invalid-state.json
│   │       ├── error-client.json
│   │       ├── history-with-deleted.json
│   │       ├── search-avsv.json
│   │       ├── search-begut.json
│   │       ├── search-bgblalt.json
│   │       ├── search-bgblauth-2004-01.json
│   │       ├── search-bgblpdf-2003-12.json
│   │       ├── search-brkons-celex.json
│   │       ├── search-brkons-multi.json
│   │       ├── search-bvb.json
│   │       ├── search-erv-translations.json
│   │       ├── search-gra.json
│   │       ├── search-gz-array.json
│   │       ├── search-lgblauth.json
│   │       ├── search-lvwg-tirol.json
│   │       ├── search-mrp.json
│   │       ├── search-normenliste-dsg.json
│   │       ├── search-regv.json
│   │       ├── search-upts-single.json
│   │       ├── search-vfgh.json
│   │       ├── search-vwgh-collection-span.json
│   │       └── search-zero-hits.json
│   ├── resources/
│   │   └── ris-document.resource.test.ts
│   ├── services/
│   │   └── ris/
│   │       ├── normalizer.test.ts
│   │       ├── reference-examples.test.ts
│   │       ├── request-builder.test.ts
│   │       └── ris-service.test.ts
│   └── tools/
│       ├── _shared.test.ts
│       ├── ris-get-document.tool.test.ts
│       ├── ris-list-reference.tool.test.ts
│       ├── ris-lookup-citation.tool.test.ts
│       ├── ris-search-announcements.tool.test.ts
│       ├── ris-search-case-law.tool.test.ts
│       ├── ris-search-drafts.tool.test.ts
│       ├── ris-search-gazette.tool.test.ts
│       ├── ris-search-legislation.tool.test.ts
│       └── ris-track-changes.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
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
