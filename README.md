<div align="center">
  <h1>@cyanheads/ris-austria-mcp-server</h1>
  <p><b>Search Austrian consolidated federal & state law, court decisions, and the authentic Bundesgesetzblatt from the official RIS via MCP. Keyless. STDIO or Streamable HTTP.</b>
  <div>9 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.5-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/ris-austria-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/ris-austria-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/ris-austria-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

Austrian law from [RIS](https://www.ris.bka.gv.at/), the government's official legal information system: federal, state, and municipal law, court decisions, official gazettes back to 1848, draft legislation, and ministerial decrees. Every document is labeled with its binding status. No API key required.

### Tools

| Tool | Description |
|:---|:---|
| `ris_search_legislation` | Search consolidated federal, state, and municipal law as in force on a date (default today), plus English translations of selected laws |
| `ris_search_case_law` | Search case law in one court or tribunal per call, across 17 court codes |
| `ris_search_gazette` | Browse the federal, state, district, and municipal gazettes, with federal history auto-routed back to 1848 |
| `ris_search_drafts` | Search ministerial review drafts (Begutachtungsentwürfe) and government bills (Regierungsvorlagen) |
| `ris_search_announcements` | Search seven sectoral collections, from social-insurance notices to ministerial decrees and council-of-ministers minutes |
| `ris_lookup_citation` | Resolve one Austrian legal citation ("§ 6 DSG", "BGBl. I Nr. 165/1999", a Geschäftszahl or ECLI) to its document |
| `ris_get_document` | Fetch one document as markdown, HTML, or XML, or just its rendition URLs, with its binding status |
| `ris_track_changes` | List every document added, changed, or deleted in one application within a date window |
| `ris_list_reference` | Look up RIS vocabularies offline: applications, courts, states, ministries, gazette parts, citation formats, search syntax |

### Resources

| Resource | Description |
|:---|:---|
| `ris://document/{application}/{documentNumber}` | Markdown text of one RIS document |

The resource mirrors `ris_get_document`, so tool-only clients lose nothing.

## Capability reference

### `ris_search_legislation` <sub>tool</sub>

- Search by `query` (full text) or `title` (title, short title, or abbreviation such as "DSG"). `scope` is `federal` (default) or a Bundesland, `municipality` switches a state scope to municipal law, and `language: english` searches the ~138 English translations
- `in_force_as_of` defaults to today in Austria and is echoed as `appliedInForceAsOf`; `include_all_versions` and the `entered_force_*` / `left_force_*` windows are mutually exclusive alternatives
- Records carry `law_id` (filter on it for every section of a law), `section_label`, `abbreviation`, `keywords`, in-force dates, `eli`, `celex_references`, and `content_urls`

---

### `ris_search_case_law` <sub>tool</sub>

- `court` is required, one code per call. Filter by `query`, cited `norm` ("DSG §1"), `case_number`, `decided_from`/`decided_to`, and `decision_type` (`headnote`, `full_text`, or `all`, the default). Court-specific filters include `court_name` (justiz), `state` (lvwg/uvs), and `collection_number` (vfgh/vwgh/uvs); one sent to the wrong court fails as `court_filter_mismatch`
- Records carry `case_numbers` (a headnote lists every decision it covers), `decision_date`, `ecli`, `norms_cited`, and `guiding_principle` on headnotes
- `court: normenliste` returns indexed laws under `norm_index` instead of decisions

---

### `ris_search_gazette` <sub>tool</sub>

- `scope` is `federal` (default), a Bundesland, `district`, or `municipal`. Filter by `number`, `part`, `type`, `published_from`/`published_to`, `issuer`, `district_authority`, or `municipality`; state scopes also take `series` and `state_era`
- Federal queries are served from one era (BgblAuth 2004+, BgblPdf 1945–2003, BgblAlt 1848–1940), echoed as `servedApplication`; a date range spanning two eras fails as `cross_tier_range` with the dates to split at
- Records carry `binding` (`authentic`, `historical_record`, `consolidated_informational`), `authentic_pdf_url` where one exists, `alex_url` (ÖNB scan) for 1848–1940, `celex_references` where applicable, and `promulgation` on federal entries from 1848–2003

---

### `ris_search_drafts` <sub>tool</sub>

- `stage` is required: `review_drafts` (with `in_review_on`) or `government_bills` (2004+, with `decided_from`/`decided_to`); `ministry` accepts an abbreviation such as "BMF" or a full designation
- Records carry `review_start` and `review_deadline` or `decided`, `abbreviation` and `keywords` where RIS supplies them, plus `materials[]` (Erläuterungen, Textgegenüberstellung, Vorblatt/WFA, annexes) classified by `type`. Pass a `materials[].url` to `ris_get_document` to read one

---

### `ris_search_announcements` <sub>tool</sub>

- `collection` is required: `social_insurance`, `veterinary`, `court_rules`, `trade_exam_rules`, `health_structure_plans`, `ministerial_decrees`, or `council_minutes`. A filter its collection doesn't accept fails as `collection_filter_mismatch`, including `changed_since` on `social_insurance` and `veterinary`. `issuer` expands ministry ("BMF") and social-insurance carrier ("ÖGK") abbreviations
- Records carry `binding` (`authentic`, `administrative_directive`, or `preparatory`), `authentic_pdf_url`, and `document_url`, the only browsable view of council minutes and decrees
- Each collection adds its own metadata where RIS supplies it, such as `case_numbers`, `in_force_from`/`in_force_until`, `keywords`, `court_name`, `plan_state`, and `session_number`

---

### `ris_lookup_citation` <sub>tool</sub>

- One `citation` per call, classified as a norm ("§ 6 DSG"), gazette number ("BGBl. I Nr. 165/1999"), case number ("VfGH G 13/2025") or ECLI, or collection number ("VfSlg 19.632/2012"). `kind` forces a route, `court` and `state` narrow it, and `in_force_as_of` pins a norm's version (default today)
- Returns `found`, `kind`, and a `record` in the matching search tool's shape, with `alternatives_count` when several documents matched. A miss returns `found: false` with `guidance` instead of an error
- A norm resolves to the cited law ("§ 2 EStG" → EStG 1988 § 2, "AlVG 1977" → the AlVG, which RIS files without its year, "VwGVG 2014 §28" → VwGVG § 28, searched again without the year its title lacks), its sub-provisions and a trailing ";" set aside ("Art. 6 (1) B-VG" → B-VG Art 6), an ordinal-led abbreviation read like any other ("1. COVID-19-JuBG §1"), the version a law is cited in set aside ("ABGB idF BGBl I 2010/28 §988" → ABGB § 988 as in force on the requested date, never the amending act's gazette entry, the note saying the cited version was not applied), a long title read by its short form ("StaatsanwaltschaftsG - StAG §35" → StAG § 35), and a comma-joined entry ("DSG §1, §24") or one joining full norms with ". " ("ZPO §179. ZPO §275 Abs2") resolves its first provision and names the rest; an EU act RIS does not consolidate ("DSGVO Art32"), or one cited by its number ("RL 2006/123/EG", "VO (EG) 178/2002 Art3"), returns `found: false` with its EUR-Lex link, without a RIS request; "BGBl. Nr. 50/2025" without its part comes back ambiguous, naming parts I, II, and III

---

### `ris_get_document` <sub>tool</sub>

- Address by `document_number` + `application`, or by a `document_url` from `content_urls` or a draft's `materials[].url`; `format` is `markdown` (default), `html`, `xml`, or `urls_only`
- Every result carries `binding_status` and `authentic_pdf_url` where one exists. Applications with no text rendition (district and municipal promulgations, court rules, council minutes, 1848–1940 gazettes) return a notice with the usable URL instead of failing
- Markdown over 40,000 bytes returns `kind: outline`; re-call with `sections` to fetch entries. `html` and `xml` over 40,000 bytes return `kind: link` with `byte_size` and `content_urls`, so read with `markdown`

---

### `ris_track_changes` <sub>tool</sub>

- `application` (any of the 39 codes) plus `changed_from`/`changed_to`; `include_deleted` adds removals, which no other tool reports
- Records carry `changed`, `published`, and `binding_status`; deletions set `deleted: true` with `deleted_at`
- Law rows carry `section_label`, `law_id`, and `in_force_from`/`in_force_until` (no end date is not the same as in force now), and decision rows carry `case_numbers` and `decision_date`

---

### `ris_list_reference` <sub>tool</sub>

- `topic` selects one of 17 static tables: applications, courts, states, decision types and kinds, issuing bodies, ministries, collections, stages, changed-since intervals, section types, gazette parts, law types, district authorities, justiz subject areas, search syntax, and citation formats
- Returns `summary` and `entries` (`value`, `label`, `details`) with no upstream call

---

### `ris://document/{application}/{documentNumber}` <sub>resource</sub>

- `text/markdown` of one document, addressed by `application` + `documentNumber` from a search or lookup result; same content as `ris_get_document` with `format: markdown`
- Applications with no text rendition return a note pointing at the PDF or scan; oversized text returns the outline, so use the tool to fetch an entry

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

RIS-specific:

- All 39 OGD applications: consolidated law, federal, state, district, and municipal gazettes, 17 court and tribunal collections, the lawmaking pipeline, and sectoral announcements
- Citations resolve through exact filters (section plus title, gazette number, Geschäftszahl, Sammlungsnummer) rather than keyword search
- Dates are `YYYY-MM-DD`; search tools page with `page` and `page_size` (1–100, served as pages of 10 or 20; default 20); omit a text filter rather than sending it blank
- Court, application, state, and ministry codes come from `ris_list_reference`
- Tool descriptions are English; titles, field values, and RIS error messages stay German

Agent-friendly output:

- Every record carries a typed binding status (`authentic`, `consolidated_informational`, `historical_record`, `decision`, `preparatory`, `administrative_directive`, `translation`)
- Paged results report `totalCount` and `truncated` and echo what the server applied, such as `appliedInForceAsOf` and `servedApplication`
- Typed error reasons (`court_filter_mismatch`, `cross_tier_range`, `invalid_query`, `document_not_found`, …) and zero-hit notices name the next call

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

Add any [configuration](#configuration) variables under an `"env"` key for bunx/npx, or as additional `-e NAME=value` arguments for Docker.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key: the RIS OGD API is keyless.

### Installation

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
| `RIS_CONTENT_BASE_URL` | Document content host that rendition URLs are built on and documents are fetched from. `https://www.ris.bka.gv.at` answers automated clients with a bot-check page. | `https://ogd.ris.bka.gv.at` |
| `RIS_CONTACT` | Contact string appended to the User-Agent. | none |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. | `stateless` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `warning`, `error`, etc.). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

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

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/ris-austria-mcp-server`. OpenTelemetry peer dependencies are installed by default; build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point — registers tools and resources. |
| `src/config` | Optional RIS endpoint and contact configuration, parsed with Zod. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources` | Resource definitions (`*.resource.ts`). |
| `src/services/ris` | RIS request building, HTTP access, normalization, and static reference data. |
| `docs/design.md` | Design notes: tool surface, service spec, live-confirmed RIS API reference. |
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
