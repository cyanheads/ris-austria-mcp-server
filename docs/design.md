# ris-austria-mcp-server — Design

Austrian federal & state law and court decisions via the RIS (Rechtsinformationssystem des Bundes) OGD REST API v2.6 — keyless, CC BY 4.0. Designed 2026-07-04; all "✓ live-confirmed" markers in this doc were verified against the production API on that date.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `ris_search_legislation` | Search consolidated federal + state law (one doc = one §/Artikel/Anlage). Flagship filter: in-force-as-of date. | `query`, `title`, `scope` (federal \| 9 Bundesländer), `in_force_as_of` (default today), `include_all_versions`, `section_from/to`, `section_type`, `law_id`, `index`, `changed_since`, `page`, `page_size` | readOnly, idempotent, openWorld |
| `ris_search_case_law` | Search Judikatur in one court/tribunal application per call (VfGH, VwGH, Justiz, BVwG, LVwG, DSB, …). | `court` (enum, required), `query`, `norm`, `case_number`, `decision_type`, `decided_from/to`, `issuing_body` (dsk), `court_name` (justiz), `state` (lvwg), `changed_since`, `page`, `page_size` | readOnly, idempotent, openWorld |
| `ris_search_gazette` | Browse authentic promulgations (Bundesgesetzblatt / Landesgesetzblätter) by date range, part, type, issuer — the compliance-monitoring surface. | `scope` (federal \| Bundesland), `query`, `number`, `part`, `type`, `published_from/to`, `issuer`, `page`, `page_size` | readOnly, idempotent, openWorld |
| `ris_lookup_citation` | Deterministic resolver: one legal citation → the canonical RIS document. Handles norm cites ("§ 6 DSG"), gazette cites ("BGBl. I Nr. 165/1999"), case numbers ("2025-0.934.677"). Returns `found: false`, never throws, on no-resolve. | `citation`, `kind` (auto \| norm \| gazette \| case_number), `court` (hint), `in_force_as_of` | readOnly, idempotent, openWorld |
| `ris_get_document` | Fetch one document's full text (markdown/html/xml) or its export URLs, with binding-status labeling and the authentic PDF surfaced for gazette docs. | `document_number` + `application`, or `document_url`; `format` (markdown \| html \| xml \| urls_only) | readOnly, idempotent, openWorld |
| `ris_list_reference` | Ground the opaque German codes: applications, court codes, Bundesländer, decision types, DPA bodies, changed-since intervals, section types, gazette parts, citation formats. Static, offline. | `topic` (enum) | readOnly, idempotent, closedWorld |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `ris://document/{application}/{documentNumber}` | Markdown text of one RIS document — injectable twin of `ris_get_document` | No |

### Prompts

None in v1. An EU→AT transposition research prompt was considered and deferred — the workflow (eur-lex CELEX → `ris_search_legislation` title/CELEX match → `ris_search_case_law`) chains naturally without a template, and prompts are the least-supported client primitive.

## Overview

The Austrian-national counterpart to `eur-lex-mcp-server`. RIS is the Austrian government's official legal database: consolidated federal and state law, case law across every Austrian court and tribunal, and the authentic (legally binding) Bundesgesetzblatt. The OGD REST API is keyless and CC BY 4.0.

**Audience:** Austrian legal practitioners, compliance/regulatory teams, GovTech, legal-research agents. Data-protection compliance (DSG/DSGVO, Datenschutzbehörde + BVwG/VwGH/VfGH case law) is the anchor use case: "current in-force text as of date X" and DPA case law are the daily questions.

**Three document classes** drive the tool split:

| Class | Applications | Legally binding? | Reached via |
|:---|:---|:---|:---|
| Consolidated law | BrKons (federal), LrKons (state) | No — informational | `search_legislation`, `lookup_citation` |
| Authentic promulgation | BgblAuth (2004+), BgblAlt (1945–2003), LgblAuth | **Yes** (amtssigniert PDF) | `search_gazette`, `lookup_citation` |
| Case law (Judikatur) | Vfgh, Vwgh, Justiz, Bvwg, Lvwg, Dsk + 10 historical/specialized | n/a | `search_case_law`, `lookup_citation` |

## Requirements

- Search, read, export across all three document classes
- Keyless upstream; no auth on the server
- In-force-as-of date handling correct by default (see Design Decisions)
- Authentic-vs-consolidated binding status explicit on every document output
- ELI / ECLI / CELEX identifiers surfaced for cross-server chaining (eur-lex, courtlistener, wikidata)
- English tool surface; German only as domain vocabulary (upstream field names, Austrian legal proper nouns)
- Netiquette posture (RIS OGD guidance): descriptive User-Agent with contact, reactive backoff, no bulk crawling through the tool surface
- No DataCanvas — discovery/search over categorical legal metadata + document retrieval, not aggregation

## User Goals

1. Look up a current federal or state law by title/keyword as in force on a given date ("Datenschutzgesetz as it stands today")
2. Retrieve the full text of a specific norm or § — read in context, or export (PDF/RTF/XML links)
3. Search case law by court, keyword, cited norm ("DSGVO Art 32"), case number, or date range
4. Read a specific decision — Rechtssatz (headnote) and/or full Entscheidungstext — by Geschäftszahl
5. Resolve any Austrian legal citation deterministically to its canonical document
6. Monitor new promulgations ("what landed in BGBl. II in June") and recently changed consolidated law
7. Get the authentic, legally binding gazette artifact (amtssigniert PDF) — never a paraphrase
8. Bridge an EU act to its Austrian transposition (CELEX references parsed from BrKons metadata → eur-lex)

## Tools — detail

### ris_search_legislation

One tool spans federal (BrKons) and state (LrKons) consolidated law — the filter grammars are near-identical; `scope` routes.

| Param | Type | Maps to | Notes |
|:---|:---|:---|:---|
| `query` | string? | `Suchworte` | Full-text. Boolean `UND`/`ODER`/`NICHT` (also `AND`/`OR`/`NOT` ✓), parens, quoted phrases. Wildcard `*` trailing-only here. |
| `title` | string? | `Titel` | Matches title, short title, and abbreviation ("ABGB", "DSG"). Phrase-type field: `*` allowed leading or trailing. |
| `scope` | enum | controller + `Bundesland.SucheIn<Land>` | `federal` (default) \| `burgenland` \| `kaernten` \| `niederoesterreich` \| `oberoesterreich` \| `salzburg` \| `steiermark` \| `tirol` \| `vorarlberg` \| `wien` |
| `in_force_as_of` | ISO date? | `FassungVom` | **Default: today.** Omitting FassungVom upstream searches ALL historical versions — silently wrong default for "current law" questions (✓ 77 vs 436 hits). |
| `include_all_versions` | boolean? | omits `FassungVom` | Explicit opt-in for version-history research. Overrides `in_force_as_of`. |
| `section_from` / `section_to` | string? | `Abschnitt.Von` / `Abschnitt.Bis` | "6", "1a" — §/Artikel/Anlage number-or-letter range (✓). |
| `section_type` | enum? | `Abschnitt.Typ` | `Alle` \| `Artikel` \| `Paragraph` (default when section range set) \| `Anlage` |
| `law_id` | string? | `Gesetzesnummer` | Law-level grouping key (e.g. 10001597 = DSG) — fetch all §§ of one law. Exact match. |
| `index` | string? | `Index` | Systematik classification ("10/10 Datenschutz"). |
| `changed_since` | enum? | `ImRisSeit` | `one_week` \| `two_weeks` \| `one_month` \| `three_months` \| `six_months` \| `one_year` |
| `page`, `page_size` | number? | `Seitennummer`, `DokumenteProSeite` | page_size ∈ {10, 20, 50, 100} → Ten/Twenty/Fifty/OneHundred. Default 20. |

**Output** (per record): `document_number` (Technisch.ID, e.g. NOR40262691), `application`, `short_title`, `title` (cleaned of `<br/>` markup), `abbreviation`, `section_label` (ArtikelParagraphAnlage), `law_id` + `law_url` (GesamteRechtsvorschriftUrl), `in_force_from` (Inkrafttretensdatum), `promulgation` (Kundmachungsorgan), `type` (BG/V/K…), `index`, `eli`, `celex_references` (parsed from Titel/Aenderung `[CELEX-Nr.: …]` markers — the EU-transposition hook), `content_urls` {xml, html, pdf, rtf}. Enrichment: total hits, page info, truncation, and an **echo of the applied `in_force_as_of`** (the server defaults it; the agent must see what was applied).

**Errors** (typed contract — shared conventions in Design Decisions › *No dead ends*):

| reason | code | when | recovery |
|:---|:---|:---|:---|
| `invalid_query` | ValidationError | RIS rejected a parameter value (in-band `Error @type="Client"` — message passed through verbatim; it enumerates valid elements/values) | "Correct the parameter RIS names in the message. Ground valid codes with ris_list_reference (topic: states, section_types, changed_since_intervals, or search_syntax)." |
| `upstream_error` | ServiceUnavailable (retryable) | RIS unreachable, 5xx, in-band `@type="Server"`, or HTML error page | "RIS is temporarily unavailable — retry after a short delay. If it persists, reduce page_size or narrow the query." |

**Zero hits = success + enrichment notice**, composed from the applicable fragments:

| Condition | Notice fragment |
|:---|:---|
| always | "0 documents matched." |
| `in_force_as_of` applied (i.e. not `include_all_versions`) | "Only versions in force on {date} were searched — a repealed or not-yet-enacted provision returns nothing. Set include_all_versions: true to search all historical versions." |
| `query` set | "query wildcards are trailing-only ('Datenschutz*', never '*schutz'); boolean operators UND/ODER/NICHT or AND/OR/NOT. Syntax reference: ris_list_reference topic search_syntax." |
| `title` set | "title matches title, short title, and abbreviation — try the official abbreviation ('DSG') with a trailing *." |
| looks like a citation (§/BGBl/GZ shape in `query` or `title`) | "For a specific citation, ris_lookup_citation resolves it deterministically instead of keyword search." |

### ris_search_case_law

One Judikatur application per call — upstream requires it, and merged cross-court paging would be incoherent. Cross-court research = one call per court (documented in the tool description; each call is cheap).

| Param | Type | Maps to | Notes |
|:---|:---|:---|:---|
| `court` | enum, required | `Applikation` | `vfgh` \| `vwgh` \| `justiz` \| `bvwg` \| `lvwg` \| `dsk` \| `normenliste` \| `dok` \| `pvak` \| `gbk` \| `uvs` \| `asylgh` \| `ubas` \| `umse` \| `bks` \| `verg` (✓ full set) |
| `query` | string? | `Suchworte` | Full-text over decisions. |
| `norm` | string? | `Norm` | Cited provision — "DSG §1", "DSGVO Art32", "GewO 1994 §129" (✓ format as returned in `Normen`). High-value filter. |
| `case_number` | string? | `Geschaeftszahl` | Exact Geschäftszahl returns that decision's docs (✓ 1 hit). |
| `decision_type` | enum? | `Dokumenttyp.SucheInRechtssaetzen` / `.SucheInEntscheidungstexten` | `headnote` \| `full_text` \| `all` (default — both flags false upstream searches everything ✓). |
| `decided_from` / `decided_to` | ISO date? | `EntscheidungsdatumVon/Bis` | |
| `issuing_body` | enum? | `EntscheidendeBehoerde` (✓) | **dsk only**: `datenschutzbehoerde` (2014+) \| `datenschutzkommission` (≤2013). Dsk is one application holding both bodies (+ Organ-separated PDKT docs). |
| `court_name` | string? | `Justiz.Gericht` | **justiz only**: filter within ordinary courts — "OGH", "OLG Wien", "LG Linz". |
| `state` | enum? | `Lvwg.Bundesland` | **lvwg only**: which of the 9 state administrative courts. |
| `changed_since`, `page`, `page_size` | | `ImRisSeit`, `Seitennummer`, `DokumenteProSeite` | as above |

**Output** (per record): `document_number` (e.g. DSBT_20251114_…, JFT_…, JJT_…), `court` (application), `organ` (Technisch.Organ — issuing body name), `case_numbers` (Geschaeftszahl — normalize to array; upstream is object-or-array), `decision_date`, `decision_type` (Rechtssatz \| Text), `summary` (Kurzinformation), `norms_cited` (array), `keywords` (Schlagworte), `ecli` (EuropeanCaseLawIdentifier), `decision_url` (GesamteEntscheidungUrl), `headnotes_url` (RechtssaetzeUrl), `content_urls`, `legal_force_note` (Anfechtung, where present). Enrichment: totals/paging.

**Errors** (typed contract):

| reason | code | when | recovery |
|:---|:---|:---|:---|
| `court_filter_mismatch` | ValidationError | A court-conditional filter was sent with the wrong `court` — thrown **locally, before any upstream call**; message names the actual offending pair (e.g. "issuing_body applies only to court 'dsk', got 'vfgh'") | "Drop the filter or switch court: issuing_body → dsk, court_name → justiz, state → lvwg. Court codes: ris_list_reference topic courts." |
| `invalid_query` | ValidationError | as legislation (RIS Client-error passthrough) | "Correct the parameter RIS names in the message. Valid court codes, decision types, and syntax: ris_list_reference (topic: courts, decision_types, or search_syntax)." |
| `upstream_error` | ServiceUnavailable (retryable) | as legislation | as legislation |

**Zero hits = success + enrichment notice**, composed from the applicable fragments:

| Condition | Notice fragment |
|:---|:---|
| always | "0 decisions in {court}. Other courts are separate calls — repeat per court." |
| `case_number` set | "Geschäftszahl formats differ per court ('Ra 2019/22/0184' = VwGH, 'G 287/2022' = VfGH, '6Ob56/25k' = OGH/justiz) — ris_lookup_citation auto-detects the court from the format; examples per court: ris_list_reference topic courts." |
| `norm` set | "norm must match RIS's cited-norm format ('DSG §1', 'DSGVO Art32' style as returned in norms_cited) — run a broader search first and copy the exact string from a result's norms_cited." |
| `decided_from/to` set and range predates the court's coverage window | "{court} coverage starts {year} — earlier decisions are not in RIS. Windows: ris_list_reference topic courts." |

### ris_search_gazette

Date-range/issuer browse of the *binding* promulgation record — the monitoring surface `lookup_citation` (point lookup) can't express. Federal: BgblAuth (2004+); date ranges predating 2004 route to BgblAlt (1945–2003) automatically, with a notice. State: LgblAuth + Bundesland filter.

| Param | Type | Maps to | Notes |
|:---|:---|:---|:---|
| `scope` | enum | controller + application | `federal` (default) \| Bundesland (as legislation) |
| `query` | string? | `Suchworte` | |
| `number` | string? | `Bgblnummer` | "BGBl. II Nr. 171/2026" or "171/2026" (✓ both). |
| `part` | enum? | `Teil.SucheInTeil1/2/3` | federal only: `part1` (Gesetze) \| `part2` (Verordnungen) \| `part3` (Staatsverträge). |
| `type` | enum? | `Typ.SucheIn…` | `laws` \| `regulations` \| `announcements` \| `other` (SucheInGesetzen/Verordnungen/Kundmachungen/Sonstiges). |
| `published_from` / `published_to` | ISO date? | `KundmachungsdatumVon/Bis` (✓ 18,749 → 76 for one month) | |
| `issuer` | string? | `EinbringendeStelle` | Ministry/body, e.g. "BMKOES". |
| `page`, `page_size` | | | as above |

**Output** (per record): `document_number` (BGBLA_2026_II_171), `gazette_number` (Bgblnummer), `part` (Teil), `type` (Typ: Gesetz/Verordnung/…), `published` (Ausgabedatum), `issuer` (Einbringer/Organ), `title`, `short_title`, `eli`, `binding: "authentic"`, `authentic_pdf_url` (the `Authentisch` DataType — amtssigniert .pdfsig ✓), `content_urls`. Enrichment: totals/paging + which application served the query (BgblAuth vs BgblAlt).

**Errors** (typed contract):

| reason | code | when | recovery |
|:---|:---|:---|:---|
| `scope_filter_mismatch` | ValidationError | `part` sent with a Bundesland `scope` — thrown locally; Landesgesetzblätter have no parts | "part (I/II/III) applies only to scope: federal — drop it for state gazettes. Part semantics: ris_list_reference topic gazette_parts." |
| `invalid_query` | ValidationError | as legislation (RIS Client-error passthrough) | "Correct the parameter RIS names in the message. Part and type semantics: ris_list_reference topic gazette_parts or law_types." |
| `upstream_error` | ServiceUnavailable (retryable) | as legislation | as legislation |

**Zero hits = success + enrichment notice**, composed from the applicable fragments:

| Condition | Notice fragment |
|:---|:---|
| always | "0 gazette entries matched." |
| `number` set | "Verify part and year — a 'BGBl. II' number returns nothing when filtered to part1. For a single known number, ris_lookup_citation resolves it directly (and routes pre-2004 numbers to BgblAlt)." |
| `number` set with `part` also set and they disagree | "number names part {X} but the part filter is {Y} — drop one." (local consistency check; a notice, not an error) |
| `issuer` set | "issuer is a phrase field — try the ministry abbreviation with a trailing * ('BMK*')." |
| date range predates 2004 (federal) | (auto-route already fired) "Range served by BgblAlt (1945–2003); pre-1945 gazettes are not in RIS." |

### ris_lookup_citation

Citation-first is how Austrian legal work happens. Parses the citation type and routes to the right application with a deterministic filter — bypassing keyword search. Returns `{ found: false, guidance }` (never a throw) when nothing resolves.

| Route | Trigger pattern | Upstream call |
|:---|:---|:---|
| Norm | "§ 6 DSG", "Art 10 B-VG", bare abbreviation "ABGB" | BrKons: `Titel={abbr}` + `Abschnitt.Von/Bis={n}` + `FassungVom` (today or `in_force_as_of`); falls back to LrKons only on explicit state hint |
| Gazette | "BGBl. I Nr. 165/1999", "BGBl. II Nr. 171/2026" | year ≥ 2004 → BgblAuth `Bgblnummer=`; year < 2004 → BgblAlt |
| Case number | "2025-0.934.677" (DSB), "Ra 2019/22/0184" (VwGH), "G 287/2022" (VfGH), "6Ob56/25k" (OGH), "W256 …" (BVwG) | Judikatur `Geschaeftszahl=` against the pattern-matched application; `court` hint short-circuits; ambiguous formats probe ≤ 2 candidate applications sequentially |

**Output:** `found`, `kind` (what it parsed the citation as), `resolution_note` (which application + filter resolved it), and the resolved record in the same normalized shape as the corresponding search tool (single best document; `alternatives_count` when >1 hit, with a pointer to the search tool for the full set).

**Errors** (typed contract): `upstream_error` only (ServiceUnavailable, retryable — as legislation). Unparseable/unresolvable input is a `found: false` *result*, not an error — the agent self-corrects better from structured guidance than from a throw (fleet lesson: eur-lex #22).

**`found: false` guidance strings** (per parse outcome — `guidance` is the recovery surface here, so every branch routes to a named tool):

| Outcome | `kind` | guidance |
|:---|:---|:---|
| Citation didn't classify | `unknown` | "Could not classify '{input}'. Expected forms — norm: '§ 6 DSG' / 'Art 10 B-VG'; gazette: 'BGBl. I Nr. 165/1999'; case number: 'Ra 2019/22/0184'. Formats: ris_list_reference topic citation_formats. Or set kind explicitly; for keyword search use ris_search_legislation / ris_search_case_law." |
| Norm parsed, no hit | `norm` | "No document for {abbr} § {n} in force on {date}. If the provision existed at another time, retry ris_search_legislation with title: '{abbr}', section_from/to: '{n}', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: '{abbr}*'. State law resolves only with an explicit state hint." |
| Gazette parsed, no hit | `gazette` | "No gazette entry for {number}. Verify part (I/II/III) and year; browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number." |
| Case number parsed, no hit | `case_number` | "No decision for '{GZ}' in {applications probed}. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query." |

### ris_get_document

Read + export. Two addressing modes:

1. `document_number` + `application` (from any search/lookup result) — server constructs the content URL from the per-application path-segment map (✓ BrKons→`/Dokumente/Bundesnormen/`, LrKons→`/Dokumente/Landesnormen/`, BgblAuth→`/Dokumente/BgblAuth/`, Dsk→`/Dokumente/Dsk/`; remaining Judikatur segments confirmed at build).
2. `document_url` — any `https://www.ris.bka.gv.at/Dokumente/…` URL passed through from a search result. Validated: host + path-prefix allowlist, nothing else fetched (SSRF guard).

`format`: `markdown` (default — fetch HTML, strip boilerplate CSS/layout, convert) | `html` (raw) | `xml` (RIS Nutzdaten schema) | `urls_only` (no fetch — all format links + authentic PDF).

**Output:** `text` (unless urls_only), `format`, `byte_size`, `content_urls` (always, all DataTypes incl. `Authentisch` when present), `binding_status`: `authentic` (BgblAuth/LgblAuth — with `authentic_pdf_url`) \| `consolidated_informational` (BrKons/LrKons — RIS disclaims warranty; only the gazette wording is binding) \| `decision` (Judikatur), echoed identifiers. Oversized text is truncated at a byte cap with `truncated: true` + the URLs for the full artifact — never silently.

**Errors** (typed contract):

| reason | code | when | recovery |
|:---|:---|:---|:---|
| `invalid_addressing` | ValidationError | Neither or both addressing modes provided, or `document_number` without `application` — thrown locally | "Provide exactly one addressing mode: document_number plus application (both from one search result), or a document_url from a result's content_urls." |
| `unsupported_url` | ValidationError | `document_url` fails the host + `/Dokumente/` path-prefix allowlist — thrown locally, nothing fetched | "Only ris.bka.gv.at /Dokumente/ URLs are fetchable — pass a URL exactly as returned in content_urls, or switch to document_number + application." |
| `document_not_found` | NotFound | Constructed/passed content URL 404s | "The document_number/application pairing didn't resolve — copy both verbatim from a fresh ris_search_legislation / ris_search_case_law / ris_search_gazette result, or resolve the citation with ris_lookup_citation. Document numbers are application-specific." |
| `upstream_error` | ServiceUnavailable (retryable) | Content host unreachable / 5xx | as legislation |

**Limitation (upstream):** the REST API has no search-by-document-number parameter, so this tool returns *content*, not fresh metadata — metadata rides the search/lookup step. The description states the call order.

### ris_list_reference

Static, offline (no upstream call), from the XSD-derived tables in this doc. `topic` enum:

`applications` (all controllers/applications by legal area, with coverage windows) · `courts` (the 16 Judikatur codes, English descriptions, active-vs-historical, Geschäftszahl format examples per court) · `states` (9 Bundesländer + enum spellings) · `decision_types` · `dpa_bodies` (Dsk's three Organ-separated bodies) · `changed_since_intervals` · `section_types` · `gazette_parts` (BGBl I/II/III semantics) · `law_types` (BG, V, K, …) · `search_syntax` (boolean operators, wildcard rules, phrase quoting) · `citation_formats` (the shapes `ris_lookup_citation` parses, with examples)

**Errors:** no typed contract — static and closedWorld; an invalid `topic` fails Zod enum validation before the handler, and baseline codes cover the rest. This tool is the *target* of recovery routing, not a source: most other tools' recovery hints and zero-hit notices end here.

## Domain Mapping

| Noun | Operations | Upstream |
|:-----|:-----------|:---------|
| Consolidated norm (§-level doc) | search (title/fulltext/section/date), fetch-all-of-law (`law_id`), read, export | `GET /Bundesrecht?Applikation=BrKons`, `GET /Landesrecht?Applikation=LrKons`, content host |
| Law (Rechtsvorschrift) | group key only (`Gesetzesnummer`) — no law-level endpoint; the web view (`GesamteRechtsvorschriftUrl`) is linked | — |
| Gazette issue (BGBl/LGBl) | browse (date/part/type/issuer), point lookup (number), read, export authentic PDF | `GET /Bundesrecht?Applikation=BgblAuth\|BgblAlt`, `GET /Landesrecht?Applikation=LgblAuth` |
| Decision (Rechtssatz/Text) | search (court/norm/date/fulltext), point lookup (Geschäftszahl), read | `GET /Judikatur?Applikation={court}` |
| Reference codes | list (static) | none |

Out of scope v1 (deferred, deliberate): `Begut` (draft bills in review), `RegV` (government bills), `Erv` (English translations of selected laws), `Erlaesse` (ministerial decrees), Gemeinden/Bezirke (municipal/district), `History` controller (bulk change-sync — a future mirror's entry point, not an interactive surface).

## Workflow Analysis

`ris_lookup_citation` (1–3 upstream calls):

| # | Call | Purpose | Arm |
|:--|:-----|:--------|:----|
| 1 | Parse citation locally | classify kind, extract abbr/§/number/year | always |
| 2 | Deterministic search on routed application | resolve to document(s) | always |
| 3 | Second-candidate application probe | ambiguous case-number formats only | case_number, ≤ 1 retry |

`ris_get_document` (0–1 upstream calls): construct/validate URL → fetch (skipped for `urls_only`) → convert. No metadata call exists (see Known Limitations).

All other tools: single upstream call. No internal pagination loops exist in v1 — the agent pages explicitly.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `RisService` | RIS OGD REST v2.6 (`data.bka.gv.at`) + document content host (`www.ris.bka.gv.at`) | all tools except `ris_list_reference` |

One service, two base URLs. Methods: `searchLegislation`, `searchGazette`, `searchCaseLaw` (thin per-class param builders over one `search(controller, params)` core), `fetchDocumentContent(url)`. Plus the **normalizer** — the heart of the service layer:

- Unwrap `OgdSearchResult.OgdDocumentResults`; coerce `OgdDocumentReference` object-or-array → array (single-hit responses collapse ✓)
- `Hits` `{@pageNumber, @pageSize, #text}` → `{ page, pageSize, total }` numbers
- **Check `OgdSearchResult.Error` on every HTTP 200 before treating it as success** (✓ domain errors arrive in-band): `Error.@type = "Client"` → InvalidParams (pass RIS's message through — it enumerates valid elements/values); `"Server"` → ServiceUnavailable
- Coerce object-or-array on `Geschaeftszahl.item`, `Normen.item`, `Indizes.item`, `ContentReference`
- Strip `<br/>`/HTML remnants from Titel/Anmerkung fields; parse `[CELEX-Nr.: …]` → `celex_references`
- Map `ContentUrl[]` `{DataType, Url}` → keyed `{ xml, html, pdf, rtf, authentic }`

Resilience: `withRetry` at `baseDelayMs: 1500` (rate-limited-API calibration) wrapping fetch+parse; `fetchWithTimeout` for HTTP status handling; HTML-error-page detection classified transient, not SerializationError. **Never forward unmapped param names upstream — unknown flat params are silently ignored (✓), so a typo'd passthrough returns wrong results, not an error.** The service builds requests exclusively from the confirmed-spelling table (API Reference below).

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `RIS_API_BASE_URL` | no | Default `https://data.bka.gv.at/ris/api/v2.6` |
| `RIS_CONTENT_BASE_URL` | no | Default `https://www.ris.bka.gv.at` (document content + allowlist host for `document_url`) |
| `RIS_CONTACT` | no | Contact string appended to the User-Agent (RIS netiquette asks integrators to be identifiable; `ris.it@bka.gv.at` is their contact) |

No pagination/pacing knobs in v1 — there are no internal request loops to pace (the catalog sketch anticipated `RIS_PAGE_DELAY_MS`/`RIS_MAX_AUTO_PAGES`; dropped as speculative until a tool actually loops). Reactive backoff via `withRetry` covers upstream throttling.

## Implementation Order

1. Config + server setup (identity: `ris-austria-mcp-server`)
2. `RisService` — request builder (confirmed-spelling table), normalizer, error-envelope handling; integration-test against live API (cheap, keyless)
3. `ris_list_reference` (static — no service dependency, grounds everything else)
4. `ris_search_legislation`
5. `ris_search_case_law`
6. `ris_search_gazette`
7. `ris_lookup_citation` (composes the three service methods)
8. `ris_get_document` (content fetch + markdown conversion + binding labels)
9. `ris://document/{application}/{documentNumber}` resource (thin over get_document path)
10. Polish: descriptions audit vs this doc, `devcheck`, live field-test each document class

## Design Decisions

- **`in_force_as_of` defaults to today.** Omitting `FassungVom` upstream searches *all historical versions* (✓ 436 vs 77 hits for the same query) — the wrong default for "what does the law say" and a silent-wrongness trap. Historical research is the explicit opt-in (`include_all_versions` or a past date). Output echoes the applied date so the default is never invisible.
- **Three search tools, split by document class — not one, not per-application.** Legislation, case law, and gazette diverge on filter grammar *and* result semantics (in-force dates vs decision metadata vs promulgation record). Within each class, applications collapse into a `scope`/`court` enum. This *adds* a gazette search over the catalog sketch: the sketch's "no gazette search tool" reasoning was that keyword search would duplicate `lookup_citation` — correct, but date-range/issuer *browse* ("what landed in BGBl. II this month") is a real monitoring goal the resolver can't express, and it's the binding record, so it earns the third tool.
- **No cross-court fan-out in `search_case_law`.** Upstream takes one Judikatur application per request; merging N applications server-side breaks pagination and hit-count semantics, and multiplies upstream load invisibly. The agent fans out explicitly — one call per court — and the description says so.
- **A citation resolver is a first-class tool.** Austrian legal work is citation-first ("§ 1295 ABGB", a Geschäftszahl, a BGBl number). Deterministic filters (Abschnitt + Titel, Bgblnummer, Geschaeftszahl ✓ all exact-resolving) beat keyword search for this. `found: false` result on no-resolve, never a throw (fleet precedent: eur-lex `lookup_celex`, courtlistener/pubmed `lookup_citation`).
- **Binding status is explicit output, everywhere.** RIS disclaims warranty on consolidated views; only the amtssigniert gazette wording is legally binding. Every `get_document`/gazette record carries `binding_status`, and the authentic `.pdfsig` URL is surfaced whenever the `Authentisch` DataType exists (✓). The server never presents consolidated text as the binding text.
- **English surface, German as domain vocabulary.** Tool/param names are English (`query`, `in_force_as_of`, `court`); the service maps to RIS's German param names internally. German remains only where it *is* the identifier: Austrian legal proper nouns (Bundesgesetzblatt, Geschäftszahl, Rechtssatz — always glossed in descriptions) and returned legal text (data, not interface).
- **Strict param allowlist in the service.** Unknown query params are silently ignored upstream (✓) — the single nastiest API trap here, since a typo returns *plausible but unfiltered* results. Only live-confirmed or XSD-verified spellings from the API Reference table are ever sent; new filters require a probe first.
- **No DataCanvas.** Search results are categorical legal metadata for find-then-drill-in workflows, not analytical row sets — fails the shape test regardless of size.
- **No blanket per-call sleep.** RIS's ~1–2s pacing guidance targets bulk/paged retrieval, not interactive lookups. Reactive `withRetry` backoff (1.5s base) fires only when upstream actually signals distress; v1 has no internal loops to pace (and the pacing env knobs were dropped with them).
- **No dead ends — every terminal surface routes to a named tool.** Error `recovery` strings, zero-hit enrichment notices, and `lookup_citation`'s `found: false` guidance each name the concrete next call (`ris_list_reference` topic X, `ris_lookup_citation`, the specific search tool) — never bare "check your input". The per-tool contract tables carry the verbatim strings; three shared mechanics: (1) RIS Client-error messages pass through verbatim (they enumerate valid values) with recovery routing to `ris_list_reference`; (2) conditional-param misuse (`court_filter_mismatch`, `scope_filter_mismatch`, `invalid_addressing`) is caught locally before any upstream call, message naming the actual offending pair; (3) zero hits are success + notice, never an error. Rationale: six tools over an opaque German-coded corpus is navigable only if every stuck-state says where to go next.
- **Tool prefix `ris_`, name `ris-austria-mcp-server`** (settled in the fleet catalog 2026-07-04): official RIS brand + country disambiguator; clash-free in the fleet.

## Known Limitations

- **No document-by-number search upstream** (no `Dokumentnummer` request param in any XSD; SOAP-only `GetDocNumbers` has no REST equivalent). `get_document` therefore fetches content via constructed/passed-through URLs and cannot return fresh metadata for a bare ID. Metadata comes from search/lookup results.
- **One court application per case-law call** — cross-court coverage is N explicit calls.
- **Coverage windows vary by application:** VfGH 1980+, VwGH 1990+ (older selected), BVwG/LVwG 2014+, Dsk 1990+ (selected), BgblAuth 2004+ (BgblAlt covers 1945–2003; 1848–1940 gazettes are ÖNB-hosted images, out of scope). Justiz is *selected* decisions, not the full ordinary-court record. `list_reference` carries the windows.
- **Per-§ document granularity:** one law = many documents sharing a `law_id`. "The whole DSG" is a `law_id`-filtered search (77 docs), not one document; the web `GesamteRechtsvorschriftUrl` is linked for humans. A stitched full-law markdown export is a deliberate non-goal for v1 (77 content fetches).
- **Consolidated text is not legally binding** — inherent to RIS, handled by labeling, not solvable.
- **A decision may appear as multiple documents** (N Rechtssatz docs + 1 Text doc sharing a Geschäftszahl). Results are type-labeled; deduplication is the agent's call.
- **ELI coverage varies** — federal law/gazette hits carry ELI consistently; the LrKons probe returned no ELI at the expected path (✓). Field mapping per application verified at build; `eli` is optional in output schemas.
- **German-language corpus:** legal text returns in German (Austrian law *is* German); `Erv` (English translations of selected laws) exists upstream and is a candidate future scope.

## API Reference (live-confirmed 2026-07-04)

Base: `https://data.bka.gv.at/ris/api/v2.6/{controller}` — GET, JSON responses (JSON-serialized XML: `@attr`/`#text` nodes, object-or-array lists). Health: `GET /Version` → `{"OgdSearchResult":{"Version":"2.6"}}` ✓. Content host: `https://www.ris.bka.gv.at/Dokumente/{segment}/{DOKNR}/{DOKNR}.{xml|html|rtf|pdf}` (+ `.pdfsig` as `Authentisch`).

**Controllers → applications** (✓ enumerated via schema-validation errors, which list valid child elements):

| Controller | Applications | Shared top-level params |
|:---|:---|:---|
| `Bundesrecht` | BrKons, BgblAuth, BgblPdf, BgblAlt, Begut, RegV, Erv | `Suchworte`, `Titel` |
| `Landesrecht` | LrKons, LgblAuth, Lgbl, LgblNO, Vbl | `Suchworte`, `Titel` |
| `Judikatur` | Vfgh, Vwgh, Normenliste, Justiz, Bvwg, Lvwg, Dsk, Dok, Pvak, Gbk, Uvs, AsylGH, Ubas, Umse, Bks, Verg | `Suchworte`, `Dokumenttyp`, `Geschaeftszahl`, `Norm`, `EntscheidungsdatumVon/Bis` |
| `Sonstige` | PruefGewO, Avsv, Spg, Avn, KmGer, Upts, Mrp, Erlaesse | `Suchworte`, `Titel` |
| `Bezirke`, `Gemeinden` | district/municipal promulgations | out of scope v1 |
| `History` | change-sync per application (`Anwendung`, `AenderungenVon/Bis`, `IncludeDeletedDocuments`) | out of scope v1 |
| `Version` | version string | health check |

**Param notation (the key discovery):** scalar leaf params are flat query params (`FassungVom=2026-07-04` ✓, `EntscheidendeBehoerde=Datenschutzbehoerde` ✓, `KundmachungsdatumVon=…` ✓); children of complex-typed elements use **dot-paths** (`Abschnitt.Von=1&Abschnitt.Bis=1&Abschnitt.Typ=Paragraph` ✓, `Bundesland.SucheInWien=true` ✓, `Dokumenttyp.SucheInRechtssaetzen=true` ✓). **Unknown names — flat or dotted — are silently ignored, never errors** ✓. Invalid *values* of known enum/element params DO error (schema validation) ✓.

**Paging/envelope params:** `Applikation` (required, selects the application within the controller), `DokumenteProSeite` ∈ {Ten, Twenty, Fifty, OneHundred} (default Twenty ✓), `Seitennummer` (1-based), `ImRisSeit` ∈ {EinerWoche, ZweiWochen, EinemMonat, DreiMonaten, SechsMonaten, EinemJahr}.

**Search expression types** (from the OGD handbook + XSDs): `Suchworte` is a FulltextSearchExpression — RIS web grammar (boolean `UND/ODER/NICHT` + English equivalents, parens, quoted phrases; wildcard `*` trailing-only). `Titel`, `Bgblnummer`, `EinbringendeStelle`, `Kundmachungsorgan(nummer)` are Phrase/Term expressions — `*` allowed leading *or* trailing. `Gesetzesnummer` is exact-match, no wildcards.

**Application-specific request params** (✓ = live-verified; others XSD-verified, confirm spelling at build):

| Application | Params |
|:---|:---|
| BrKons | `FassungVom` ✓ (omit = all versions ✓), `Abschnitt.Von/Bis/Typ` ✓ (Typ ∈ Alle/Artikel/Paragraph/Anlage), `Gesetzesnummer`, `Index`, `Typ`, `Kundmachungsorgan`, `Kundmachungsorgannummer`, `Unterzeichnungsdatum`, `Sortierung.SortDirection/SortedByColumn` |
| LrKons | `Bundesland.SucheIn{Burgenland,Kaernten,Niederoesterreich,Oberoesterreich,Salzburg,Steiermark,Tirol,Vorarlberg,Wien}` ✓, `FassungVom`, `Abschnitt.*`, `Index`, `Typ` |
| BgblAuth | `Bgblnummer` ✓, `KundmachungsdatumVon/Bis` ✓, `Teil.SucheInTeil1/2/3`, `Typ.SucheIn{Gesetzen,Verordnungen,Kundmachungen,Sonstiges}`, `EinbringendeStelle` |
| Judikatur (all) | `Geschaeftszahl` ✓ (exact GZ → 1 hit), `Norm`, `EntscheidungsdatumVon/Bis`, `Dokumenttyp.SucheInRechtssaetzen` ✓ / `.SucheInEntscheidungstexten` |
| Dsk | `EntscheidendeBehoerde` ✓ ∈ {Datenschutzkommission, Datenschutzbehoerde} (1864 total → 452 for DSB ✓), `Entscheidungsart` (DskEntscheidungsart enum) |
| Justiz | `Gericht` (court name within Justiz), `Rechtsgebiet` ∈ {Strafrecht, Zivilrecht}, `Fachgebiet`, `Rechtssatznummer`, `Entscheidungsart`, `RechtlicheBeurteilung`, `Spruch`, `Fundstelle` |
| Vfgh / Vwgh | `Entscheidungsart` (per-court enum), `Index`, `Sammlungsnummer` |
| Bvwg | `Entscheidungsart` |
| Lvwg | `Entscheidungsart`, `Bundesland` (single-value enum, not the SucheIn* flags) |

**Response envelope:** success → `OgdSearchResult.OgdDocumentResults` with `Hits {@pageNumber, @pageSize, #text}` ✓ and `OgdDocumentReference` (object when 1 hit, array when >1 ✓). Each hit: `Data.Metadaten.Technisch {ID, Applikation, Organ, Einbringer?}`, `Data.Metadaten.Allgemein {Veroeffentlicht, Geaendert, DokumentUrl}`, `Data.Metadaten.{Bundesrecht|Landesrecht|Judikatur} {…class fields incl. Eli / EuropeanCaseLawIdentifier}` ✓, `Data.Dokumentliste.ContentReference{,[]}` with `ContentType` ∈ {MainDocument, Attachment, Material, Statement, Letter, EmbeddedAttachment, BaseDocument} and `Urls.ContentUrl[] {DataType, Url}`, DataType ∈ {Xml, Html, Pdf, Rtf, Authentisch, Gif, Jpg, Tiff, Png, Odt, Docx, Unknown} ✓ (Authentisch = amtssigniert `.pdfsig`).

**Errors arrive in-band on HTTP 200** ✓: `OgdSearchResult.Error {@type: "Client"|"Server", Applikation, Message}` — Client messages are schema-validation errors that enumerate valid elements/values (useful passthrough). **A not-found document/GZ is NOT an error** — status ok, `Hits = 0` ✓.

**Netiquette** (RIS OGD guidance): descriptive User-Agent + contact; pace paged/bulk retrieval ~1–2 s (interactive lookups exempt); notify `ris.it@bka.gv.at` before mass downloads; prefer off-hours for bulk. Hosted posture: search-read-export traffic is well within guidance; no full-corpus crawls through the tool surface.

**Licensing:** RIS OGD data CC BY 4.0 (attribution required — server description credits RIS/BKA); underlying legal texts are copyright-free official works (UrhG §7). Only the authentic Bundesgesetzblatt wording is legally binding.
