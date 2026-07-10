<div align="center">
  <h1>@cyanheads/ris-austria-mcp-server</h1>
  <p><b>Search Austrian law at every level — consolidated federal, state & municipal norms, court decisions, the authentic gazettes, the lawmaking pipeline, and ministerial decrees — from the official RIS via MCP. Keyless. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.6-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ris-austria-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/ris-austria-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/ris-austria-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/ris-austria-mcp-server/releases/latest/download/ris-austria-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=ris-austria-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcmlzLWF1c3RyaWEtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22ris-austria-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fris-austria-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://ris-austria.caseyjhand.com/mcp](https://ris-austria.caseyjhand.com/mcp)

</div>

---

[RIS](https://www.ris.bka.gv.at/) (Rechtsinformationssystem des Bundes) is the Austrian government's official legal database: consolidated federal, state, and municipal law, case law across every Austrian court and tribunal, the authentic gazettes at every level of government (whose promulgated text is binding under Austrian law), the pre-parliamentary lawmaking pipeline, and ministerial decrees. This server wraps the keyless RIS OGD REST API (v2.6, CC BY 4.0) for MCP agents — the **entire** OGD application surface, back to the Reichsgesetzblatt of 1848. It labels every document's binding status and never presents non-authentic text as the authentic wording.

## Tools

Nine tools split by document class, plus a deterministic citation resolver, document retrieval, a change feed, and an offline vocabulary reference:

| Tool | Description |
|:---|:---|
| `ris_search_legislation` | Search consolidated federal, state, and municipal law — one document per §/Artikel/Anlage — filtered to the version in force on a given date (defaults to today). Also serves English translations of selected laws. |
| `ris_search_case_law` | Search Austrian case law (Judikatur) in one court or tribunal per call — VfGH, VwGH, ordinary courts, BVwG, LVwG, DSB, the party-transparency senate, and ten more. |
| `ris_search_gazette` | Browse the promulgation record at every level — federal (three era tiers back to 1848, auto-routed), state law & ordinance gazettes, district, and municipal — the compliance-monitoring surface. |
| `ris_search_drafts` | Search the federal lawmaking pipeline: ministerial drafts in public review (Begutachtungsentwürfe) and government bills (Regierungsvorlagen). |
| `ris_search_announcements` | Search sectoral official gazettes and executive documents: social-insurance notices, veterinary notices, court rules, trade-exam regulations, health structure plans, ministerial decrees, council-of-ministers minutes. |
| `ris_lookup_citation` | Resolve one Austrian legal citation ("§ 6 DSG", "BGBl. I Nr. 165/1999", "RGBl. Nr. 189/1902", a Geschäftszahl, "VfSlg 19.632/2012") deterministically to its canonical document. |
| `ris_get_document` | Fetch one document's full text as markdown/HTML/XML, or its export URLs, with binding-status labeling and the authentic PDF wherever one exists. |
| `ris_track_changes` | Exact-dated change feed per application — every document added or changed in a window, deletions included. The delta-sync primitive. |
| `ris_list_reference` | Ground the domain vocabulary offline — applications and coverage windows, court codes, Bundesländer, decision kinds, ministries, district authorities, gazette eras and parts, citation formats, search syntax. |

### `ris_search_legislation`

Search consolidated law (BrKons federal, LrKons state, Gr municipal) with in-force-date handling correct by default.

- Full-text `query` with RIS boolean grammar (`UND`/`ODER`/`NICHT` or `AND`/`OR`/`NOT`, parentheses, quoted phrases) and `title` matching title, short title, or abbreviation ("DSG", "ABGB")
- `scope` routes federal or one of the nine Bundesländer; `municipality` narrows a state scope to municipal law (selected norms, six Bundesländer); `language: english` serves the Erv collection of selected English translations
- **`in_force_as_of` defaults to today** — omitting the date upstream silently searches all historical versions; `include_all_versions` is the explicit opt-in, and the applied date is echoed in every response
- Force-window filters (`entered_force_from/to`, `left_force_from/to`) track provisions entering or leaving force in a date range — new-law and repeal monitoring
- Section-range filtering (`section_from`/`section_to`/`section_type` — §, Artikel, Anlage), law-level grouping via `law_id` (Gesetzesnummer), Systematik `index`, `changed_since` windows
- Output per document: section label, in-force date, ELI, parsed CELEX references (the EU-transposition hook), and export URLs (XML/HTML/PDF/RTF)

---

### `ris_search_case_law`

Search decisions and headnotes across Austria's courts and tribunals — 17 applications.

- One application per call (`court`, required): `vfgh`, `vwgh`, `justiz`, `bvwg`, `lvwg`, `dsk`, `upts` (party-transparency senate), plus ten historical/specialized tribunals — cross-court research fans out one call per court
- Filter by cited provision (`norm` — "DSG §1", "DSGVO Art32"), exact case number (`case_number`, Geschäftszahl), decision date range, decision kind (Erkenntnis/Beschluss/…), and full-text query
- `decision_type` targets headnotes (Rechtssätze), full decision texts, or both
- Court-conditional filters: `issuing_body` (dsk/dok/pvak/verg), `court_name`, `legal_area`, `subject_area` (justiz — "Datenschutzrecht", "Insolvenzrecht"), `state` (lvwg/uvs), `collection_number` (VfSlg/VwSlg cites), `party` (upts), commission/senate/discrimination ground (gbk), media statute (bks)
- Output per decision: case numbers, decision date, ECLI, cited norms, keywords, the guiding principle (Leitsatz) on headnote documents, and headnote/decision URLs

---

### `ris_search_gazette`

Browse the promulgation record at every level of government — what `ris_lookup_citation` (point lookup) can't express.

- `scope`: federal, one of the nine Bundesländer, `district` (Bezirksverwaltungsbehörden), or `municipal` (authentic municipal promulgations)
- **Federal history is one logical series, auto-routed across three era tiers**: BgblAuth (2004+, authentic), BgblPdf (Staats- und Bundesgesetzblatt 1945–2003), BgblAlt (Reichs-, Staats- und Bundesgesetzblatt 1848–1940, metadata + ÖNB-hosted scans) — with a notice naming which tier served
- Filter by publication date range, gazette `part` (BGBl. I/II/III, or `pre_1997` for the partless era), document `type`, issuing ministry, district authority, or municipality
- State scopes serve the authentic Landesgesetzblätter by default; `series: ordinance_gazette` switches to the Verordnungsblätter, `include_non_authentic` adds the historical non-authentic gazettes
- Point lookup by gazette number ("BGBl. II Nr. 171/2026" or "171/2026")
- Every record carries a binding label (`authentic`, `historical_record`, or `consolidated_informational`) and the amtssigniert PDF URL when present; the metadata-only 1848–1940 gazettes link to their ÖNB ALEX scan

---

### `ris_search_drafts`

Watch federal law before it becomes law.

- `stage: review_drafts` — ministerial drafts in public review (Begutachtungsentwürfe), including "what is in review **right now**" via `in_review_on`
- `stage: government_bills` — bills adopted by the council of ministers (Regierungsvorlagen, 2004+), filtered by adoption date
- `ministry` accepts the abbreviation ("BMF") — the server expands it to RIS's exact designation
- Output includes review deadlines and council adoption dates

---

### `ris_search_announcements`

Sectoral official gazettes and executive documents — seven collections, five of them legally binding authentic publications.

- `collection`: `social_insurance` (Avsv), `veterinary` (Avn), `court_rules` (KmGer), `trade_exam_rules` (PruefGewO), `health_structure_plans` (Spg — ÖSG/RSG), `ministerial_decrees` (Erlässe), `council_minutes` (Ministerratsprotokolle)
- Collection-aware filters: issue numbers, issuers (insurance carriers, ministries), cited norm ("decrees citing the DSG"), in-force date for the consolidated collections, plan type/state for health plans, session number/legislature for council minutes
- Binding labels per collection: `authentic`, `administrative_directive` (decrees bind the administration, not citizens), or `preparatory` (council minutes)

---

### `ris_lookup_citation`

Citation-first resolution — how Austrian legal work actually starts.

- Parses and routes four citation kinds: norm cites ("§ 6 DSG", "Art 10 B-VG"), gazette numbers across all three federal eras plus LGBl ("BGBl. I Nr. 165/1999", "BGBl. Nr. 194/1961", "RGBl. Nr. 189/1902"), case numbers ("Ra 2019/22/0184", "2025-0.934.677", "6Ob56/25k"), and collection numbers ("VfSlg 19.632/2012")
- Deterministic upstream filters (section + title, per-era number params, Geschäftszahl, Sammlungsnummer) — no keyword-search fuzziness
- Returns `found: false` with structured guidance instead of throwing when nothing resolves
- `court` and `state` hints short-circuit ambiguous formats

---

### `ris_get_document`

Read and export a single document.

- Addresses documents by `document_number` + `application` (from any search/lookup result) or a passed-through `ris.bka.gv.at` document URL (host and path allowlisted)
- `format`: `markdown` (default, boilerplate stripped), raw `html`, RIS `xml`, or `urls_only`
- Binding status on every response: `authentic` (with amtssigniert PDF URL), `consolidated_informational`, `historical_record`, `decision`, `preparatory`, `administrative_directive`, or `translation` — non-authentic text is never presented as the binding text
- Format availability is explicit: applications that publish only the signed PDF (district/municipal promulgations, court rules) or only scans (1848–1940 gazettes, ÖNB-hosted) return a `format_unavailable` notice with the usable URLs instead of failing
- Oversized markdown returns a retrievable §/Artikel/Anlage section outline (`kind: outline`) instead of truncating — re-call with `sections:[…]` to pull just the sections you need
- Returns content, not fresh metadata — the upstream API has no document-by-number search, so document numbers come from a prior search or lookup result

---

### `ris_track_changes`

Exact-dated per-application change feed (the RIS History controller).

- `application` + `changed_from`/`changed_to`: every document added or changed in the window — 1,400+ changes in a typical two-week federal-law window
- `include_deleted` surfaces removals — the only RIS surface that can
- Coarser alternative: the search tools' `changed_since` interval filters

## Resource

| Type | Name | Description |
|:---|:---|:---|
| Resource | `ris://document/{application}/{documentNumber}` | Markdown text of one RIS document — injectable twin of `ris_get_document` |

All resource data is also reachable via tools — clients without resource support use `ris_get_document`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool and resource definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth (`none`, `jwt`, `oauth`)
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

RIS-specific:

- **The full RIS OGD surface** — all 39 applications across every controller: consolidated law (federal/state/municipal), authentic gazettes at four levels of government, three federal gazette era tiers back to 1848, 17 court/tribunal applications, the lawmaking pipeline, sectoral gazettes, ministerial decrees, English translations, and the per-application change feed
- Strict parameter allowlist — RIS silently ignores unknown query params (a typo returns plausible but unfiltered results), so only live-confirmed spellings are ever sent upstream
- Normalizer for RIS's JSON-serialized-XML envelope: object-or-array coercion, in-band error detection, six per-controller metadata classes, `<br/>` cleanup, CELEX reference parsing, ministry-abbreviation expansion
- English tool surface over RIS's German API — Austrian legal terms (Geschäftszahl, Rechtssatz, Bundesgesetzblatt) kept as domain vocabulary and glossed in descriptions

Agent-friendly output:

- No dead ends — error recovery hints, zero-hit notices, format-unavailable notices, and `found: false` guidance each name the concrete next call (`ris_list_reference` topic, the right search tool, `ris_lookup_citation`), never a bare "check your input"
- Zero hits are success plus a composed notice, never an error; conditional-parameter misuse (a court-specific filter with the wrong court, `part` outside federal scope, a collection filter on the wrong collection, bad addressing) is caught locally before any upstream call
- Applied-filter echo — the `in_force_as_of` default is never invisible to the calling agent
- Structured no-resolve results (`found: false` + guidance) instead of throws on citation lookup
- Upstream schema-validation messages passed through — RIS enumerates valid values, which lets agents self-correct
- Oversized documents return a retrievable section outline, never a silent cut — re-call with the chosen `sections` for selective retrieval

## Localization

Tool and parameter descriptions are English-only today. German (`de-AT`) descriptions are planned, pending opt-in localization support in the framework ([cyanheads/mcp-ts-core#259](https://github.com/cyanheads/mcp-ts-core/issues/259)); the English surface stays the default and fallback.

## Getting started

The one-click badges above (Claude Desktop, Cursor, VS Code) are the fastest path. To configure a client manually, the server runs straight from npm — no clone or build required.

### Public Hosted Instance

A public instance is available at `https://ris-austria.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "ris-austria-mcp-server": {
      "type": "streamable-http",
      "url": "https://ris-austria.caseyjhand.com/mcp"
    }
  }
}
```

### Prerequisites

- [Bun v1.3](https://bun.sh/) or higher, or Node.js v24+ (needed for `npx`/`bunx`)
- No API key — the RIS OGD API is keyless

### Install from npm (recommended)

Add the server to your MCP client configuration:

```json
{
  "mcpServers": {
    "ris-austria-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/ris-austria-mcp-server"]
    }
  }
}
```

`bunx @cyanheads/ris-austria-mcp-server` works the same way if you prefer Bun. Add any [configuration](#configuration) variables under an `"env"` key.

### Install from source

For local development or to run a pinned build:

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/ris-austria-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd ris-austria-mcp-server
```

3. **Install dependencies and build:**

```sh
bun install
bun run rebuild
```

4. **Add to your MCP client configuration file:**

```json
{
  "mcpServers": {
    "ris-austria-mcp-server": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/ris-austria-mcp-server/dist/index.js"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `RIS_API_BASE_URL` | RIS OGD REST API base URL. | `https://data.bka.gv.at/ris/api/v2.6` |
| `RIS_CONTENT_BASE_URL` | Document content host (also the allowlist host for `document_url` input). | `https://www.ris.bka.gv.at` |
| `RIS_CONTACT` | Contact string appended to the User-Agent (RIS netiquette asks integrators to be identifiable). | none |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, …). | `info` |
| `STORAGE_PROVIDER_TYPE` | Storage backend. | `in-memory` |
| `OTEL_ENABLED` | Enable OpenTelemetry instrumentation. | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and resources. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `docs/design.md` | Settled v1 design — tool surface, service spec, live-confirmed RIS API reference. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `skills/` | Framework skills synced from `@cyanheads/mcp-ts-core`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via `createApp()` in `src/index.ts`
- Wrap the RIS API: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.

RIS OGD data is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.de) (attribution: RIS, Bundeskanzleramt Österreich). The underlying legal texts are copyright-free official works. Only the authentic, amtssignierte gazette wording is legally binding — consolidated RIS text is informational.
