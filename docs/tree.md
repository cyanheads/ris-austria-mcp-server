# ris-austria-mcp-server - Directory Structure

Generated on: 2026-10-24 09:06:46

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
│   ├── 0.1.x/
│   ├── 0.2.x/
│   ├── 0.3.x/
│   ├── 0.4.x/
│   ├── 0.5.x/
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
│   ├── config/
│   │   └── server-config.test.ts
│   ├── fixtures/
│   │   └── ris/
│   │       ├── document-begut-nutzdaten.xml
│   │       ├── document-bgblauth-ordinals.html
│   │       ├── document-brkons-absatz-lists.html
│   │       ├── document-brkons-sr-only.html
│   │       ├── document-regv-artikel-sections.html
│   │       ├── error-500-fulltext-landesrecht.json
│   │       ├── error-500-fulltext-wildcard.json
│   │       ├── error-500-page-overflow.json
│   │       ├── error-500-unknown-application.json
│   │       ├── error-500-vbl-invalid-state.json
│   │       ├── error-client.json
│   │       ├── history-brkons.json
│   │       ├── history-gr.json
│   │       ├── history-justiz.json
│   │       ├── history-lrkons.json
│   │       ├── history-vwgh.json
│   │       ├── history-with-deleted.json
│   │       ├── search-avn.json
│   │       ├── search-avsv.json
│   │       ├── search-begut-ogd.json
│   │       ├── search-begut-review-window.json
│   │       ├── search-begut.json
│   │       ├── search-bgblalt-1-1918.json
│   │       ├── search-bgblalt-1-1920.json
│   │       ├── search-bgblalt-1-1938.json
│   │       ├── search-bgblalt.json
│   │       ├── search-bgblauth-2004-01.json
│   │       ├── search-bgblauth-24-2018-part1.json
│   │       ├── search-bgblauth-24-2018-part2.json
│   │       ├── search-bgblauth-50-2025-part1.json
│   │       ├── search-bgblauth-50-2025.json
│   │       ├── search-bgblauth-celex.json
│   │       ├── search-bgblpdf-1-1945.json
│   │       ├── search-bgblpdf-194-1961.json
│   │       ├── search-bgblpdf-2003-12.json
│   │       ├── search-bgblpdf-50-1999.json
│   │       ├── search-bgblpdf-celex.json
│   │       ├── search-brkons-bvg-article-10.json
│   │       ├── search-brkons-celex.json
│   │       ├── search-brkons-dsg-section-6.json
│   │       ├── search-brkons-estg-section-2.json
│   │       ├── search-brkons-kfg-section-1.json
│   │       ├── search-brkons-kschg-section-5.json
│   │       ├── search-brkons-multi.json
│   │       ├── search-brkons-praemien-section-2.json
│   │       ├── search-brkons-ugb-section-1.json
│   │       ├── search-bvb.json
│   │       ├── search-bvwg-w213-2337298-1.json
│   │       ├── search-dsk-gz-trailing-space.json
│   │       ├── search-ecli-bvwg-w213-2337298-1.json
│   │       ├── search-ecli-ogh-6ob236-23h.json
│   │       ├── search-ecli-vfgh-g13-2025.json
│   │       ├── search-ecli-vwgh-ra-2025-07-0289.json
│   │       ├── search-erlaesse.json
│   │       ├── search-erv-translations.json
│   │       ├── search-gra.json
│   │       ├── search-gz-array.json
│   │       ├── search-justiz-1ob948-52-both.json
│   │       ├── search-justiz-6ob236-23h-both.json
│   │       ├── search-justiz-gz-joined.json
│   │       ├── search-kmger.json
│   │       ├── search-lgblauth.json
│   │       ├── search-lgblno.json
│   │       ├── search-lrkons-abkuerzung.json
│   │       ├── search-lrkons-bo-wien-section-1.json
│   │       ├── search-lvwg-tirol.json
│   │       ├── search-mrp.json
│   │       ├── search-normenliste-dsg.json
│   │       ├── search-pruefgewo.json
│   │       ├── search-regv-abkuerzung.json
│   │       ├── search-regv.json
│   │       ├── search-spg.json
│   │       ├── search-upts-single.json
│   │       ├── search-vbl.json
│   │       ├── search-vfgh-g13-2025-both.json
│   │       ├── search-vfgh-gz-joined.json
│   │       ├── search-vfgh-vfslg-19632-both.json
│   │       ├── search-vfgh.json
│   │       ├── search-vwgh-collection-span.json
│   │       ├── search-vwgh-ra-2025-07-0289-both.json
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
│       ├── _wire.ts
│       ├── framework-contract.test.ts
│       ├── issuer-and-recency-filters.test.ts
│       ├── paging.test.ts
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
