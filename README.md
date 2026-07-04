<div align="center">
  <h1>@cyanheads/ris-austria-mcp-server</h1>
  <p><b>Search Austrian consolidated federal & state law, court decisions, and the authentic Bundesgesetzblatt from the official RIS via MCP. Keyless. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

> **Status:** pre-release. The tool surface below is the settled v1 design ([`docs/design.md`](./docs/design.md)); implementation is in progress and the package is not yet published.

[RIS](https://www.ris.bka.gv.at/) (Rechtsinformationssystem des Bundes) is the Austrian government's official legal database: consolidated federal and state law, case law across every Austrian court and tribunal, and the authentic — legally binding — Bundesgesetzblatt. This server wraps the keyless RIS OGD REST API (v2.6, CC BY 4.0) for MCP agents.

## Tools

Six tools split by document class — consolidated law, case law, and the authentic gazette record — plus a deterministic citation resolver, document retrieval, and an offline vocabulary reference:

| Tool | Description |
|:---|:---|
| `ris_search_legislation` | Search consolidated federal and state law — one document per §/Artikel/Anlage — filtered to the version in force on a given date (defaults to today). |
| `ris_search_case_law` | Search Austrian case law (Judikatur) in one court or tribunal per call — VfGH, VwGH, ordinary courts, BVwG, LVwG, DSB, and ten more. |
| `ris_search_gazette` | Browse authentic promulgations (Bundesgesetzblatt / Landesgesetzblätter) by date range, part, type, or issuer — the compliance-monitoring surface. |
| `ris_lookup_citation` | Resolve one Austrian legal citation — "§ 6 DSG", "BGBl. I Nr. 165/1999", a Geschäftszahl — deterministically to its canonical document. |
| `ris_get_document` | Fetch one document's full text as markdown/HTML/XML, or its export URLs, with binding-status labeling and the authentic PDF for gazette documents. |
| `ris_list_reference` | Ground the domain vocabulary offline — applications, court codes, Bundesländer, decision types, gazette parts, search syntax. |

### `ris_search_legislation`

Search consolidated law (BrKons federal, LrKons state) with in-force-date handling correct by default.

- Full-text `query` with RIS boolean grammar (`UND`/`ODER`/`NICHT` or `AND`/`OR`/`NOT`, parentheses, quoted phrases) and `title` matching title, short title, or abbreviation ("DSG", "ABGB")
- `scope` routes federal or one of the nine Bundesländer
- **`in_force_as_of` defaults to today** — omitting the date upstream silently searches all historical versions; `include_all_versions` is the explicit opt-in, and the applied date is echoed in every response
- Section-range filtering (`section_from`/`section_to`/`section_type` — §, Artikel, Anlage), law-level grouping via `law_id` (Gesetzesnummer), Systematik `index`, `changed_since` windows
- Output per document: section label, in-force date, ELI, parsed CELEX references (the EU-transposition hook), and export URLs (XML/HTML/PDF/RTF)

---

### `ris_search_case_law`

Search decisions and headnotes across Austria's courts and tribunals.

- One application per call (`court`, required): `vfgh`, `vwgh`, `justiz`, `bvwg`, `lvwg`, `dsk`, plus ten historical/specialized tribunals — cross-court research fans out one call per court
- Filter by cited provision (`norm` — "DSG §1", "DSGVO Art32"), exact case number (`case_number`, Geschäftszahl), decision date range, and full-text query
- `decision_type` targets headnotes (Rechtssätze), full decision texts, or both
- Court-conditional filters: `issuing_body` (dsk — Datenschutzbehörde vs. Datenschutzkommission), `court_name` (justiz — "OGH", "OLG Wien"), `state` (lvwg)
- Output per decision: case numbers, decision date, ECLI, cited norms, keywords, and headnote/decision URLs

---

### `ris_search_gazette`

Browse the legally binding promulgation record — what `ris_lookup_citation` (point lookup) can't express.

- Filter by publication date range, gazette `part` (BGBl. I/II/III), document `type` (laws, regulations, announcements), or issuing ministry
- Point lookup by gazette number ("BGBl. II Nr. 171/2026" or "171/2026")
- Federal date ranges before 2004 route to the BgblAlt archive (1945–2003) automatically, with a notice
- Every record is labeled `authentic` and carries the amtssigniert PDF URL when present

---

### `ris_lookup_citation`

Citation-first resolution — how Austrian legal work actually starts.

- Parses and routes three citation kinds: norm cites ("§ 6 DSG", "Art 10 B-VG"), gazette numbers ("BGBl. I Nr. 165/1999"), and case numbers ("Ra 2019/22/0184", "2025-0.934.677", "6Ob56/25k")
- Deterministic upstream filters (section + title, Bgblnummer, Geschäftszahl) — no keyword-search fuzziness
- Returns `found: false` with structured guidance instead of throwing when nothing resolves
- A `court` hint short-circuits ambiguous case-number formats

---

### `ris_get_document`

Read and export a single document.

- Addresses documents by `document_number` + `application` (from any search/lookup result) or a passed-through `ris.bka.gv.at` document URL (host and path allowlisted)
- `format`: `markdown` (default, boilerplate stripped), raw `html`, RIS `xml`, or `urls_only`
- Binding status on every response: `authentic` (with amtssigniert PDF URL), `consolidated_informational`, or `decision` — consolidated text is never presented as the binding text
- Oversized text truncates explicitly (`truncated: true`) with export URLs for the full artifact

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

- All three RIS document classes: consolidated law (BrKons/LrKons), authentic gazettes (BgblAuth/BgblAlt/LgblAuth), and case law across 16 court/tribunal applications
- Strict parameter allowlist — RIS silently ignores unknown query params (a typo returns plausible but unfiltered results), so only live-confirmed spellings are ever sent upstream
- Normalizer for RIS's JSON-serialized-XML envelope: object-or-array coercion, in-band error detection on HTTP 200, `<br/>` cleanup, CELEX reference parsing
- English tool surface over RIS's German API — Austrian legal terms (Geschäftszahl, Rechtssatz, Bundesgesetzblatt) kept as domain vocabulary and glossed in descriptions

Agent-friendly output:

- Applied-filter echo — the `in_force_as_of` default is never invisible to the calling agent
- Structured no-resolve results (`found: false` + guidance) instead of throws on citation lookup
- Upstream schema-validation messages passed through — RIS enumerates valid values, which lets agents self-correct
- Explicit truncation flags with export URLs, never silent cuts

## Getting started

Not yet published to npm — install from source.

### Prerequisites

- [Bun v1.3](https://bun.sh/) or higher (or Node.js v24+)
- No API key — the RIS OGD API is keyless

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

RIS OGD data is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.de) (attribution: RIS, Bundeskanzleramt Österreich). The underlying legal texts are copyright-free official works. Only the authentic, amtssigniert Bundesgesetzblatt wording is legally binding — consolidated RIS text is informational.
