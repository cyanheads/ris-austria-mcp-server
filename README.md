<div align="center">
  <h1>@cyanheads/ris-austria-mcp-server</h1>
  <p><b>Search Austrian consolidated federal & state law, court decisions, and the authentic Bundesgesetzblatt from the official RIS via MCP. Keyless. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ris-austria-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.0.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/ris-austria-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/ris-austria-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.0-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/ris-austria-mcp-server/releases/latest/download/ris-austria-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=ris-austria-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvcmlzLWF1c3RyaWEtbWNwLXNlcnZlciJdfQ==) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22ris-austria-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fris-austria-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://ris-austria.caseyjhand.com/mcp](https://ris-austria.caseyjhand.com/mcp)

</div>

---

## Overview

[RIS](https://www.ris.bka.gv.at/) is the Austrian government's official legal database: consolidated federal, state, and municipal law, case law from every Austrian court and tribunal, the authentic gazettes whose promulgated text is binding under Austrian law, the pre-parliamentary lawmaking pipeline, and ministerial decrees. This server wraps the keyless RIS OGD REST API (v2.6, CC BY 4.0), covering all 39 OGD applications and reaching back to the Reichsgesetzblatt of 1848; every response labels the document's binding status, since only the amtssignierte gazette wording is legally binding. Runs as a stdio process, a local Streamable HTTP server, or the public hosted endpoint above.

### Tools

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

### Resources

| Resource | Description |
|:---|:---|
| `ris://document/{application}/{documentNumber}` | Markdown text of one RIS document — injectable twin of `ris_get_document` |

All resource data is also reachable via tools — clients without resource support use `ris_get_document`.

## Capability reference

### `ris_search_legislation` <sub>tool</sub>

- Full-text `query` using RIS boolean grammar: `UND`/`ODER`/`NICHT` or `AND`/`OR`/`NOT`, parentheses, quoted phrases
- `title` matches the title, short title, or abbreviation ("DSG", "ABGB")
- `scope` routes to one of three applications — BrKons (federal), LrKons (state), Gr (municipal); `municipality` narrows a state scope to municipal law (selected norms, six Bundesländer)
- `language: english` serves the Erv collection of selected English translations
- `in_force_as_of` defaults to today. Omitting the date upstream silently searches all historical versions, so `include_all_versions` is the explicit opt-in and the applied date is echoed in every response
- Force-window filters (`entered_force_from/to`, `left_force_from/to`) track provisions entering or leaving force in a date range
- Section-range filtering via `section_from`/`section_to`/`section_type` (§, Artikel, Anlage)
- Law-level grouping via `law_id` (Gesetzesnummer), plus Systematik `index` and `changed_since` windows
- Output per document: section label, in-force date, ELI, parsed CELEX references, and export URLs (XML/HTML/PDF/RTF)

---

### `ris_search_case_law` <sub>tool</sub>

- `court` is required and takes one application per call: `vfgh`, `vwgh`, `justiz`, `bvwg`, `lvwg`, `dsk`, `upts` (party-transparency senate), plus ten historical and specialized tribunals. Cross-court research fans out one call per court
- Filter by cited provision (`norm`, e.g. "DSG §1", "DSGVO Art32"), exact case number (`case_number`, Geschäftszahl), decision date range, decision kind (Erkenntnis/Beschluss/…), and full-text query
- `decision_type` targets headnotes (Rechtssätze), full decision texts, or both
- Court-conditional filters: `issuing_body` (dsk/dok/pvak/verg), `court_name`, `legal_area`, `subject_area` (justiz, e.g. "Datenschutzrecht"), `state` (lvwg/uvs), `collection_number` (VfSlg/VwSlg cites), `party` (upts), commission/senate/discrimination ground (gbk), media statute (bks)
- Output per decision: case numbers, decision date, ECLI, cited norms, keywords, the guiding principle (Leitsatz) on headnote documents, and headnote/decision URLs

---

### `ris_search_gazette` <sub>tool</sub>

- `scope`: federal, one of the nine Bundesländer, `district` (Bezirksverwaltungsbehörden), or `municipal` (authentic municipal promulgations)
- Federal history is one logical series auto-routed across three era tiers: BgblAuth (2004+, authentic), BgblPdf (Staats- und Bundesgesetzblatt 1945–2003), and BgblAlt (Reichs-, Staats- und Bundesgesetzblatt 1848–1940, metadata plus ÖNB-hosted scans). Each response names the tier that served it
- One call serves one tier, so a date range crossing 2004-01-01 or 1945-01-01 is rejected with the boundary to split at rather than answered from one side of it. RIS carries no federal gazette for 1941–1944
- Filter by publication date range, gazette `part` (BGBl. I/II/III, or `pre_1997` for the partless era), document `type`, issuing ministry, district authority, or municipality
- State scopes serve the authentic Landesgesetzblätter by default. `series: ordinance_gazette` switches to the Verordnungsblätter; `state_era: legacy` selects the state's earlier non-authentic series (Niederösterreich's systematic LgblNO, or the historical Lgbl elsewhere)
- Point lookup by gazette number ("BGBl. II Nr. 171/2026" or "171/2026")
- Every record carries a binding label (`authentic`, `historical_record`, or `consolidated_informational`) and the amtssigniert PDF URL when present. The metadata-only 1848–1940 gazettes link to their ÖNB ALEX scan
- For a single known gazette number, `ris_lookup_citation` is the more direct route

---

### `ris_search_drafts` <sub>tool</sub>

- `stage: review_drafts` covers ministerial drafts in public review (Begutachtungsentwürfe). `in_review_on` answers what is in review on a given date
- `stage: government_bills` covers bills adopted by the council of ministers (Regierungsvorlagen, 2004+), filtered by adoption date
- `ministry` accepts the abbreviation ("BMF") and the server expands it to RIS's exact designation
- Output includes review deadlines, council adoption dates, and the RIS web view
- `materials` lists the companion documents filed with the draft — Erläuterungen (the drafting reasoning the bill text omits), Textgegenüberstellung, Vorblatt/WFA, covering letter, annexes. Their filenames are opaque and per-record, so passing a `materials[].url` to `ris_get_document` is the only way to read one; `format` there picks the rendition, so the one URL reaches every text rendition the companion has. Where RIS files no HTML rendition — about one companion in eight, nearly all covering letters — the URL is the PDF, which is a download rather than a text rendition

---

### `ris_search_announcements` <sub>tool</sub>

- `collection`: `social_insurance` (Avsv), `veterinary` (Avn), `court_rules` (KmGer), `trade_exam_rules` (PruefGewO), `health_structure_plans` (Spg, ÖSG/RSG), `ministerial_decrees` (Erlässe), `council_minutes` (Ministerratsprotokolle) — five of the seven are authentic publications
- Collection-aware filters: issue numbers, issuers (insurance carriers, ministries), cited norm ("decrees citing the DSG"), in-force date for the consolidated collections, plan type and state for health plans, session number and legislature for council minutes
- Binding labels per collection: `authentic`, `administrative_directive` (decrees bind the administration, not citizens), or `preparatory` (council minutes)
- Every record carries the RIS web view — the only browsable surface for the PDF-only council minutes and for ministerial decrees

---

### `ris_lookup_citation` <sub>tool</sub>

- Parses and routes four citation kinds: norm cites ("§ 6 DSG", "Art 10 B-VG"), gazette numbers across all three federal eras plus LGBl ("BGBl. I Nr. 165/1999", "BGBl. Nr. 194/1961", "RGBl. Nr. 189/1902"), case numbers ("Ro 2026/03/0016", "2025-0.934.677", "14Os49/26a"), and collection numbers ("VfSlg 19.632/2012")
- Routes to deterministic upstream filters (section plus title, per-era number params, Geschäftszahl, Sammlungsnummer) rather than keyword search
- A state gazette number predating that Bundesland's e-Recht switch falls back to its earlier non-authentic series; a VwSlg number cited without its part letter comes back as ambiguous, naming both decisions, rather than resolved to one of them
- Returns `found: false` with structured guidance instead of throwing when nothing resolves
- `court` and `state` hints short-circuit ambiguous formats

---

### `ris_get_document` <sub>tool</sub>

- Addresses documents by `document_number` plus `application` (from any search or lookup result), or by a passed-through `ris.bka.gv.at` document URL (host and path allowlisted) — including a draft's companion documents from a `ris_search_drafts` record's `materials[].url`, which nothing else can reach. `format` selects the rendition for a companion exactly as for a main document
- `format`: `markdown` (default, boilerplate stripped), raw `html`, RIS `xml`, or `urls_only`
- Every response carries a binding status: `authentic` (with amtssigniert PDF URL), `consolidated_informational`, `historical_record`, `decision`, `preparatory`, `administrative_directive`, or `translation`
- Applications that publish only the signed PDF (district and municipal promulgations, court rules) or only scans (1848–1940 gazettes, ÖNB-hosted) return a `format_unavailable` notice with the usable URLs instead of failing
- Markdown over 40,000 bytes returns an outline (`kind: outline`) instead of truncating. Re-call with `sections:[…]` to pull the entries you need
- Outline entries are the document's §/Artikel/Anlage sections, or — for the court decisions, gazette bodies and announcements that carry no such headings — contiguous byte windows named `Part 1 of N` … `Part N of N`, cut at line breaks and covering the text with nothing dropped. Raw `html`/`xml` are never sliced and return whole at any size
- Returns content, not fresh metadata. The upstream API has no document-by-number search, so document numbers come from a prior search or lookup result

---

### `ris_track_changes` <sub>tool</sub>

- `application` plus `changed_from`/`changed_to` returns every document added or changed in the window. A typical two-week federal-law window carries 1,400+ changes
- `include_deleted` surfaces removals, which no other RIS surface exposes
- The search tools' `changed_since` interval filters are the coarser alternative

---

### `ris_list_reference` <sub>tool</sub>

- Returns one static RIS vocabulary table per call — no upstream request, no network dependency
- `topic` selects the table: applications, courts, states, decision types/kinds, issuing bodies, ministries, collections, stages, changed-since intervals, section types, gazette parts, law types, district authorities, justiz subject areas, search syntax, or citation formats
- The other `ris_*` tools' recovery hints and zero-hit notices route callers back here by topic

---

### `ris://document/{application}/{documentNumber}` <sub>resource</sub>

- Markdown only (`text/markdown`) — the injectable twin of `ris_get_document` with `format: markdown`
- Addressed by `application` + `documentNumber`, copied verbatim from a search or `ris_lookup_citation` result
- Applications with no text rendition (district/municipal promulgations, court rules, party-transparency decisions, council minutes, the 1848–1940 imperial gazettes) return a short note pointing at the authentic PDF or scan instead
- Oversized text degrades to the same section/window outline as `ris_get_document`, but carries no `sections` selector — re-fetch via the tool to pull a specific one

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

RIS-specific:

- All 39 OGD applications across every controller, from consolidated law and the four levels of authentic gazette to the 17 court and tribunal collections
- Citation engine parses and routes four Austrian citation kinds (norm, gazette number, case number, collection number) to deterministic upstream filters rather than keyword search
- Strict parameter allowlist and JSON-serialized-XML normalizer — RIS silently ignores unknown params, so only live-confirmed spellings are sent upstream; the normalizer handles object-or-array coercion, in-band error detection, six per-controller metadata classes, CELEX reference parsing, and ministry-abbreviation expansion
- Retries with a 1.5s base delay calibrated for RIS's rate-limited API; an HTML response in place of JSON is treated as a throttle/degradation signal
- English tool surface over RIS's German API — Austrian legal terms (Geschäftszahl, Rechtssatz, Bundesgesetzblatt) stay as domain vocabulary and are glossed in the descriptions

Agent-friendly output:

- Discriminated output contracts — every document carries a typed binding status (`authentic`, `historical_record`, `consolidated_informational`, `decision`, `preparatory`, `administrative_directive`, `translation`) so callers branch on data, not string parsing
- Provenance — responses echo applied filters (e.g. the resolved `in_force_as_of` date) and, for gazettes, which era tier served the result
- Actionable recovery — typed error reasons (`court_filter_mismatch`, `invalid_query`, `document_not_found`, …) and zero-hit notices each name the concrete next call: a `ris_list_reference` topic, the right search tool, or `ris_lookup_citation`
- Response shaping — court- and collection-conditional filter misuse is rejected locally before any upstream call, since RIS silently ignores unknown parameters rather than erroring

## Localization

Tool and parameter descriptions are English-only today. German (`de-AT`) descriptions are planned, pending opt-in localization support in the framework ([cyanheads/mcp-ts-core#259](https://github.com/cyanheads/mcp-ts-core/issues/259)); the English surface stays the default and fallback.

## Getting started

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

### Self-Hosted / Local

Add the server to your MCP client configuration with Bun:

```json
{
  "mcpServers": {
    "ris-austria-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/ris-austria-mcp-server@latest"]
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "ris-austria-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/ris-austria-mcp-server@latest"]
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "ris-austria-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/ris-austria-mcp-server:latest"
      ]
    }
  }
}
```

Add any [configuration](#configuration) variables under an `"env"` key for bunx/npx, or as
additional `-e NAME=value` arguments for Docker.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3](https://bun.sh/) or higher, or Node.js v24+ (needed for `npx`/`bunx`)
- No API key — the RIS OGD API is keyless

### Installation

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

## Configuration

| Variable | Description | Default |
|:---|:---|:---|
| `RIS_API_BASE_URL` | RIS OGD REST API base URL. | `https://data.bka.gv.at/ris/api/v2.6` |
| `RIS_CONTENT_BASE_URL` | Document content host (also the allowlist host for `document_url` input). | `https://www.ris.bka.gv.at` |
| `RIS_CONTACT` | Contact string appended to the User-Agent (RIS netiquette asks integrators to be identifiable). | none |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateful`, `stateless`, or `auto`. This server pins stateless serving explicitly. | `stateless` |
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

### Docker

```sh
docker build -t ris-austria-mcp-server .
docker run --rm -p 3010:3010 ris-austria-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to
`/var/log/ris-austria-mcp-server`. OpenTelemetry peer dependencies are installed by default;
build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and resources. |
| `src/config` | Optional RIS endpoint and contact configuration, parsed with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/ris` | RIS request building, HTTP access, normalization, and static reference data. |
| `docs/design.md` | Settled v1 design — tool surface, service spec, live-confirmed RIS API reference. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `framework-skills/` | Development skills synced from `@cyanheads/mcp-ts-core`. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) / [`AGENTS.md`](./AGENTS.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via `createApp()` in `src/index.ts`
- Wrap the RIS API: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](./LICENSE) for details.

RIS OGD data is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.de) (attribution: RIS, Bundeskanzleramt Österreich). The underlying legal texts are copyright-free official works. Only the authentic, amtssignierte gazette wording is legally binding — consolidated RIS text is informational.
