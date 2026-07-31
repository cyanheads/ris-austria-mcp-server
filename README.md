<div align="center">
  <h1>@cyanheads/ris-austria-mcp-server</h1>
  <p><b>Search Austrian consolidated federal & state law, court decisions, and the authentic Bundesgesetzblatt from the official RIS via MCP. Keyless. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.3.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ris-austria-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/ris-austria-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/ris-austria-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/ris-austria-mcp-server/releases/latest/download/ris-austria-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=ris-austria-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcmlzLWF1c3RyaWEtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22ris-austria-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fris-austria-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://ris-austria.caseyjhand.com/mcp](https://ris-austria.caseyjhand.com/mcp)

</div>

---

[RIS](https://www.ris.bka.gv.at/) (Rechtsinformationssystem des Bundes) is the Austrian government's official legal database: consolidated federal, state, and municipal law, case law from every Austrian court and tribunal, the authentic gazettes whose promulgated text is binding under Austrian law, the pre-parliamentary lawmaking pipeline, and ministerial decrees.

This server wraps the keyless RIS OGD REST API (v2.6, CC BY 4.0) for MCP agents, covering all 39 OGD applications and reaching back to the Reichsgesetzblatt of 1848. Every response labels the document's binding status, since only the amtssignierte gazette wording is legally binding.

## Tools

Five search tools split by document class, plus a citation resolver, document retrieval, a change feed, and an offline vocabulary reference:

| Tool | Description |
|:---|:---|
| `ris_search_legislation` | Search consolidated federal, state, and municipal law, one document per §/Artikel/Anlage, filtered to the version in force on a given date (defaults to today). Also serves English translations of selected laws. |
| `ris_search_case_law` | Search Austrian case law (Judikatur), one court or tribunal per call: VfGH, VwGH, ordinary courts, BVwG, LVwG, DSB, the party-transparency senate, and ten more. |
| `ris_search_gazette` | Browse the promulgation record at every level of government: federal (three era tiers back to 1848, auto-routed), state law and ordinance gazettes, district, and municipal. |
| `ris_search_drafts` | Search the federal lawmaking pipeline: ministerial drafts in public review (Begutachtungsentwürfe) and government bills (Regierungsvorlagen). |
| `ris_search_announcements` | Search sectoral official gazettes and executive documents: social-insurance notices, veterinary notices, court rules, trade-exam regulations, health structure plans, ministerial decrees, council-of-ministers minutes. |
| `ris_lookup_citation` | Resolve one Austrian legal citation ("§ 6 DSG", "BGBl. I Nr. 165/1999", "RGBl. Nr. 189/1902", a Geschäftszahl, "VfSlg 19.632/2012") to its canonical document. |
| `ris_get_document` | Fetch one document's full text as markdown/HTML/XML, or its export URLs, with binding-status labeling and the authentic PDF wherever one exists. |
| `ris_track_changes` | Per-application change feed: every document added or changed in a date window, deletions included. |
| `ris_list_reference` | Ground the domain vocabulary offline: applications and coverage windows, court codes, Bundesländer, decision kinds, ministries, district authorities, gazette eras and parts, citation formats, search syntax. |

### `ris_search_legislation`

Search consolidated law: BrKons (federal), LrKons (state), Gr (municipal).

- Full-text `query` using RIS boolean grammar: `UND`/`ODER`/`NICHT` or `AND`/`OR`/`NOT`, parentheses, quoted phrases
- `title` matches the title, short title, or abbreviation ("DSG", "ABGB")
- `scope` routes to federal law or one of the nine Bundesländer; `municipality` narrows a state scope to municipal law (selected norms, six Bundesländer)
- `language: english` serves the Erv collection of selected English translations
- `in_force_as_of` defaults to today. Omitting the date upstream silently searches all historical versions, so `include_all_versions` is the explicit opt-in and the applied date is echoed in every response
- Force-window filters (`entered_force_from/to`, `left_force_from/to`) track provisions entering or leaving force in a date range
- Section-range filtering via `section_from`/`section_to`/`section_type` (§, Artikel, Anlage)
- Law-level grouping via `law_id` (Gesetzesnummer), plus Systematik `index` and `changed_since` windows
- Output per document: section label, in-force date, ELI, parsed CELEX references, and export URLs (XML/HTML/PDF/RTF)

---

### `ris_search_case_law`

Search decisions and headnotes across 17 court and tribunal applications.

- `court` is required and takes one application per call: `vfgh`, `vwgh`, `justiz`, `bvwg`, `lvwg`, `dsk`, `upts` (party-transparency senate), plus ten historical and specialized tribunals. Cross-court research fans out one call per court
- Filter by cited provision (`norm`, e.g. "DSG §1", "DSGVO Art32"), exact case number (`case_number`, Geschäftszahl), decision date range, decision kind (Erkenntnis/Beschluss/…), and full-text query
- `decision_type` targets headnotes (Rechtssätze), full decision texts, or both
- Court-conditional filters: `issuing_body` (dsk/dok/pvak/verg), `court_name`, `legal_area`, `subject_area` (justiz, e.g. "Datenschutzrecht"), `state` (lvwg/uvs), `collection_number` (VfSlg/VwSlg cites), `party` (upts), commission/senate/discrimination ground (gbk), media statute (bks)
- Output per decision: case numbers, decision date, ECLI, cited norms, keywords, the guiding principle (Leitsatz) on headnote documents, and headnote/decision URLs

---

### `ris_search_gazette`

Browse the promulgation record at every level of government. For a single known gazette number, `ris_lookup_citation` is the direct route.

- `scope`: federal, one of the nine Bundesländer, `district` (Bezirksverwaltungsbehörden), or `municipal` (authentic municipal promulgations)
- Federal history is one logical series auto-routed across three era tiers: BgblAuth (2004+, authentic), BgblPdf (Staats- und Bundesgesetzblatt 1945–2003), and BgblAlt (Reichs-, Staats- und Bundesgesetzblatt 1848–1940, metadata plus ÖNB-hosted scans). Each response names the tier that served it
- One call serves one tier, so a date range crossing 2004-01-01 or 1945-01-01 is rejected with the boundary to split at rather than answered from one side of it. RIS carries no federal gazette for 1941–1944
- Filter by publication date range, gazette `part` (BGBl. I/II/III, or `pre_1997` for the partless era), document `type`, issuing ministry, district authority, or municipality
- State scopes serve the authentic Landesgesetzblätter by default. `series: ordinance_gazette` switches to the Verordnungsblätter; `state_era: legacy` selects the state's earlier non-authentic series (Niederösterreich's systematic LgblNO, or the historical Lgbl elsewhere)
- Point lookup by gazette number ("BGBl. II Nr. 171/2026" or "171/2026")
- Every record carries a binding label (`authentic`, `historical_record`, or `consolidated_informational`) and the amtssigniert PDF URL when present. The metadata-only 1848–1940 gazettes link to their ÖNB ALEX scan

---

### `ris_search_drafts`

Search federal law before it is enacted.

- `stage: review_drafts` covers ministerial drafts in public review (Begutachtungsentwürfe). `in_review_on` answers what is in review on a given date
- `stage: government_bills` covers bills adopted by the council of ministers (Regierungsvorlagen, 2004+), filtered by adoption date
- `ministry` accepts the abbreviation ("BMF") and the server expands it to RIS's exact designation
- Output includes review deadlines, council adoption dates, and the RIS web view
- `materials` lists the companion documents filed with the draft — Erläuterungen (the drafting reasoning the bill text omits), Textgegenüberstellung, Vorblatt/WFA, covering letter, annexes. Their filenames are opaque and per-record, so passing a `materials[].urls` entry to `ris_get_document` is the only way to read one

---

### `ris_search_announcements`

Sectoral official gazettes and executive documents: seven collections, five of them legally binding authentic publications.

- `collection`: `social_insurance` (Avsv), `veterinary` (Avn), `court_rules` (KmGer), `trade_exam_rules` (PruefGewO), `health_structure_plans` (Spg, ÖSG/RSG), `ministerial_decrees` (Erlässe), `council_minutes` (Ministerratsprotokolle)
- Collection-aware filters: issue numbers, issuers (insurance carriers, ministries), cited norm ("decrees citing the DSG"), in-force date for the consolidated collections, plan type and state for health plans, session number and legislature for council minutes
- Binding labels per collection: `authentic`, `administrative_directive` (decrees bind the administration, not citizens), or `preparatory` (council minutes)
- Every record carries the RIS web view — the only browsable surface for the PDF-only council minutes and for ministerial decrees

---

### `ris_lookup_citation`

Resolve a citation to its canonical document.

- Parses and routes four citation kinds: norm cites ("§ 6 DSG", "Art 10 B-VG"), gazette numbers across all three federal eras plus LGBl ("BGBl. I Nr. 165/1999", "BGBl. Nr. 194/1961", "RGBl. Nr. 189/1902"), case numbers ("Ro 2026/03/0016", "2025-0.934.677", "14Os49/26a"), and collection numbers ("VfSlg 19.632/2012")
- Routes to deterministic upstream filters (section plus title, per-era number params, Geschäftszahl, Sammlungsnummer) rather than keyword search
- A state gazette number predating that Bundesland's e-Recht switch falls back to its earlier non-authentic series; a VwSlg number cited without its part letter comes back as ambiguous, naming both decisions, rather than resolved to one of them
- Returns `found: false` with structured guidance instead of throwing when nothing resolves
- `court` and `state` hints short-circuit ambiguous formats

---

### `ris_get_document`

Read and export a single document.

- Addresses documents by `document_number` plus `application` (from any search or lookup result), or by a passed-through `ris.bka.gv.at` document URL (host and path allowlisted) — including a draft's companion documents from `ris_search_drafts`'s `materials`, which nothing else can reach
- `format`: `markdown` (default, boilerplate stripped), raw `html`, RIS `xml`, or `urls_only`
- Every response carries a binding status: `authentic` (with amtssigniert PDF URL), `consolidated_informational`, `historical_record`, `decision`, `preparatory`, `administrative_directive`, or `translation`
- Applications that publish only the signed PDF (district and municipal promulgations, court rules) or only scans (1848–1940 gazettes, ÖNB-hosted) return a `format_unavailable` notice with the usable URLs instead of failing
- Markdown over 40,000 bytes returns a §/Artikel/Anlage section outline (`kind: outline`) instead of truncating. Re-call with `sections:[…]` to pull the sections you need
- Outlining needs those headings. A rendition without them — most court decisions, gazette and announcement bodies, every raw `html`/`xml` — has nothing to outline and returns whole at any size
- Returns content, not fresh metadata. The upstream API has no document-by-number search, so document numbers come from a prior search or lookup result

---

### `ris_track_changes`

Exact-dated per-application change feed.

- `application` plus `changed_from`/`changed_to` returns every document added or changed in the window. A typical two-week federal-law window carries 1,400+ changes
- `include_deleted` surfaces removals, which no other RIS surface exposes
- The search tools' `changed_since` interval filters are the coarser alternative

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

- All 39 OGD applications across every controller, from consolidated law and the four levels of authentic gazette to the 17 court and tribunal collections
- Strict parameter allowlist. RIS silently ignores unknown query params, so a typo returns plausible but unfiltered results; only live-confirmed spellings are sent upstream
- Normalizer for RIS's JSON-serialized-XML envelope: object-or-array coercion, in-band error detection, six per-controller metadata classes, `<br/>` cleanup, CELEX reference parsing, ministry-abbreviation expansion
- English tool surface over RIS's German API. Austrian legal terms (Geschäftszahl, Rechtssatz, Bundesgesetzblatt) stay as domain vocabulary and are glossed in the descriptions

Agent-friendly output:

- Error hints, zero-hit notices, format-unavailable notices, and `found: false` guidance each name the concrete next call: a `ris_list_reference` topic, the right search tool, or `ris_lookup_citation`
- Conditional-parameter misuse is caught locally before any upstream call: a court-specific filter with the wrong court, `part` outside federal scope, a collection filter on the wrong collection, bad addressing
- Zero hits return success plus a composed notice rather than an error
- Applied filters are echoed back, so the `in_force_as_of` default stays visible to the calling agent
- Upstream schema-validation messages pass through. RIS enumerates valid values, which lets agents self-correct

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
