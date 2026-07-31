# ris-austria-mcp-server — Design

Austrian federal, state, district, and municipal law, court decisions, the lawmaking pipeline, and official sectoral gazettes via the RIS (Rechtsinformationssystem des Bundes) OGD REST API v2.6 — keyless, CC BY 4.0. Designed 2026-07-04, revised to full-surface scope 2026-07-05; all "✓ live-confirmed" markers were verified against the production API on those dates.

**v1 covers the entire OGD surface.** Every application the API exposes (Table 1 of the OGD-RIS API Handbook V2.6) is reachable through a tool — there is no deferred tier. Decision (2026-07-05): build everything at once rather than staging; the per-application cost is a param-map row and routing, not a new architecture, and a complete surface makes the server the single Austrian-law entry point rather than a subset with surprise gaps.

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `ris_search_legislation` | Search consolidated federal + state + municipal law (one doc = one §/Artikel/Anlage) and English translations of selected laws. Flagship filter: in-force-as-of date. | `query`, `title`, `scope` (federal \| 9 Bundesländer), `municipality` (→ municipal law), `language` (german \| english → Erv), `in_force_as_of` (default today), `include_all_versions`, `entered_force_from/to`, `left_force_from/to`, `section_from/to`, `section_type`, `law_id`, `index`, `changed_since`, `sort_by`, `sort_direction`, `page`, `page_size` | readOnly, idempotent, openWorld |
| `ris_search_case_law` | Search Judikatur in one court/tribunal application per call (VfGH, VwGH, Justiz, BVwG, LVwG, DSB, UPTS, …). | `court` (enum of 17, required), `query`, `norm`, `case_number`, `decision_type`, `decided_from/to`, `decision_kind`, `collection_number` (vfgh/vwgh/uvs), `issuing_body` (dsk/dok/pvak/verg), `court_name`, `legal_area`, `subject_area` (justiz), `state` (lvwg/uvs), `party` (upts), `commission`, `senate`, `discrimination_ground` (gbk), `subject_law` (bks), `changed_since`, `sort_by`, `sort_direction`, `page`, `page_size` | readOnly, idempotent, openWorld |
| `ris_search_gazette` | Browse the promulgation record at every level — federal (three era tiers, auto-routed), state law + ordinance gazettes, district, municipal. The compliance-monitoring surface. | `scope` (federal \| 9 Bundesländer \| district \| municipal), `series` (law_gazette \| ordinance_gazette), `state_era` (current \| legacy), `query`, `title`, `number`, `part` (incl. `pre_1997`), `type`, `published_from/to`, `issuer`, `district_authority`, `municipality`, `sort_by`, `sort_direction`, `page`, `page_size` | readOnly, idempotent, openWorld |
| `ris_search_drafts` | Search the federal lawmaking pipeline: ministerial review drafts (Begutachtungsentwürfe) and government bills (Regierungsvorlagen, 2004+). | `stage` (review_drafts \| government_bills, required), `query`, `title`, `ministry`, `in_review_on` (review-only), `decided_from/to` (bills-only), `changed_since`, `sort_by`, `sort_direction`, `page`, `page_size` | readOnly, idempotent, openWorld |
| `ris_search_announcements` | Search sectoral official gazettes and executive documents: social-insurance official notices, veterinary notices, court rules of procedure, trade-exam regulations, health structure plans, ministerial decrees, council-of-ministers minutes. | `collection` (enum of 7, required), `query`, `title`, `number`, `published_from/to`, `in_force_as_of`, `issuer`, `norm`, `case_number`, `type`, `department`, `plan_type`, `plan_state`, `session_number`, `legislature`, `changed_since`, `sort_by`, `sort_direction`, `page`, `page_size` | readOnly, idempotent, openWorld |
| `ris_lookup_citation` | Deterministic resolver: one legal citation → the canonical RIS document. Handles norm cites ("§ 6 DSG", abbreviation-first "DSG §1"), gazette cites across all three federal eras + LGBl, case numbers ("2025-0.934.677"), collection numbers ("VfSlg 19.632/2012"). Returns `found: false`, never throws, on no-resolve. | `citation`, `kind` (auto \| norm \| gazette \| case_number \| collection_number), `court` (hint), `state` (hint), `in_force_as_of` | readOnly, idempotent, openWorld |
| `ris_get_document` | Fetch one document's full text (markdown/html/xml) or its export URLs, with binding-status labeling and the authentic PDF surfaced wherever it exists. | `document_number` + `application`, or `document_url`; `format` (markdown \| html \| xml \| urls_only) | readOnly, idempotent, openWorld |
| `ris_track_changes` | Precise change feed per application: every document added/changed in a date window, optionally including deletions — the delta-sync and monitoring primitive `changed_since` intervals can't express. | `application` (enum, required), `changed_from`, `changed_to`, `include_deleted`, `page`, `page_size` | readOnly, idempotent, openWorld |
| `ris_list_reference` | Ground the opaque German codes: applications + coverage windows, courts, states, decision types/kinds, issuing bodies, ministries, collections, gazette tiers/parts, district authorities, Justiz subject areas, search syntax, citation formats. Static, offline. | `topic` (enum) | readOnly, idempotent, closedWorld |

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `ris://document/{application}/{documentNumber}` | Markdown text of one RIS document — injectable twin of `ris_get_document` | No |

### Prompts

None in v1. An EU→AT transposition research prompt was considered and deferred — the workflow (eur-lex CELEX → `ris_search_legislation` title/CELEX match → `ris_search_case_law`) chains naturally without a template, and prompts are the least-supported client primitive.

## Overview

The Austrian-national counterpart to `eur-lex-mcp-server`. RIS is the Austrian government's official legal database: consolidated federal/state/municipal law, case law across every Austrian court and tribunal, the authentic (legally binding) gazettes at every level of government, the pre-parliamentary lawmaking pipeline, and ministerial decrees. The OGD REST API is keyless and CC BY 4.0.

**Audience:** Austrian legal practitioners, compliance/regulatory teams, GovTech, legal-research agents. Data-protection compliance (DSG/DSGVO, Datenschutzbehörde + BVwG/VwGH/VfGH case law) is the anchor use case: "current in-force text as of date X" and DPA case law are the daily questions.

**Seven document classes** drive the tool split:

| Class | Applications | Legally binding? | Reached via |
|:---|:---|:---|:---|
| Consolidated law | BrKons (federal), LrKons (state), Gr (municipal, selected), LgblNO (NÖ systematic collection) | No — informational | `search_legislation`, `search_gazette` (LgblNO), `lookup_citation` |
| English translations | Erv (selected federal laws) | No — unofficial | `search_legislation` (`language: english`) |
| Authentic promulgation | BgblAuth (2004+), LgblAuth, Vbl, Bvb (district), GrA (municipal) + sectoral: Avsv, Avn, KmGer, PruefGewO, Spg | **Yes** (amtssigniert PDF) | `search_gazette`, `search_announcements`, `lookup_citation` |
| Historical gazettes | BgblPdf (1945–2003), BgblAlt (1848–1940), Lgbl (state, non-authentic) | No — record of superseded/pre-e-Recht promulgations | `search_gazette`, `lookup_citation` |
| Case law (Judikatur) | Vfgh, Vwgh, Justiz, Bvwg, Lvwg, Dsk + 10 historical/specialized + Upts | n/a | `search_case_law`, `lookup_citation` |
| Lawmaking pipeline & executive records | Begut, RegV (drafts/bills); Mrp (council minutes), Erlaesse (ministerial decrees) | No (Erlässe bind the administration internally) | `search_drafts`, `search_announcements` |
| Change feed | History (per-application deltas) | n/a | `track_changes` |

## Requirements

- Search, read, export across all seven document classes — the full OGD application surface, no deferred tier
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
6. Monitor new promulgations ("what landed in BGBl. II in June") and recently changed consolidated law — at federal, state, district, and municipal level
7. Get the authentic, legally binding gazette artifact (amtssigniert PDF) — never a paraphrase
8. Bridge an EU act to its Austrian transposition (CELEX references parsed from BrKons metadata → eur-lex)
9. Watch the lawmaking pipeline: what is in review (Begutachtung) right now, which government bills the council adopted, what the council of ministers decided
10. Find ministerial decrees interpreting a norm ("BMF decrees citing the DSG") and sectoral official notices (social insurance, veterinary, health structure plans)
11. Read historical promulgations back to 1848 (metadata + scans) and post-war gazettes 1945–2003 in full text
12. Sync precisely against a change window per application, deletions included (`track_changes`)

## Tools — detail

### ris_search_legislation

One tool spans federal (BrKons), state (LrKons), and municipal (Gr) consolidated law plus English translations (Erv) — the filter grammars are near-identical where they overlap; `scope` + `municipality` + `language` route.

| Param | Type | Maps to | Notes |
|:---|:---|:---|:---|
| `query` | string? | `Suchworte` (Erv: `SearchTerms` ✓) | Full-text. Boolean `UND`/`ODER`/`NICHT` (also `AND`/`OR`/`NOT` ✓), parens, quoted phrases. Wildcard `*` trailing-only here. |
| `title` | string? | `Titel` (Erv: `Title` ✓) | Matches title, short title, and abbreviation ("ABGB", "DSG"). Phrase-type field: `*` allowed leading or trailing. |
| `scope` | enum | controller + `Bundesland.SucheIn<Land>` (LrKons) / `Bundesland` (Gr) | `federal` (default) \| `burgenland` \| `kaernten` \| `niederoesterreich` \| `oberoesterreich` \| `salzburg` \| `steiermark` \| `tirol` \| `vorarlberg` \| `wien` |
| `municipality` | string? | `Gemeinde` + routes to Gemeinden/Gr | Municipal law (✓ 18,250 docs; Wien 869 ✓). Requires a state `scope`; supports `query`, `title`, `in_force_as_of` only (Gr has `FassungVom` ✓) — other filters throw `scope_filter_mismatch`. Coverage: selected norms, 6 Bundesländer (see Known Limitations). |
| `language` | enum? | routes to Erv | `german` (default) \| `english` — English translations of selected federal laws (✓ 138 docs). Requires `scope: federal`; supports `query` + `title` only (Erv has no date/section params — English param names `SearchTerms`/`Title` ✓ 109/2 hits). |
| `in_force_as_of` | ISO date? | `FassungVom` | **Default: today.** Omitting FassungVom upstream searches ALL historical versions — silently wrong default for "current law" questions (✓ 77 vs 436 hits). |
| `include_all_versions` | boolean? | omits `FassungVom` | Explicit opt-in for version-history research. Overrides `in_force_as_of`. |
| `entered_force_from/to` | ISO date? | `Fassung.VonInkrafttretensdatum` / `.BisInkrafttretensdatum` | "Provisions that entered force in window" — new-law tracking. Mutually exclusive with `in_force_as_of`/`include_all_versions` (upstream: FassungVom OR window params). BrKons/LrKons only. |
| `left_force_from/to` | ISO date? | `Fassung.VonAusserkrafttretensdatum` / `.BisAusserkrafttretensdatum` | Repeal-window counterpart. Same exclusivity. |
| `section_from` / `section_to` | string? | `Abschnitt.Von` / `Abschnitt.Bis` | "6", "1a" — §/Artikel/Anlage number-or-letter range (✓). |
| `section_type` | enum? | `Abschnitt.Typ` | `Alle` \| `Artikel` \| `Paragraph` (default when section range set) \| `Anlage` |
| `law_id` | string? | `Gesetzesnummer` | Law-level grouping key (e.g. 10001597 = DSG) — fetch all §§ of one law. Exact match. BrKons/LrKons only. |
| `index` | string? | `Index` | Systematik classification ("10/10 Datenschutz"). BrKons/LrKons only (Gr's Index is a fixed 10-value enum — v1 routes municipal thematic browsing through `query`). |
| `changed_since` | enum? | `ImRisSeit` | `one_week` \| `two_weeks` \| `one_month` \| `three_months` \| `six_months` \| `one_year` |
| `sort_by`, `sort_direction` | enum? | `Sortierung.SortedByColumn/.SortDirection` | `section` (ArtikelParagraphAnlage) \| `in_force_date` (Inkrafttretensdatum); `ascending` \| `descending`. |
| `page`, `page_size` | number? | `Seitennummer`, `DokumenteProSeite` | page_size ∈ {10, 20, 50, 100} → Ten/Twenty/Fifty/OneHundred. Default 20. |

**Output** (per record): `document_number` (Technisch.ID, e.g. NOR40262691, GEMRE_WI_… for municipal, ERV_1999_1_165 for English), `application`, `short_title`, `title` (cleaned of `<br/>` markup), `abbreviation`, `section_label` (ArtikelParagraphAnlage), `law_id` + `law_url` (GesamteRechtsvorschriftUrl), `in_force_from` (Inkrafttretensdatum), `promulgation` (Kundmachungsorgan), `type` (BG/V/K…), `index`, `eli`, `celex_references` (parsed from Titel/Aenderung `[CELEX-Nr.: …]` markers — the EU-transposition hook), `municipality` (Gr), `content_urls` {xml, html, pdf, rtf}. Enrichment: total hits, page info, truncation, and an **echo of the applied `in_force_as_of`** (the server defaults it; the agent must see what was applied).

**Errors** (typed contract — shared conventions in Design Decisions › *No dead ends*):

| reason | code | when | recovery |
|:---|:---|:---|:---|
| `scope_filter_mismatch` | ValidationError | `municipality` without a state scope, `language: english` off federal, section/law_id/index/date-window filters combined with `municipality` or `language: english`, or `entered_force_*`/`left_force_*` combined with `in_force_as_of`/`include_all_versions` — thrown **locally, before any upstream call**; message names the actual offending pair | "Drop the named filter or adjust scope: municipality needs a state scope and supports query/title/in_force_as_of; english supports query/title under scope: federal. Version filters are exclusive — pick in_force_as_of, include_all_versions, OR a force-window." |
| `invalid_query` | ValidationError | a `page` past the last available page, or RIS rejecting a parameter value (in-band `Error @type="Client"` — message passed through verbatim; it enumerates valid elements/values, except for a page past the end, which names nothing) | "For a page past the end, request a lower page, starting from 1. Otherwise correct the parameter named in the message. Ground valid codes with ris_list_reference (topic: states, section_types, changed_since_intervals, or search_syntax)." |
| `upstream_error` | ServiceUnavailable (retryable) | RIS unreachable, 5xx, in-band `@type="Server"`, or HTML error page | "RIS is temporarily unavailable — retry after a short delay. If it persists, reduce page_size or narrow the query." |

**Zero hits = success + enrichment notice**, composed from the applicable fragments:

| Condition | Notice fragment |
|:---|:---|
| always | "0 documents matched." |
| `in_force_as_of` applied (i.e. not `include_all_versions`) | "Only versions in force on {date} were searched — a repealed or not-yet-enacted provision returns nothing. Set include_all_versions: true to search all historical versions." |
| `query` set | "query wildcards are trailing-only ('Datenschutz*', never '*schutz'); boolean operators UND/ODER/NICHT or AND/OR/NOT. Syntax reference: ris_list_reference topic search_syntax." |
| `title` set | "title matches title, short title, and abbreviation — try the official abbreviation ('DSG') with a trailing *." |
| `municipality` set | "Municipal coverage is selected norms in 6 Bundesländer (no Burgenland/Tirol/Vorarlberg) — coverage: ris_list_reference topic applications. The municipality name must match RIS's spelling ('Graz', not 'Stadt Graz')." |
| `language: english` set | "Erv holds ~138 selected translations only — absence means untranslated, not nonexistent. Search the German original instead (language: german)." |
| looks like a citation (§/BGBl/GZ shape in `query` or `title`) | "For a specific citation, ris_lookup_citation resolves it deterministically instead of keyword search." |

### ris_search_case_law

One Judikatur application per call — upstream requires it, and merged cross-court paging would be incoherent. Cross-court research = one call per court (documented in the tool description; each call is cheap). `upts` (Parteien-Transparenz-Senat) rides this tool — its documents are decisions with GZ/date/norm semantics — routed internally to the Sonstige controller.

| Param | Type | Maps to | Notes |
|:---|:---|:---|:---|
| `court` | enum, required | `Applikation` | `vfgh` \| `vwgh` \| `justiz` \| `bvwg` \| `lvwg` \| `dsk` \| `normenliste` \| `dok` \| `pvak` \| `gbk` \| `uvs` \| `asylgh` \| `ubas` \| `umse` \| `bks` \| `verg` (✓ full set) \| `upts` (✓ 35 docs, Sonstige controller) |
| `query` | string? | `Suchworte` | Full-text over decisions. |
| `norm` | string? | `Norm` | Cited provision — "DSG §1", "DSGVO Art32", "GewO 1994 §129" (✓ format as returned in `Normen`). High-value filter. Also on upts ✓ handbook. |
| `case_number` | string? | `Geschaeftszahl` (upts: `GZ`) | Exact Geschäftszahl returns that decision's docs (✓ 1 hit). Not available for `normenliste`. |
| `decision_type` | enum? | `Dokumenttyp.SucheInRechtssaetzen` / `.SucheInEntscheidungstexten` | `headnote` \| `full_text` \| `all` (default — both flags false upstream searches everything ✓). Not on gbk/upts/normenliste (guarded). |
| `decided_from` / `decided_to` | ISO date? | `EntscheidungsdatumVon/Bis` (upts: `Entscheidungsdatum.Von/Bis`) | Not on normenliste. |
| `decision_kind` | string? | `Entscheidungsart` | Per-court enums (Erkenntnis/Beschluss/Bescheid/…, Dsk's Bescheid* taxonomy, Verg's Vorabentscheidung set). Validated locally against the per-court table; values: ris_list_reference topic decision_kinds. |
| `collection_number` | string? | `Sammlungsnummer` | **vfgh/vwgh/uvs only**: official collection number (VfSlg/VwSlg cites). Accepted form differs by court — vfgh/uvs match the bare number dotted or undotted ("19632", "19.632"); vwgh stores the full labelled undotted cite ("VwSlg 18000 A/2010") and matches nothing on a bare or dotted number, so the space-anchored prefix "VwSlg 18000 *" covers an unknown part letter or year. |
| `issuing_body` | string? | `EntscheidendeBehoerde` | **dsk/dok/pvak/verg only** (✓ dsk live; others handbook): dsk `datenschutzbehoerde` (2014+) \| `datenschutzkommission` (≤2013); dok/pvak/verg take their body names — values: ris_list_reference topic issuing_bodies. |
| `court_name` | string? | `Justiz.Gericht` | **justiz only**: filter within ordinary courts — "OGH", "OLG Wien", "LG Linz". |
| `legal_area` | enum? | `Justiz.Rechtsgebiet` | **justiz only**: `civil` (Zivilrecht) \| `criminal` (Strafrecht). |
| `subject_area` | string? | `Justiz.Fachgebiet` | **justiz only**: fixed subject taxonomy ("Datenschutzrecht", "Insolvenzrecht", 39 values — ris_list_reference topic justiz_subject_areas). ⚠ Currently unpopulated upstream (every value returns 0 hits corpus-wide, verified 2026-07-05) — description must steer agents to `query`/`norm` until RIS populates the tags. |
| `state` | enum? | `Lvwg.Bundesland` / `Uvs.Bundesland` | **lvwg/uvs only**: which of the 9 state administrative courts/senates (single-value enum, not SucheIn* flags). |
| `party` | enum? | `Upts.Partei` | **upts only**: political party the decision concerns (ÖVP/SPÖ/FPÖ/KPÖ/BZÖ/Team Stronach). |
| `commission` / `senate` / `discrimination_ground` | enum? | `Gbk.Kommission` / `.Senat` / `.Diskriminierungsgrund` | **gbk only**: federal vs general commission; senate I/II/III; ground (Geschlecht, EthnischeZugehoerigkeit, Religion, Weltanschauung, Alter, SexuelleOrientierung, Mehrfachdiskriminierung). |
| `subject_law` | enum? | `Bks.Bereich` | **bks only**: media statute the case concerns (ORF-Gesetz, Privatradiogesetz, …). |
| `changed_since`, `sort_by`, `sort_direction`, `page`, `page_size` | | `ImRisSeit`, `Sortierung.*`, `Seitennummer`, `DokumenteProSeite` | sort_by: `decision_date` (Datum) \| `case_number` (Geschaeftszahl). |

**Output** (per record): `document_number` (e.g. DSBT_20251114_…, JFT_…, JJT_…, UPTS_…), `court` (application), `organ` (Technisch.Organ — issuing body name), `case_numbers` (Geschaeftszahl — normalize to array; upstream is object-or-array), `decision_date`, `decision_type` (Rechtssatz \| Text), `decision_kind` (Entscheidungsart, where present), `summary` (Kurzinformation), `guiding_principle` (Leitsatz — the abstracted rule, chiefly VfGH Rechtssätze), `norms_cited` (array), `keywords` (Schlagworte), `collection_number` (Sammlungsnummer, where present), `ecli` (EuropeanCaseLawIdentifier), `decision_url` (GesamteEntscheidungUrl), `headnotes_url` (RechtssaetzeUrl), `content_urls`, `legal_force_note` (Anfechtung, where present). Enrichment: totals/paging.

**Errors** (typed contract):

| reason | code | when | recovery |
|:---|:---|:---|:---|
| `court_filter_mismatch` | ValidationError | A court-conditional filter was sent with the wrong `court` (or `case_number`/dates/`decision_type` with `normenliste`, which is a norm index, not decisions) — thrown **locally, before any upstream call**; message names the actual offending pair (e.g. "issuing_body applies only to courts dsk/dok/pvak/verg, got 'vfgh'") | "Drop the filter or switch court: issuing_body → dsk/dok/pvak/verg, court_name/legal_area/subject_area → justiz, state → lvwg/uvs, party → upts, commission/senate/discrimination_ground → gbk, subject_law → bks, collection_number → vfgh/vwgh/uvs. Court codes: ris_list_reference topic courts." |
| `invalid_query` | ValidationError | a page past the end and the RIS Client-error passthrough, as legislation; **plus local rejections** — `decision_kind`/`subject_area` checked against the reference tables, and `sort_by` under `normenliste`, each stated over the `court` value and input field the caller sent | "For a page past the end, request a lower page, starting from 1. Otherwise correct the parameter named in the message, or drop it if the court does not support it. Valid court codes, decision types/kinds, and syntax: ris_list_reference (topic: courts, decision_types, decision_kinds, or search_syntax)." |
| `upstream_error` | ServiceUnavailable (retryable) | as legislation | as legislation |

**Zero hits = success + enrichment notice**, composed from the applicable fragments:

| Condition | Notice fragment |
|:---|:---|
| always | "0 decisions in {court}. Other courts are separate calls — repeat per court." |
| `case_number` set | "Geschäftszahl formats differ per court ('Ro 2026/03/0016' = VwGH, 'G 287/2022' = VfGH, '14Os49/26a' = OGH/justiz) — ris_lookup_citation auto-detects the court from the format; examples per court: ris_list_reference topic courts." |
| `norm` set | "norm must match RIS's cited-norm format ('DSG §1', 'DSGVO Art32' style as returned in norms_cited) — run a broader search first and copy the exact string from a result's norms_cited." |
| `decided_from/to` set and range predates the court's coverage window | "{court} coverage starts {year} — earlier decisions are not in RIS. Windows: ris_list_reference topic courts." |
| `court` is a defunct body (uvs/asylgh/ubas/umse/bks + pre-2014 dsk) | "{court} is historical ({window}) — its successor is {successor: lvwg/bvwg/dsk}. Search the successor for current decisions." |

### ris_search_gazette

Date-range/issuer/number browse of the promulgation record at **every level of government** — the monitoring surface `lookup_citation` (point lookup) can't express. One `scope` axis (jurisdiction level), one `series` axis (state law gazettes vs ordinance gazettes), one `state_era` axis (the current authentic state series vs the legacy one).

**Federal era tiers, auto-routed** by date range / number-year — one logical surface over three applications:

| Tier | Application | Coverage | Authentic? | Number param |
|:---|:---|:---|:---|:---|
| Current | BgblAuth | 2004+ | **Yes** (amtssigniert ✓) | `Bgblnummer` ✓ |
| Post-war | BgblPdf | 1945–2003 (Staats- und Bundesgesetzblatt) | No | `Bundesgesetzblatt` (✓ "194/1961" → 1 hit) |
| Imperial/interwar | BgblAlt | 1848–1940 (RGBl, StGBl, BGBl, GBlÖ) | No | `Gesetzblattnummer` + `Jahrgang` (✓ 1900 → 234; spelling combo confirmed at build) |

A number-year, or a `published_from`/`published_to` interval lying inside one tier, routes to that tier and `servedApplication` names it. **One call serves one tier**: an interval overlapping two or three tiers is rejected locally (`cross_tier_range`) with the boundaries to split at, rather than answered from whichever tier the start year names — that silently omitted the rest of the interval (#11). A one-sided bound counts as spanning, since it is open into every tier beyond it. `part: pre_1997` and a year-bearing `number` name the tier outright and are never rejected. The tiers are chronologically disjoint (✓ 2026-07-26: each answers zero for any range outside its window, and returns the same total for a spanning range as for its own segment alone), and **RIS carries no federal gazette for 1941–1944** — BgblAlt ends in 1940 (GBlÖ), BgblPdf resumes in 1945 (StGBl); an interval falling entirely in that break is a legitimate zero-hit answer with a notice, not an error. BgblPdf carries full Html/Pdf renditions ✓; BgblAlt is **metadata-only** — hits carry no content URLs (✓); the scans live at the ÖNB (linked via `AlexUrl` → the `alex_url` output field). Each tier's zero-hit notice names only its own window and its own caveats (#24).

| Param | Type | Maps to | Notes |
|:---|:---|:---|:---|
| `scope` | enum | controller + application | `federal` (default) \| 9 Bundesländer \| `district` (→ Bezirke/Bvb ✓ 2,433) \| `municipal` (→ Gemeinden/GrA ✓ 9,787) |
| `series` | enum? | application | **state scopes only**: `law_gazette` (default → LgblAuth) \| `ordinance_gazette` (→ Vbl ✓ 550 — Verordnungsblätter; currently Tirol only, 2022+). |
| `state_era` | enum? | application | **state scopes only**: `current` (default → LgblAuth) \| `legacy` → the state's earlier non-authentic series: Lgbl (✓ 21,411; no NÖ/Wien flags upstream) or LgblNO for Niederösterreich (✓ 1,939; NÖ's systematic collection, has `FassungVom` + `Gliederungszahl`). Selects a series, never a union — the two cover disjoint eras. Rejected under `series: ordinance_gazette` (Vbl is authentic-only). `servedApplication` names which served. |
| `query` | string? | `Suchworte` | |
| `title` | string? | `Titel` | All gazette applications carry it. |
| `number` | string? | per-tier (federal, above) / `Lgblnummer` (state ✓ handbook) / `Kundmachungsnummer` (Vbl, Bvb, GrA) | "BGBl. II Nr. 171/2026" or "171/2026" (✓ both, BgblAuth). |
| `part` | enum? | `Teil.SucheInTeil1/2/3` (BgblAuth) / `Teil.SucheInAlt/Teil1/2/3` (BgblPdf) | federal only: `part1` (Gesetze) \| `part2` (Verordnungen) \| `part3` (Staatsverträge) \| `pre_1997` (BGBl before the 1997 part split — BgblPdf's `SucheInAlt`). |
| `type` | enum? | `Typ.SucheIn…` | `laws` \| `regulations` \| `announcements` \| `other` (SucheInGesetzen/Verordnungen/Kundmachungen/Sonstiges). Federal + state law gazettes. |
| `published_from` / `published_to` | ISO date? | `KundmachungsdatumVon/Bis` (BgblAuth ✓; dot-form `Kundmachung.Von/Bis` equivalent ✓ 60=60) / `Kundgemacht.Von/Bis` (BgblPdf ✓ 663, BgblAlt ✓ 233) / `Kundmachung.Von/Bis` (LgblAuth ✓ 74, Lgbl) / `Kundmachungsdatum.Von/Bis` (Vbl, Bvb ✓ handbook, GrA) / `Ausgabedatum.Von/Bis` (LgblNO) | |
| `issuer` | string? | `EinbringendeStelle` (BgblAuth) / `Einbringer` (Vbl: Landeshauptmann-frau \| Landesregierung \| Amt der Landesregierung \| Sonstige Landesbehörden) | Ministry/body, e.g. "BMKOES". |
| `district_authority` | string? | `Bezirksverwaltungsbehoerde` | **district only**: e.g. "Bezirkshauptmannschaft Liezen" — full names: ris_list_reference topic district_authorities. |
| `municipality` | string? | `Gemeinde` (+ optional `Bezirk` via `district_authority`… no — GrA uses `Bezirk`; v1 exposes `municipality` only) | **municipal only**: exact municipality name. |
| `sort_by`, `sort_direction` | enum? | `Sortierung.*` | `published` (Kundmachungsdatum) \| `number`. |
| `page`, `page_size` | | | as above |

**Output** (per record): `document_number` (BGBLA_2026_II_171, 1961_194_0, rgb1902_…, LGBLA_SA_…, VBL_TI_…, BVB_ST_…, GEMREA_OB_… ✓ all observed), `gazette_number`, `part` (Teil), `type` (Typ: Gesetz/Verordnung/…), `published` (Ausgabedatum/Kundmachungsdatum), `issuer` (Einbringer/Organ), `district_authority`/`municipality` (where applicable), `title`, `short_title`, `eli`, `binding` (`authentic` for BgblAuth/LgblAuth/Vbl/Bvb/GrA ✓ Authentisch DataType observed on all five \| `historical_record` for BgblPdf/BgblAlt/Lgbl \| `consolidated_informational` for LgblNO — NÖ's systematic collection), `authentic_pdf_url` (the `Authentisch` DataType — amtssigniert .pdfsig ✓), `alex_url` (BgblAlt ÖNB ALEX scan — the metadata-only tier's only document path), `document_url` (RIS web view), `content_urls`. Enrichment: totals/paging + which application served the query.

**Errors** (typed contract):

| reason | code | when | recovery |
|:---|:---|:---|:---|
| `scope_filter_mismatch` | ValidationError | `part` off federal; `series`/`state_era` off state scopes; `district_authority` off district; `municipality` off municipal; `issuer` outside federal/ordinance; `series: ordinance_gazette` + `state_era: legacy` — thrown locally; message names the actual offending pair | "part (I/II/III/pre_1997) applies only to scope: federal; series and state_era only to state scopes; district_authority only to scope: district; municipality only to scope: municipal. state_era: legacy has no ordinance-gazette counterpart. Semantics: ris_list_reference topic gazette_parts or applications." |
| `cross_tier_range` | ValidationError | a federal `published_from`/`published_to` interval overlaps more than one era tier, one-sided bounds included — thrown locally; message names the interval, the tiers it spans, and the boundary dates | "Split the date range at each era boundary — 2004-01-01 (BgblAuth begins) and 1945-01-01 (BgblPdf begins) — and issue one call per tier, then combine the results. Set both published_from and published_to: a one-sided bound spans every tier beyond it. RIS carries no federal gazette for 1941–1944. Tier windows: ris_list_reference topic gazette_parts." |
| `invalid_query` | ValidationError | a page past the end and the RIS Client-error passthrough, as legislation; **plus local rejections** — `sort_by`, `number`, `type`, `part`, `issuer`, or a state absent from the historical Lgbl series, each stated over the `scope`/`series`/`state_era` selection the caller sent, or for a federal era tier over its window and the `number`/`part`/date bound that routed there | "For a page past the end, request a lower page, starting from 1. Otherwise correct the parameter named in the message, or drop it if this gazette does not carry it. Part and type semantics: ris_list_reference topic gazette_parts or law_types." |
| `upstream_error` | ServiceUnavailable (retryable) | as legislation | as legislation |

**Zero hits = success + enrichment notice**, composed from the applicable fragments:

| Condition | Notice fragment |
|:---|:---|
| always | "0 gazette entries matched." |
| `number` set | "Verify part and year — a 'BGBl. II' number returns nothing when filtered to part1. For a single known number, ris_lookup_citation resolves it directly (and routes pre-2004 numbers to the right era tier)." |
| `number` set with `part` also set and they disagree | "number names part {X} but the part filter is {Y} — drop one." (local consistency check; a notice, not an error) |
| `issuer` set | "issuer is a phrase field — try the ministry abbreviation with a trailing * ('BMK*')." |
| federal range served by BgblPdf (1945–2003) | "Range served by BgblPdf 1945–2003 (Staats- und Bundesgesetzblatt), which carries full HTML/PDF renditions. Gazette parts I/II/III exist only from 1997 — for an earlier issue use part: pre_1997 rather than part1/part2/part3." |
| federal range served by BgblAlt (1848–1940) | "Range served by BgblAlt 1848–1940; pre-1848 gazettes are not in RIS. BgblAlt is metadata-only — hits carry no content_urls, and the scans are ÖNB-hosted, linked as alex_url." |
| federal date range touches 1941–1944 | "RIS carries no federal gazette for 1941–1944 — BgblAlt ends in 1940 (GBlÖ) and BgblPdf resumes in 1945 (StGBl)." |
| `scope: district` | "District promulgations cover NÖ (2021+), OÖ/Tirol (2022+), Vorarlberg (2022-07+), Burgenland (2023+), Steiermark (2013+); Salzburg districts publish in the Salzburg LGBl. Windows: ris_list_reference topic applications." |
| `series: ordinance_gazette` | "Verordnungsblätter in RIS currently cover Tirol (2022+) — other states' ordinance gazettes are not yet published here." |

### ris_search_drafts

The federal lawmaking pipeline **before** promulgation: ministerial drafts in public review (Begut ✓ 4,549) and government bills adopted by the council of ministers (RegV ✓ 2,618, 2004+). The monitoring counterpart to `search_gazette` — what *will* become law.

| Param | Type | Maps to | Notes |
|:---|:---|:---|:---|
| `stage` | enum, required | `Applikation` | `review_drafts` (Begut) \| `government_bills` (RegV). One application per call, as everywhere. |
| `query` | string? | `Suchworte` | |
| `title` | string? | `Titel` | |
| `ministry` | string? | `EinbringendeStelle` | Submitting ministry. Accepts the abbreviation ("BMF") — the service expands to RIS's exact-match full string ("BMF (Bundesministerium für Finanzen)"); full table: ris_list_reference topic ministries. |
| `in_review_on` | ISO date? | `InBegutachtungAm` | **review_drafts only**: drafts whose review window covers the date (✓ 13 in review on 2026-07-05). "What is in Begutachtung right now" = today. |
| `decided_from` / `decided_to` | ISO date? | `BeschlussdatumVon/Bis` | **government_bills only**: council-of-ministers adoption date (✓ 48 in 2026). |
| `changed_since` | enum? | `ImRisSeit` | as legislation |
| `sort_by`, `sort_direction` | enum? | `Sortierung.*` | `title` (Kurztitel) \| `ministry` (EinbringendeStelle) \| `date` (EndeBegutachtungsfrist / Beschlussdatum per stage). |
| `page`, `page_size` | | | as above |

**Output** (per record): `document_number` (BEGUT_/REGV_-prefixed GUID ✓), `stage`, `title`, `short_title`, `ministry` (Einbringer/Organ), `review_deadline` (Begutachtungsfrist end, review_drafts), `decided` (Beschlussdatum, government_bills), `content_urls` (Xml/Html/Rtf/Pdf + attachment Gifs ✓ — main document first). Enrichment: totals/paging.

**Errors** (typed contract):

| reason | code | when | recovery |
|:---|:---|:---|:---|
| `stage_filter_mismatch` | ValidationError | `in_review_on` with `government_bills`, or `decided_from/to` with `review_drafts` — thrown locally | "in_review_on applies only to stage: review_drafts; decided_from/to only to stage: government_bills." |
| `invalid_query` | ValidationError | a page past the end and the RIS Client-error passthrough, as legislation; plus a local `ministry` that matched no entry or more than one | "For a page past the end, request a lower page, starting from 1. Otherwise correct the parameter named in the message; the message lists the closest ministry matches when a ministry was passed. Ministry codes: ris_list_reference topic ministries." |
| `upstream_error` | ServiceUnavailable (retryable) | as legislation | as legislation |

**Zero hits:** "0 {stage} matched." + (`ministry` set) "ministry must match a RIS ministry designation — abbreviations are expanded; the historical name at submission time counts ('BMDW', not today's successor). Table: ris_list_reference topic ministries." + (`in_review_on` set) "No drafts in review on {date} matching the filters — drop in_review_on to search all drafts including closed reviews."

### ris_search_announcements

Sectoral official gazettes and executive documents — the Sonstige controller, minus Upts (which is decisions → `search_case_law`). Seven collections behind one `collection` enum, mirroring how `search_case_law` handles 17 courts. Five of the seven are **legally binding authentic publications**.

| `collection` | Application | What it is | Authentic? |
|:---|:---|:---|:---|
| `social_insurance` | Avsv ✓ 4,700 | Amtliche Verlautbarungen der Sozialversicherung (2002+) | **Yes** |
| `veterinary` | Avn ✓ 702 | Amtliche Veterinärnachrichten (2004-09-15+) | **Yes** |
| `court_rules` | KmGer ✓ 53 | Kundmachungen der Gerichte — court rules of procedure & case-allocation plans (Geschäftsordnung/Geschäftsverteilung) | **Yes** |
| `trade_exam_rules` | PruefGewO ✓ 170 | Prüfungsordnungen gemäß Gewerbeordnung (trade exam regulations) | **Yes** |
| `health_structure_plans` | Spg ✓ 75 | Strukturpläne Gesundheit (ÖSG federal, RSG per-state) | **Yes** |
| `ministerial_decrees` | Erlaesse ✓ 1,622 | Erlässe der Bundesministerien — decrees/circulars interpreting law (bind the administration, not citizens) | No |
| `council_minutes` | Mrp ✓ 346 | Ministerratsprotokolle — council-of-ministers session records (2004+) | No |

| Param | Type | Maps to | Valid for |
|:---|:---|:---|:---|
| `query` | string? | `Suchworte` | all |
| `title` | string? | `Titel` | all except `council_minutes` (Mrp has no Titel) |
| `number` | string? | `Avsvnummer` / `Avnnummer` / `Spgnummer` | social_insurance, veterinary, health_structure_plans |
| `published_from/to` | ISO date? | `Kundmachung.Von/Bis` (Avsv, Avn) / `Kundmachungsdatum.Von/Bis` (KmGer, PruefGewO, Spg) / `Sitzungsdatum.Von/Bis` (Mrp) | all except ministerial_decrees (Erlässe date by force, below) |
| `in_force_as_of` | ISO date? | `FassungVom` (`Fassung.FassungVom` where nested) | trade_exam_rules, health_structure_plans, veterinary, court_rules, ministerial_decrees — the consolidated-ish collections |
| `entered_force_from/to` | ISO date? | `VonInkrafttretensdatum`/`BisInkrafttretensdatum` (flat, Erlaesse) | ministerial_decrees |
| `issuer` | string? | `Urheber` (Avsv: ÖGK/SVS/BVAEB/AUVA/PVA/… enum) / `Bundesministerium` (Erlaesse — abbreviation expanded as in drafts) / `Einbringer` (Mrp ministry enum) | social_insurance, ministerial_decrees, council_minutes |
| `norm` | string? | `Norm` | veterinary, ministerial_decrees (✓ Norm=DSG → 10 decrees) — "decrees citing the DSG" |
| `case_number` | string? | `Geschaeftszahl` | veterinary, ministerial_decrees |
| `type` | string? | `Typ` (PruefGewO: Befaehigungs-/Meisterpruefungsordnung; KmGer: Geschaeftsordnung/Geschaeftsverteilung) / `Typ.SucheIn…` (Avn) | trade_exam_rules, court_rules, veterinary |
| `department` | string? | `Abteilung` | ministerial_decrees |
| `plan_type` | enum? | `OsgSuchEinschraenkung.SpgStrukturplanType` / `RsgSuchEinschraenkung.SpgStrukturplanType` | health_structure_plans: `all` (default) \| `expert_opinion` (Gutachten) \| `regulation` (Verordnungen) — the plan kind. Searches the federal ÖSG unless `plan_state` is set |
| `plan_state` | enum? | `RsgSuchEinschraenkung.Land` | health_structure_plans: one of the 9 Bundesländer — setting it switches the search from the federal ÖSG to that state's RSG |
| `session_number` / `legislature` | string? | `Sitzungsnummer` / `Gesetzgebungsperiode` (✓ XXVII → 235) | council_minutes |
| `changed_since`, `sort_by`, `sort_direction`, `page`, `page_size` | | `ImRisSeit`, `Sortierung.*`, paging | all; sort_by: `published` \| `number` where the app has the column |

**Output** (per record): `document_number` (AVSV_2026_0040, AVN_…, KMGER_…, PRUEF_…, SPG_…, ERL_BMJ_…, MRP_20260701_59 ✓ all observed), `collection`, `title`/`summary`, `number`, `published`/`session_date`, `issuer` (Organ/Einbringer), `norms_cited` (where present), `binding` (`authentic` for the five authentic collections ✓ Authentisch DataType observed \| `administrative_directive` for decrees \| `preparatory` for council minutes — per the canonical seven-label list in Design Decisions), `authentic_pdf_url` (where present), `content_urls`. Enrichment: totals/paging.

**Errors:** `collection_filter_mismatch` (ValidationError, local — a param outside its "Valid for" set, message names the pair; recovery routes to this table via ris_list_reference topic collections), `upstream_error` as legislation. `invalid_query` covers a page past the end and the RIS Client-error passthrough as legislation, plus the local rejections — an unknown or ambiguous `issuer`, a `plan_state` outside regional plans, and a `sort_by` value the collection has no column for, the last stated over the `collection` value the caller sent and naming the values it does sort by. Recovery: "For a page past the end, request a lower page, starting from 1. Otherwise correct the parameter named in the message, or drop it if this collection does not carry it. Collections and their issuers: ris_list_reference topic collections or issuing_bodies."

**Zero hits:** "0 documents in {collection}." + (`norm` set) "norm must match RIS's cited-norm format — copy from a result's norms_cited." + (`issuer` set) "issuer must match the RIS designation — abbreviations are expanded for ministries; social-insurance issuers: ris_list_reference topic issuing_bodies." + (`collection: court_rules`) "KmGer currently carries LVwG Tirol and Vorarlberg rules only."

### ris_lookup_citation

Citation-first is how Austrian legal work happens. Parses the citation type and routes to the right application with a deterministic filter — bypassing keyword search. Returns `{ found: false, guidance }` (never a throw) when nothing resolves.

| Route | Trigger pattern | Upstream call |
|:---|:---|:---|
| Norm | section-first "§ 6 DSG", "Art 10 B-VG"; abbreviation-first "DSG §1", "DSGVO Art32" (the `norms_cited` shape ris_search_case_law emits, trailing Abs/Z/lit dropped); bare abbreviation "ABGB" | BrKons: `Titel={abbr}` + `Abschnitt.Von/Bis={n}` + `FassungVom` (today or `in_force_as_of`); `state` hint → LrKons with the Bundesland flag |
| Gazette | "BGBl. I Nr. 165/1999", "BGBl. II Nr. 171/2026", "BGBl. Nr. 194/1961", "RGBl. Nr. 189/1902", "LGBl. Nr. 61/2026" (+ state hint) | year ≥ 2004 → BgblAuth `Bgblnummer=` ✓; 1945–2003 → BgblPdf `Bundesgesetzblatt=` ✓ (1 hit for "194/1961"); 1848–1940 (and RGBl./StGBl./GBlÖ prefixes) → BgblAlt `Gesetzblattnummer=` + `Jahrgang=`; LGBl + `state` hint → LgblAuth `Lgblnummer=` + the Bundesland flag, falling back on zero hits to that state's legacy `Lgbl` series (the e-Recht switch year differs per Bundesland — Kärnten/Steiermark/Tirol 2014, the other four Lgbl states 2015 — and the two series are disjoint at it, so the boundary is probed, not hardcoded; Niederösterreich's LgblNO has no number param and Wien is in neither, so both are named in guidance instead) |
| Case number | "2025-0.934.677" (DSB), "Ro 2026/03/0016" (VwGH), "G 287/2022" (VfGH), "14Os49/26a" (OGH), "W256 …" (BVwG) | Judikatur `Geschaeftszahl=` against the pattern-matched application; `court` hint short-circuits; ambiguous formats probe ≤ 2 candidate applications sequentially |
| Collection number | "VfSlg 19.632/2012", "VwSlg 18.000 A/2010" | Vfgh/Vwgh `Sammlungsnummer=`, court-specific value: Vfgh (and Uvs) store the bare number and match it dotted or undotted, so the cited core is sent as-is; Vwgh stores the full labelled undotted cite (`VwSlg 18000 A/2010`), so the filter is the label + undotted number + a space-anchored trailing wildcard (`VwSlg 18000 A*`, or `VwSlg 18000 *` with no part letter cited — that arm then checks the distinct `Sammlungsnummer` values it matched, since the two Vwgh series reuse numbers) |

**Output:** `found`, `kind` (what it parsed the citation as), `resolution_note` (which application + filter resolved it), and the resolved record in the same normalized shape as the corresponding search tool (single best document; `alternatives_count` when >1 hit, with a pointer to the search tool for the full set).

**Errors** (typed contract): `upstream_error` (ServiceUnavailable, retryable — as legislation) and `upstream_timeout` (Timeout, retryable); the framework classifies a fetch deadline distinctly, and `ctx.fail` resolves the wire code from the declared entry, so the two are separate reasons with divergent recovery. Unparseable/unresolvable input is a `found: false` *result*, not an error — the agent self-corrects better from structured guidance than from a throw (fleet lesson: eur-lex #22).

**`found: false` guidance strings** (per parse outcome — `guidance` is the recovery surface here, so every branch routes to a named tool):

| Outcome | `kind` | guidance |
|:---|:---|:---|
| Citation didn't classify | `unknown` | "Could not classify '{input}'. Expected forms — norm: '§ 6 DSG' / 'Art 10 B-VG'; gazette: 'BGBl. I Nr. 165/1999' (also pre-2004 and RGBl/StGBl forms, and LGBl with a state hint); case number: 'Ro 2026/03/0016'; collection: 'VfSlg 19.632/2012'. Formats: ris_list_reference topic citation_formats. Or set kind explicitly; for keyword search use ris_search_legislation / ris_search_case_law." |
| Norm parsed, no hit | `norm` | "No document for {abbr} {§|Art} {n} in force on {date}. If the provision existed at another time, retry ris_search_legislation with title: '{abbr}', section_from/to: '{n}', section_type: '{Paragraph|Artikel}', include_all_versions: true. If the abbreviation is uncertain, search ris_search_legislation title: '{abbr}*'. State law resolves only with an explicit state hint." |
| Gazette number unreadable | `gazette` | "Could not read a gazette number from '{input}'. A gazette citation needs a number and a year — 'BGBl. I Nr. 165/1999', 'BGBl. Nr. 194/1961', 'RGBl. Nr. 189/1902', or 'LGBl. Nr. 61/2026' with a state hint. Formats: ris_list_reference topic citation_formats. To search without a number, browse with ris_search_gazette published_from/published_to." |
| Gazette, federal BgblAuth/BgblPdf, no hit | `gazette` | "No gazette entry for {number} in {tier}. {Part {I\|II\|III} was applied as a filter — verify it and the year against the cite. \| No part filter was applied, so the number or the year is the mismatch.}{ BgblPdf only: Parts I/II/III exist only from 1997; ris_search_gazette takes part: pre_1997 for an earlier issue.} Browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number." |
| Gazette, federal BgblAlt, no hit | `gazette` | "No gazette entry for {number} in BgblAlt, which covers 1848–1940 and carries no part split — RIS holds no federal gazette for 1941–1944. Verify the number and year against the cite; browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number." |
| Gazette, state, hint supplied, no hit | `gazette` | Branches on that Bundesland's legacy series: **Lgbl** (both searched) — "…in LgblAuth or the legacy Lgbl series — both were searched. The two are chronologically disjoint at that Bundesland's e-Recht switch, so a wrong year misses both. … browse … ris_search_gazette scope: {state}, published_from/published_to, adding state_era: legacy for the pre-switch series."; **LgblNO** (Niederösterreich) — names the systematic collection as keyed by Gliederungszahl, not an LGBl. number, and routes to `ris_search_gazette scope: niederoesterreich, state_era: legacy` by title or date; **none** (Wien) — states Wien is carried in neither legacy series. |
| Gazette, state, hint missing | `gazette` | "Cannot resolve LGBl. Nr. {number} without a state — each of the nine Bundesländer keeps its own Landesgesetzblatt, so nothing was searched. Set state to the issuing Bundesland and retry; codes: ris_list_reference topic states." |
| Case number parsed, no hit | `case_number` | "No decision for '{GZ}' in {applications probed}. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query." |
| Collection number parsed, no hit | `collection_number` | "No decision for {VfSlg/VwSlg} {n} — Sammlungsnummer \"{filter sent}\" matched nothing. {Vwgh: That filter already carries the labelled undotted form VwGH stores, so the number or the part letter (A administrative, F finance) is the mismatch — verify both against the cite. \| Vfgh: That filter is the bare number VfGH stores, matched dotted or undotted, so the number is the mismatch — verify it against the cite.} Keyword fallback: ris_search_case_law court: {vfgh\|vwgh} with query." — it names the filter that was sent and says it is already in the accepted form, so the caller narrows the cite instead of re-sending the same query |
| VwSlg number cited without its part letter, matched >1 decision | `collection_number` | "{VwSlg} {n} names more than one decision — Sammlungsnummer \"{filter sent}\" matched {cites}. VwGH runs two collection series that reuse numbers (A administrative, F finance), so the part letter is what picks one — retry with the full cite. All matches: ris_search_case_law court: vwgh, collection_number \"{filter sent}\"." |

### ris_get_document

Read + export. Two addressing modes:

1. `document_number` + `application` (from any search/lookup result) — server constructs the content URL from the per-application path-segment map (✓ BrKons→`/Dokumente/Bundesnormen/`, LrKons→`/Dokumente/Landesnormen/`, BgblAuth→`/Dokumente/BgblAuth/`, Dsk→`/Dokumente/Dsk/`; remaining segments confirmed at build).
2. `document_url` — any `https://www.ris.bka.gv.at/Dokumente/…` URL passed through from a search result. Validated: host + path-prefix allowlist, nothing else fetched (SSRF guard).

`format`: `markdown` (default — fetch HTML, strip boilerplate CSS/layout, convert) | `html` (raw) | `xml` (RIS Nutzdaten schema) | `urls_only` (no fetch — all format links + authentic PDF).

`sections`: optional array — after an overflow outline, re-call with the section names (copied verbatim) to retrieve just those (see Output).

**Format availability varies by application** (✓ probed 2026-07-05) — the tool degrades explicitly, never silently:

| Application class | Renditions | markdown/html/xml behavior |
|:---|:---|:---|
| BrKons, LrKons, Gr, BgblAuth, BgblPdf, LgblAuth, Lgbl, LgblNO, Vbl, Begut, RegV, Erv, PruefGewO, Avsv, Spg, Avn, Erlaesse, Judikatur | Xml/Html/Rtf(/Pdf/Authentisch) ✓ | full support |
| Bvb, GrA, KmGer | **Authentisch only** ✓ (signed PDF, no text renditions) | text formats return a `format_unavailable` notice + the authentic PDF URL |
| Upts, Mrp | **Pdf only** ✓ | text formats return a `format_unavailable` notice + PDF URLs |
| BgblAlt | **no content URLs** ✓ (metadata-only; scans hosted by the ÖNB) | all formats return the notice + the ÖNB DokumentUrl |

**Output:** `kind` (`full` | `outline`), `text` (unless urls_only/unavailable/outline), `format`, `byte_size`, `content_urls` (always, all DataTypes incl. `Authentisch` when present), `binding_status` (see Design Decisions › *Binding status*): `authentic` \| `consolidated_informational` \| `historical_record` \| `decision` \| `preparatory` \| `administrative_directive` \| `translation`, echoed identifiers. When the markdown text overflows the byte budget the response becomes a `kind: outline` arm instead of truncating — `sections` lists the document's §/Artikel/Anlage units (name + byte size) with `truncated: true`, and an enrichment `notice` names the re-call; a follow-up call passing `sections:[…]` returns just those. Raw html/xml renditions carry no such headings and return in full — never a silent cut.

**Errors** (typed contract):

| reason | code | when | recovery |
|:---|:---|:---|:---|
| `invalid_addressing` | ValidationError | Neither or both addressing modes provided, or `document_number` without `application` — thrown locally | "Provide exactly one addressing mode: document_number plus application (both from one search result), or a document_url from a result's content_urls." |
| `unsupported_url` | ValidationError | `document_url` fails the host + `/Dokumente/` path-prefix allowlist — thrown locally, nothing fetched | "Only ris.bka.gv.at /Dokumente/ URLs are fetchable — pass a URL exactly as returned in content_urls, or switch to document_number + application." |
| `document_not_found` | NotFound | Constructed/passed content URL 404s | "The document_number/application pairing didn't resolve — copy both verbatim from a fresh search result, or resolve the citation with ris_lookup_citation. Document numbers are application-specific." |
| `upstream_error` | ServiceUnavailable (retryable) | Content host unreachable / 5xx | as legislation |

`format_unavailable` is a **notice on a success result** (with the usable URLs), not an error — the agent's next step is fetching the PDF link, not retrying.

**Limitation (upstream):** the REST API has no search-by-document-number parameter, so this tool returns *content*, not fresh metadata — metadata rides the search/lookup step. The description states the call order.

### ris_track_changes

Every document added or changed in an application within a date window — the precise delta feed for mirrors and monitors, and the **only surface that can report deletions**. `changed_since` (ImRisSeit) intervals are coarse and additive-only; this is exact-dated and deletion-aware.

| Param | Type | Maps to | Notes |
|:---|:---|:---|:---|
| `application` | enum, required | `Anwendung` | Any RIS application. **History uses its own names for four** (✓ `Bundesnormen` accepted, `BrKons` rejected): the tool accepts the standard application codes and maps internally — BrKons→`Bundesnormen`, LrKons→`Landesnormen`, Gr→`Gemeinderecht`, GrA→`GemeinderechtAuth`. |
| `changed_from` / `changed_to` | ISO date? | `AenderungenVon` / `AenderungenBis` | ✓ 1,417 BrKons changes in one 2-week window. |
| `include_deleted` | boolean? | `IncludeDeletedDocuments=True` | Include documents removed from RIS. Per-document deletion marking in the response confirmed at build. |
| `page`, `page_size` | | | as above |

**Output** (per record): a compact cross-class record — `document_number`, `title`/`short_title`, `organ` (Technisch.Organ), `binding_status`, `changed` (Allgemein.Geaendert), `published`, `document_url`, `content_urls`/`authentic_pdf_url` — plus `deleted` (+ `deleted_at`) for removed documents. History responses reuse the standard metadata envelope; the tool projects the shared cross-class fields rather than each owning class's full record, keeping the change feed scannable (the per-class detail rides a follow-up `ris_get_document`). Enrichment: totals/paging + the applied window.

**Errors:** `invalid_query` (Client passthrough — e.g. an unknown application name, or a `page` past the last available page; RIS reports both as HTTP 500 carrying its error envelope, which the service translates so the caller sees the rejected input rather than a server fault), `upstream_error` — as legislation. No local conditional params to mismatch.

**Zero hits:** "0 changes in {application} between {from} and {to}. Windows are exact dates — widen the range, or use the search tools' changed_since for coarse recency filtering."

### ris_list_reference

Static, offline (no upstream call), from the handbook/XSD-derived tables in this doc. `topic` enum:

`applications` (all 39 applications by controller and document class, with coverage windows and content-format notes) · `courts` (the 17 case-law codes, English descriptions, active-vs-historical + successor mapping, Geschäftszahl format examples per court) · `states` (9 Bundesländer + enum spellings) · `decision_types` (headnote vs full text) · `decision_kinds` (per-court Entscheidungsart values) · `issuing_bodies` (dsk/dok/pvak/verg bodies + Avsv social-insurance issuers) · `ministries` (EinbringendeStelle/Bundesministerium designations incl. historical, with abbreviations) · `collections` (the 7 announcement collections + their per-collection param matrix) · `stages` (drafts pipeline) · `changed_since_intervals` · `section_types` · `gazette_parts` (BGBl I/II/III semantics + the pre-1997 partless era + era tiers) · `law_types` (BG, V, K, …) · `district_authorities` (the 74 Bezirksverwaltungsbehörden names — live-swept 2026-07-05) · `justiz_subject_areas` (Fachgebiet taxonomy) · `search_syntax` (boolean operators, wildcard rules incl. the ≥2-chars-around-`*` minimum, phrase quoting) · `citation_formats` (the shapes `ris_lookup_citation` parses, with examples)

**Errors:** no typed contract — static and closedWorld; an invalid `topic` fails Zod enum validation before the handler, and baseline codes cover the rest. This tool is the *target* of recovery routing, not a source: most other tools' recovery hints and zero-hit notices end here.

## Domain Mapping

| Noun | Operations | Upstream |
|:-----|:-----------|:---------|
| Consolidated norm (§-level doc) | search (title/fulltext/section/date/force-window), fetch-all-of-law (`law_id`), read, export | `GET /Bundesrecht?Applikation=BrKons`, `GET /Landesrecht?Applikation=LrKons`, content host |
| Municipal norm | search (state/municipality/fulltext/date) | `GET /Gemeinden?Applikation=Gr` |
| English translation | search (fulltext/title) | `GET /Bundesrecht?Applikation=Erv` |
| Law (Rechtsvorschrift) | group key only (`Gesetzesnummer`) — no law-level endpoint; the web view (`GesamteRechtsvorschriftUrl`) is linked | — |
| Gazette issue — federal (3 eras), state (law + ordinance + non-authentic), district, municipal | browse (date/part/type/issuer/authority), point lookup (number), read, export authentic PDF | `GET /Bundesrecht?Applikation=BgblAuth\|BgblPdf\|BgblAlt`, `GET /Landesrecht?Applikation=LgblAuth\|Lgbl\|LgblNO\|Vbl`, `GET /Bezirke?Applikation=Bvb`, `GET /Gemeinden?Applikation=GrA` |
| Decision (Rechtssatz/Text) | search (court/norm/date/fulltext/kind/body), point lookup (Geschäftszahl, Sammlungsnummer), read | `GET /Judikatur?Applikation={court}`, `GET /Sonstige?Applikation=Upts` |
| Review draft / government bill | search (ministry/review-date/decision-date/fulltext), read | `GET /Bundesrecht?Applikation=Begut\|RegV` |
| Sectoral announcement / decree / council minutes | search (collection-specific filters), read, export authentic PDF | `GET /Sonstige?Applikation=Avsv\|Avn\|KmGer\|PruefGewO\|Spg\|Erlaesse\|Mrp` |
| Change set | window query per application, deletions opt-in | `GET /History?Anwendung={app}` |
| Reference codes | list (static) | none |

Nothing upstream is out of scope: v1 reaches all six search controllers (`Bundesrecht`, `Landesrecht`, `Bezirke`, `Gemeinden`, `Judikatur`, `Sonstige`) plus `History` and `Version`.

## Workflow Analysis

`ris_lookup_citation` (1–3 upstream calls):

| # | Call | Purpose | Arm |
|:--|:-----|:--------|:----|
| 1 | Parse citation locally | classify kind, extract abbr/§/number/year/tier | always |
| 2 | Deterministic search on routed application | resolve to document(s) | always |
| 3 | Second-candidate application probe | ambiguous case-number formats only | case_number, ≤ 1 retry |

`ris_get_document` (0–1 upstream calls): construct/validate URL → fetch (skipped for `urls_only` and format-unavailable applications) → convert. No metadata call exists (see Known Limitations).

All other tools: single upstream call. No internal pagination loops exist in v1 — the agent pages explicitly.

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `RisService` | RIS OGD REST v2.6 (`data.bka.gv.at`) + document content host (`www.ris.bka.gv.at`) | all tools except `ris_list_reference` |

One service, two base URLs. Methods: `searchLegislation`, `searchGazette`, `searchCaseLaw`, `searchDrafts`, `searchAnnouncements`, `trackChanges` (thin per-class param builders over one `search(controller, params)` core), `fetchDocumentContent(url)`. Plus the **normalizer** — the heart of the service layer:

- Unwrap `OgdSearchResult.OgdDocumentResults`; coerce `OgdDocumentReference` object-or-array → array (single-hit responses collapse ✓)
- `Hits` `{@pageNumber, @pageSize, #text}` → `{ page, pageSize, total }` numbers
- **Check `OgdSearchResult.Error` on every response before treating it as success** (✓ domain errors arrive in-band on 200; Server errors also carry HTTP 500): `Error.@type = "Client"` → InvalidParams (pass RIS's message through — it enumerates valid elements/values); `"Server"` → ServiceUnavailable
- Per-controller metadata classes: `Data.Metadaten.{Bundesrecht|Landesrecht|Judikatur|Bezirke|Gemeinden|Sonstige}` (✓ all six observed) — one field-map per class
- Coerce object-or-array on `Geschaeftszahl.item`, `Normen.item`, `Indizes.item`, `ContentReference`
- Strip `<br/>`/HTML remnants from Titel/Anmerkung fields; parse `[CELEX-Nr.: …]` → `celex_references`
- Map `ContentUrl[]` `{DataType, Url}` → keyed `{ xml, html, pdf, rtf, authentic }`; absent Dokumentliste (BgblAlt ✓) → empty content_urls, format-unavailable path
- Ministry-abbreviation expansion for exact-match issuer params ("BMF" → "BMF (Bundesministerium für Finanzen)"), from the static ministries table
- History application-name aliasing (BrKons→Bundesnormen, LrKons→Landesnormen, Gr→Gemeinderecht, GrA→GemeinderechtAuth ✓)

Resilience: `withRetry` at `baseDelayMs: 1500` (rate-limited-API calibration) wrapping fetch+parse; `fetchWithTimeout` for HTTP status handling; HTML-error-page detection classified transient, not SerializationError. **Never forward unmapped param names upstream — unknown flat params are silently ignored (✓), so a typo'd passthrough returns wrong results, not an error.** The service builds requests exclusively from the confirmed-spelling table (API Reference below).

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `RIS_API_BASE_URL` | no | Default `https://data.bka.gv.at/ris/api/v2.6` |
| `RIS_CONTENT_BASE_URL` | no | Default `https://www.ris.bka.gv.at` (document content + allowlist host for `document_url`) |
| `RIS_CONTACT` | no | Contact string appended to the User-Agent (RIS netiquette asks integrators to be identifiable; `ris.it@bka.gv.at` is their contact) |

No pagination/pacing knobs in v1 — there are no internal request loops to pace. Reactive backoff via `withRetry` covers upstream throttling.

## Implementation Order

1. Config + server setup (identity: `ris-austria-mcp-server`)
2. `RisService` — request builder (confirmed-spelling table), six-class normalizer, error-envelope handling, ministry expansion, History aliasing; integration-test against live API (cheap, keyless)
3. `ris_list_reference` (static — no service dependency, grounds everything else)
4. `ris_search_legislation` (BrKons/LrKons core, then Gr + Erv routing)
5. `ris_search_case_law` (17 applications, conditional-param guard matrix)
6. `ris_search_gazette` (era-tier routing, then state series/non-authentic, district, municipal)
7. `ris_search_drafts`
8. `ris_search_announcements` (7 collections, per-collection param matrix)
9. `ris_track_changes`
10. `ris_lookup_citation` (composes the search methods; all four routes)
11. `ris_get_document` (content fetch + markdown conversion + binding labels + format-availability matrix; confirm path segments per application)
12. `ris://document/{application}/{documentNumber}` resource (thin over get_document path)
13. Polish: descriptions audit vs this doc, `devcheck`, live field-test each document class

## Design Decisions

- **Full-surface v1 (2026-07-05).** Every OGD application ships in v1 — no deferred tier. Rationale: the architecture (class-split tools, conditional-param guards, one confirmed-spelling table) absorbs new applications as rows, not risk; a complete surface makes coverage questions answerable by `ris_list_reference` instead of "not supported."
- **`in_force_as_of` defaults to today.** Omitting `FassungVom` upstream searches *all historical versions* (✓ 436 vs 77 hits for the same query) — the wrong default for "what does the law say" and a silent-wrongness trap. Historical research is the explicit opt-in (`include_all_versions`, a past date, or a force-window). Output echoes the applied date so the default is never invisible.
- **Five search tools, split by document class — not one, not per-application.** Consolidated law, case law, promulgations, the lawmaking pipeline, and sectoral/executive publications diverge on filter grammar *and* result semantics. Within each class, applications collapse into an enum axis (`scope`+`series`, `court`, `stage`, `collection`) with locally-guarded conditional params — the pattern established by `court`-conditional filters, now applied uniformly. Per-application tools (39) would bloat the surface; one mega-tool would bury the grammars.
- **Gazette is jurisdictional; announcements are sectoral.** Both hold authentic publications, but the gazette tool's axes (era tiers, parts, state series) are jurisdiction-shaped while the Sonstige collections are domain-shaped with per-collection grammars (Urheber enums, Fachplan types, session numbers). Merging them would mix axes in one enum; the split keeps each tool's params coherent. The binding record therefore spans two tools — `binding`/`authentic_pdf_url` output fields are identical across both, and `ris_list_reference` topic `applications` maps the whole authentic set.
- **Federal gazette era tiers are auto-routed, not user-selected.** BgblAuth (2004+), BgblPdf (1945–2003), BgblAlt (1848–1940) are one logical series with era-dependent applications, number params, and part semantics (parts exist only from 1997). The agent thinks "BGBl."; the server routes by the number's year or by the publication-date interval and says which tier served (notice). Getting this mapping right matters: the three tiers differ in bindingness and content availability.
- **A cross-tier federal date range is rejected, not combined** (revised 2026-07-26, #11 — the original text promised the owning tier*s*). Auto-routing covers a range that lies in one tier; a range crossing 2004-01-01 or 1945-01-01 is refused locally with the boundary to split at. Same reasoning as `state_era` below, on the same structure: `servedApplication` is a single application code — the one `ris_get_document` takes alongside `document_number` — with no honest value for a mixed set, and upstream paging is per-application, so a merged page would have to be assembled from per-tier offsets computed from per-tier totals. That needs two sequential upstream rounds (totals, then the containing page), and each `RisService` search carries its own 48 s retry budget, so the pair reaches ~110 s against the MCP SDK's 60 s request deadline; measured per-tier latency is only 0.2–2.5 s, but the deadline sizing is set by the failure path, not the happy one. A combined set would also mix binding labels and mix BgblAlt's metadata-only records with BgblPdf renditions in one `results[]`. Rejecting costs the caller one extra call and returns two correctly paged, correctly attributed result sets.
- **State gazette series is an explicit `state_era` selector, not an additive toggle.** A state's authentic LgblAuth and its legacy series (Lgbl, or Niederösterreich's LgblNO) are separate upstream applications covering disjoint eras — one call serves one. The original boolean promised a union it structurally could not deliver: `servedApplication` is a single required application code (the one `ris_get_document` takes) with no honest value for a mixed set, and upstream paging is per-query, so a union would mean over-fetching both sides and merging client-side. The selector names the series it picks and defaults to `current`, keeping the authentic gazette the default. Prefixed `state_` because `era` is already the federal tier axis above — `current` then means the same thing at both levels; `legacy` names the era rather than the record class, staying honest for NÖ's consolidated LgblNO and the other seven states' historical Lgbl alike. Orthogonal to `series`: `legacy` under `ordinance_gazette` is rejected, since Vbl is authentic-only and has no legacy counterpart to route to.
- **No cross-court fan-out in `search_case_law`.** Upstream takes one Judikatur application per request; merging N applications server-side breaks pagination and hit-count semantics, and multiplies upstream load invisibly. The agent fans out explicitly — one call per court — and the description says so. The same one-application-per-call rule holds for every search tool.
- **Upts is case law, not an announcement.** It lives in the Sonstige controller upstream, but its documents are decisions (GZ, decision date, cited norms) — agents looking for party-transparency rulings will look in the case-law tool. Controller routing is an implementation detail; document class wins.
- **A state gazette citation probes the legacy series; the switch year is never hardcoded.** Each Bundesland moved to the authentic LgblAuth on its own date (Kärnten, Steiermark and Tirol in 2014; Burgenland, Oberösterreich, Salzburg and Vorarlberg in 2015), so a pre-switch `LGBl.` number lives in the non-authentic `Lgbl` series instead. `lookup_citation` queries LgblAuth and falls back to Lgbl on zero hits — the same sequential-probe shape the case-number route already uses for ambiguous Geschäftszahl formats — and reports the served application plus `state_era: legacy` in `resolution_note`. Probing beats a per-state boundary table: the two series are chronologically disjoint at each state's switch, so the first hit is unambiguous, and the table would need re-verifying as RIS backfills. Two states are named in guidance rather than probed — Niederösterreich's LgblNO indexes its systematic collection by Gliederungszahl and carries no number param, and Wien is in neither legacy series.
- **The `Sammlungsnummer` filter is court-specific, not one normalized number.** Vfgh and Uvs store the bare collection number and match it dotted or undotted; Vwgh stores the full labelled undotted cite (`VwSlg 18000 A/2010`), where a bare `18000` and a dotted `VwSlg 18.000 A/2010` both return zero. The Vwgh filter is therefore label + undotted number + a space-anchored trailing wildcard, so a citation missing the year or part letter still resolves. The space is load-bearing: `VwSlg 1800*` matches the whole `VwSlg 1800N` decade, `VwSlg 1800 *` matches the one cite. A cited part letter is kept and wildcarded in place, since the A (administrative) and F (finance) series reuse numbers — and where the citation carried none, the wildcard spans both, so that arm reports the distinct cites it matched rather than resolving to whichever came first. `VwSlg 8000 *` is the case that makes it concrete: `VwSlg 8000 A/1971` and `VwSlg 8000 F/2005` are two unrelated decisions, and a lookup must not pick one of them on the caller's behalf.
- **A citation resolver is a first-class tool.** Austrian legal work is citation-first ("§ 1295 ABGB", a Geschäftszahl, a BGBl number, a VfSlg cite). Deterministic filters (Abschnitt + Titel, per-tier number params, Geschaeftszahl, Sammlungsnummer ✓ exact-resolving where probed) beat keyword search for this. `found: false` result on no-resolve, never a throw (fleet precedent: eur-lex `lookup_celex`, courtlistener/pubmed `lookup_citation`).
- **Binding status is explicit output, everywhere — seven labels.** RIS disclaims warranty on consolidated views; only amtssignierte publications are legally binding. Every document-bearing output carries a binding label: `authentic` (BgblAuth, LgblAuth, Vbl, Bvb, GrA, Avsv, Avn, KmGer, PruefGewO, Spg), `consolidated_informational` (BrKons, LrKons, Gr, LgblNO), `historical_record` (BgblPdf, BgblAlt, Lgbl), `decision` (Judikatur, Upts), `preparatory` (Begut, RegV, Mrp), `administrative_directive` (Erlaesse — binds the administration, not citizens), `translation` (Erv — unofficial). The authentic `.pdfsig` URL is surfaced whenever the `Authentisch` DataType exists (✓). The server never presents non-authentic text as the binding text.
- **English surface, German as domain vocabulary.** Tool/param names are English (`query`, `in_force_as_of`, `court`); the service maps to RIS's German param names internally — including Erv's English upstream names (`SearchTerms`/`Title` ✓) as just another mapping row. German remains only where it *is* the identifier: Austrian legal proper nouns (Bundesgesetzblatt, Geschäftszahl, Rechtssatz — always glossed in descriptions) and returned legal text (data, not interface).
- **Ministry abbreviations are expanded server-side.** RIS issuer params are exact-match against full designations ("BMF (Bundesministerium für Finanzen)") including historical ministry names — hostile to agents. The service accepts the abbreviation, expands from the static table, and `ris_list_reference` topic `ministries` carries the inventory. A failed expansion is a local ValidationError naming near-misses, not a silent zero-hit.
- **Strict param allowlist in the service.** Unknown query params are silently ignored upstream (✓) — the single nastiest API trap here, since a typo returns *plausible but unfiltered* results. Only live-confirmed or handbook/XSD-verified spellings from the API Reference table are ever sent; new filters require a probe first.
- **Sort is exposed minimally.** `sort_by` maps to the per-application Sortierung columns that matter for monitoring (date, number/GZ/section) — not the full upstream column set. Default: upstream default order.
- **No DataCanvas.** Search results are categorical legal metadata for find-then-drill-in workflows, not analytical row sets — fails the shape test regardless of size.
- **No blanket per-call sleep.** RIS's ~1–2s pacing guidance targets bulk/paged retrieval, not interactive lookups. Reactive `withRetry` backoff (1.5s base) fires only when upstream actually signals distress; v1 has no internal loops to pace.
- **No dead ends — every terminal surface routes to a named tool.** Error `recovery` strings, zero-hit enrichment notices, `format_unavailable` notices, and `lookup_citation`'s `found: false` guidance each name the concrete next call (`ris_list_reference` topic X, `ris_lookup_citation`, the specific search tool) — never bare "check your input". The per-tool contract tables carry the verbatim strings; three shared mechanics: (1) RIS Client-error messages pass through verbatim (they enumerate valid values) with recovery routing to `ris_list_reference`; (2) conditional-param misuse (`scope_filter_mismatch`, `court_filter_mismatch`, `stage_filter_mismatch`, `collection_filter_mismatch`, `invalid_addressing`) is caught locally before any upstream call, message naming the actual offending pair; (3) zero hits are success + notice, never an error. Rationale: nine tools over an opaque German-coded corpus is navigable only if every stuck-state says where to go next.
- **Tool prefix `ris_`, name `ris-austria-mcp-server`** (settled in the fleet catalog 2026-07-04): official RIS brand + country disambiguator; clash-free in the fleet.

## Known Limitations

- **No document-by-number search upstream** (no `Dokumentnummer` request param in any XSD; SOAP-only `GetDocNumbers` has no REST equivalent). `get_document` therefore fetches content via constructed/passed-through URLs and cannot return fresh metadata for a bare ID. Metadata comes from search/lookup results.
- **One application per search call** — cross-court/cross-collection coverage is N explicit calls.
- **Coverage windows vary by application:** VfGH 1980+, VwGH 1990+ (older selected), BVwG/LVwG 2014+, Dsk 1990+ (selected), BgblAuth 2004+ (BgblPdf 1945–2003, BgblAlt 1848–1940); Avsv 2002+, Avn 2004-09+, RegV/Mrp 2004+; district promulgations (Bvb) NÖ 2021-09+ / OÖ+Tirol 2022+ / Vorarlberg 2022-07+ / Burgenland 2023+ / Steiermark 2013+ — Salzburg districts publish in the Salzburg LGBl; Verordnungsblätter (Vbl) Tirol only, 2022+ (✓ all 550 docs are Tirol); municipal law (Gr) *selected* norms in Kärnten (all municipalities), NÖ, OÖ, Salzburg, Steiermark, Wien — no Burgenland/Tirol/Vorarlberg; KmGer currently LVwG Tirol + Vorarlberg only (✓ 53). Historical bodies are closed windows with successors: UVS 1991–2013 → LVwG, AsylGH 2008–2013 → BVwG, UBAS 1998–2008 → AsylGH, Umse/Bks end 2013, Datenschutzkommission ≤2013 → Datenschutzbehörde. Justiz is *selected* ordinary-court decisions, not the full record. `list_reference` carries the windows.
- **Content-format availability varies** (✓ probed): Bvb, GrA, KmGer publish the signed PDF only; Upts and Mrp are plain-PDF-only; BgblAlt carries no content URLs at all (metadata + ÖNB-hosted scans). `get_document` returns explicit `format_unavailable` notices with the usable URLs for these — markdown conversion exists only where an Html rendition does.
- **Per-§ document granularity:** one law = many documents sharing a `law_id`. "The whole DSG" is a `law_id`-filtered search (77 docs), not one document; the web `GesamteRechtsvorschriftUrl` is linked for humans. A stitched full-law markdown export is a deliberate non-goal for v1 (77 content fetches).
- **Consolidated text is not legally binding** — inherent to RIS, handled by labeling, not solvable.
- **A decision may appear as multiple documents** (N Rechtssatz docs + 1 Text doc sharing a Geschäftszahl). Results are type-labeled; deduplication is the agent's call.
- **ELI coverage varies** — federal law/gazette hits carry ELI consistently; the LrKons probe returned no ELI at the expected path (✓). Field mapping per application verified at build; `eli` is optional in output schemas.
- **German-language corpus:** legal text returns in German (Austrian law *is* German); `Erv` covers ~138 selected English translations (✓) — absence of a translation is not absence of the law.
- **History change feed:** returns the changed documents' current records (✓ standard envelope); whether deleted documents carry an explicit flag vs. appearing only under `include_deleted` is confirmed at build.

## API Reference (live-confirmed 2026-07-04/05)

Base: `https://data.bka.gv.at/ris/api/v2.6/{controller}` — GET, JSON responses (JSON-serialized XML: `@attr`/`#text` nodes, object-or-array lists). Health: `GET /Version` → `{"OgdSearchResult":{"Version":"2.6"}}` ✓. Content host: `https://www.ris.bka.gv.at/Dokumente/{segment}/{DOKNR}/{DOKNR}.{xml|html|rtf|pdf}` (+ `.pdfsig` as `Authentisch`).

**Controllers → applications** (✓ enumerated via schema-validation errors + Handbook V2.6 Table 1; every application below is in scope):

| Controller | Applications | Shared top-level params |
|:---|:---|:---|
| `Bundesrecht` | BrKons, BgblAuth, BgblPdf (Staats-/BGBl **1945–2003**), BgblAlt (RGBl/StGBl/BGBl **1848–1940**), Begut, RegV, Erv | `Suchworte`, `Titel` (Erv: `SearchTerms`, `Title` ✓) |
| `Landesrecht` | LrKons, LgblAuth, Lgbl (non-authentic; no NÖ/Wien), LgblNO (NÖ systematic), Vbl (Verordnungsblätter) | `Suchworte`, `Titel` |
| `Bezirke` | Bvb (district promulgations ✓ 2,433) | `Suchworte`, `Titel` |
| `Gemeinden` | Gr (municipal norms ✓ 18,250), GrA (authentic municipal promulgations ✓ 9,787) | `Suchworte`, `Titel` |
| `Judikatur` | Vfgh, Vwgh, Normenliste, Justiz, Bvwg, Lvwg, Dsk, Dok, Pvak, Gbk, Uvs, AsylGH, Ubas, Umse, Bks, Verg | `Suchworte`, `Dokumenttyp`, `Geschaeftszahl`, `Norm`, `EntscheidungsdatumVon/Bis` |
| `Sonstige` | PruefGewO, Avsv, Spg, Avn, KmGer, Upts, Mrp, Erlaesse | `Suchworte` (`Titel` except Mrp/Upts) |
| `History` | change-sync per application — `Anwendung` (**own naming**: Bundesnormen/Landesnormen/Gemeinderecht/GemeinderechtAuth for BrKons/LrKons/Gr/GrA ✓), `AenderungenVon/Bis` ✓, `IncludeDeletedDocuments` | — |
| `Version` | version string | health check |

**Param notation (the key discovery):** scalar leaf params are flat query params (`FassungVom=2026-07-04` ✓, `EntscheidendeBehoerde=Datenschutzbehoerde` ✓, `Bundesland=Tirol` ✓ Vbl/Bvb/Gr); children of complex-typed elements use **dot-paths** (`Abschnitt.Von=1&Abschnitt.Bis=1&Abschnitt.Typ=Paragraph` ✓, `Bundesland.SucheInWien=true` ✓ LrKons/Lgbl, `Dokumenttyp.SucheInRechtssaetzen=true` ✓, `Kundmachung.Von=…` ✓, `Kundgemacht.Von=…` ✓). Some date params exist in both spellings (`KundmachungsdatumVon` ≡ `Kundmachung.Von` on BgblAuth ✓ 60=60). **Flat `Bundesland` enum spellings are ASCII (`Kaernten`, `Niederoesterreich`) everywhere EXCEPT Bvb, which requires umlauted values (`Kärnten`) — the wrong variant fails schema validation** (✓ probed both directions 2026-07-05); the `Bundesland.SucheIn<Land>` flag complexes are unaffected. **Unknown names — flat or dotted — are silently ignored, never errors** ✓. Invalid *values* of known enum/element params DO error (schema validation) ✓.

**Paging/envelope params:** `Applikation` (required, selects the application within the controller), `DokumenteProSeite` ∈ {Ten, Twenty, Fifty, OneHundred} (default Twenty ✓), `Seitennummer` (1-based), `ImRisSeit` ∈ {EinerWoche, ZweiWochen, EinemMonat, DreiMonaten, SechsMonaten, EinemJahr} (not on the gazette-law applications — their `Kundmachung.Periode` option is the equivalent).

**Search expression types** (from the OGD handbook + XSDs): `Suchworte` is a FulltextSearchExpression — RIS web grammar (boolean `UND/ODER/NICHT` + English equivalents, parens, quoted phrases; wildcard `*` trailing-only). `Titel`, `Bgblnummer`, `Lgblnummer`, `EinbringendeStelle`, `Kundmachungsorgan(nummer)`, `Gemeinde`, `Avnnummer` are Phrase expressions — `*` allowed leading *or* trailing, **≥2 characters required on each side of `*`** (handbook error example). `Gesetzesnummer`, `Kundmachungsnummer`, `Urheber`, `Bundesministerium`, `Sitzungsnummer`, `Gesetzgebungsperiode`, `Gliederungszahl` are exact-match, no wildcards. `Geschaeftszahl`/`Norm`/`GZ` are fulltext-typed.

**Application-specific request params** (✓ = live-verified 2026-07-04/05; others handbook-verified, spelling confirmed at build):

| Application | Params |
|:---|:---|
| BrKons | `FassungVom` ✓ (omit = all versions ✓), `Fassung.VonInkrafttretensdatum`/`.BisInkrafttretensdatum`/`.VonAusserkrafttretensdatum`/`.BisAusserkrafttretensdatum` (force windows, alternative to FassungVom), `Abschnitt.Von/Bis/Typ` ✓ (Typ ∈ Alle/Artikel/Paragraph/Anlage), `Gesetzesnummer`, `Index`, `Typ`, `Kundmachungsorgan`, `Kundmachungsorgannummer`, `Unterzeichnungsdatum`, `Sortierung.SortDirection/SortedByColumn` (ArtikelParagraphAnlage/Kurzinformation/Inkrafttretensdatum/Ausserkrafttretensdatum) |
| LrKons | `Bundesland.SucheIn{9 Länder}` ✓, `FassungVom`, `Fassung.*` windows, `Abschnitt.*`, `Gesetzesnummer`, `Index`, `Typ`, `Kundmachungsorgan(nummer)`, `Unterzeichnungsdatum` |
| BgblAuth | `Bgblnummer` ✓, `KundmachungsdatumVon/Bis` ✓ (≡ `Kundmachung.Von/Bis` ✓), `Teil.SucheInTeil1/2/3`, `Typ.SucheIn{Gesetzen,Verordnungen,Kundmachungen,Sonstiges}`, `EinbringendeStelle` (ministry enum) |
| BgblPdf | `Bundesgesetzblatt` ✓ ("194/1961" → 1 hit), `Kundgemacht.Von/Bis` ✓ (1975 → 663), `Teil.SucheIn{Alt,Teil1,Teil2,Teil3}` (Alt = pre-1997 partless), `Typ.SucheIn{…}` — Xml/Html/Pdf renditions ✓ |
| BgblAlt | `Jahrgang` ✓ (1900 → 234), `Gesetzblattnummer`, `Stuecknummer`, `Titel`, `Kundgemacht.Von/Bis` ✓ — **no content URLs** ✓ (ÖNB scans) |
| Begut | `InBegutachtungAm` ✓ (→ 13 open reviews), `EinbringendeStelle` (ministry enum), `ImRisSeit`, Sortierung (Kurztitel/EinbringendeStelle/EndeBegutachtungsfrist) |
| RegV | `BeschlussdatumVon/Bis` ✓ (2026 → 48), `EinbringendeStelle`, `ImRisSeit`, Sortierung (Kurztitel/EinbringendeStelle/Beschlussdatum) |
| Erv | **English param names** ✓: `SearchTerms` (→ 109), `Title` (→ 2), `Source`; `ImRisSeit`; no date/section/number params |
| LgblAuth | `Lgblnummer`, `Bundesland.SucheIn{9}`, `Kundmachung.Von/Bis` ✓ (Jun 2026 → 74) or `.Periode`, `Typ.SucheIn{…}` |
| Lgbl | `Lgblnummer`, `Bundesland.SucheIn{7 — no NÖ, no Wien}` ✓ (Salzburg → 1,547), `Kundmachung.Von/Bis`, `Typ.SucheIn{…}` |
| LgblNO | `Gliederungszahl`, `Typ.SucheIn{…}`, `Index` (10-value enum), `FassungVom`, `Ausgabedatum.Von/Bis`, `ImRisSeit` |
| Vbl | `Bundesland` ✓ (flat enum; Tirol → 550 = all) — **non-Tirol values pass schema but throw a server-side error** (`'Kaernten' is not a valid value for RemotionVblBundesland`, ✓ 2026-07-05): guard locally to states with Vbl coverage (currently Tirol) so this never surfaces as a retryable upstream_error; `Einbringer` ∈ {Landeshauptmann/frau, Landesregierung, Amt der Landesregierung, Sonstige Landesbehörden}, `Kundmachungsnummer`, `Kundmachungsdatum.Von/Bis`, `ImRisSeit` |
| Bvb | `Bundesland` ✓ (Steiermark → 182), `Bezirksverwaltungsbehoerde` (~70-value enum), `Kundmachungsnummer`, `Kundmachungsdatum.Von/Bis`, `ImRisSeit` — Authentisch-only renditions ✓ |
| Gr | `Bundesland` ✓ (Wien → 869), `Gemeinde`, `Geschaeftszahl`, `Index` (10-value enum), `FassungVom` ✓ accepted, `ImRisSeit` |
| GrA | `Bundesland`, `Bezirk`, `Gemeinde`, `Gemeindeverband`, `Kundmachungsnummer`, `Kundmachungsdatum.Von/Bis`, `ImRisSeit` — Authentisch-only ✓ |
| Judikatur (all) | `Geschaeftszahl` ✓ (exact GZ → 1 hit), `Norm`, `EntscheidungsdatumVon/Bis`, `Dokumenttyp.SucheInRechtssaetzen` ✓ / `.SucheInEntscheidungstexten` (not Gbk), `Entscheidungsart` (per-court enums), `ImRisSeit` |
| Vfgh / Vwgh | `Entscheidungsart` (Vfgh: Beschluss/Erkenntnis/Vergleich/KeineAngabe; Vwgh: +BeschlussVS/ErkenntnisVS), `Index`, `Sammlungsnummer` |
| Normenliste | `Norm`, `Titel`, `Index`, `Typ`, `Kundmachungsorgan` — **no GZ/date/Dokumenttyp** (norm index, not decisions) |
| Justiz | `Gericht`, `Rechtsgebiet` ∈ {Zivilrecht, Strafrecht}, `Fachgebiet` (39-value taxonomy — unpopulated upstream, 0 hits corpus-wide 2026-07-05), `Rechtssatznummer`, `Entscheidungsart` (4 exact-match string values — also unpopulated, 0 hits), `RechtlicheBeurteilung`, `Spruch`, `Fundstelle` |
| Bvwg / Lvwg / AsylGH / Uvs / Ubas | `Entscheidungsart` (per-court); Lvwg/Uvs: `Bundesland` (single enum); Uvs: `Index`, `Sammlungsnummer`; Ubas: `Verfasser`, `Index`, `Spruch` |
| Umse / Bks | **no `Entscheidungsart` param** (XSD-verified 2026-07-05 — the request schemas carry no such element); Umse: `Kurzbezeichnung`; Bks: `Bereich` (media-statute enum) |
| Dsk | `EntscheidendeBehoerde` ✓ ∈ {Datenschutzkommission, Datenschutzbehoerde} (1864 → 452 ✓), `Entscheidungsart` (Bescheid* taxonomy, 12 values) |
| Dok / Pvak / Verg | `EntscheidendeBehoerde` (per-app body enums); Verg: `Entscheidungsart` ∈ {Bescheid, Beschluss, Empfehlung, Gutachten, Vorabentscheidungsantrag, Vorabentscheidung} |
| PruefGewO | `Typ` ∈ {Befaehigungspruefungsordnung, Meisterpruefungsordnung}, `Kundmachungsdatum.Von/Bis`, `Fassung.FassungVom`/windows |
| Avsv | `Urheber` (insurance-carrier enum), `Avsvnummer`, `Dokumentart`, `Kundmachung.Von/Bis` or `.Periode` |
| Spg | `Spgnummer`, `OsgSuchEinschraenkung.SpgStrukturplanType` / `RsgSuchEinschraenkung.SpgStrukturplanType` ∈ {Alle, Gutachten, Verordnungen}, `RsgSuchEinschraenkung.Land` (9 Länder), `Kundmachungsdatum.Von/Bis`, `Fassung.*` |
| Avn | `Avnnummer`, `Typ.SucheIn{Kundmachungen, VeroeffentlichungenAufGrundVEVO, SonstigeVeroeffentlichungen}`, `Kundmachung.Von/Bis`, `FassungVom`, `Geschaeftszahl`, `Norm` |
| KmGer | `Typ` ∈ {Geschaeftsordnung, Geschaeftsverteilung}, `Gericht` (currently LVwG Tirol/Vorarlberg), `Kundmachungsdatum.Von/Bis`, `Fassung.*` — Authentisch-only ✓ |
| Upts | `GZ`, `Norm`, `Entscheidungsdatum.Von/Bis`, `Partei` ∈ {ÖVP, SPÖ, FPÖ, KPÖ, BZÖ, Team Stronach} — Pdf-only ✓ |
| Mrp | `Einbringer` (ministry enum), `Sitzungsdatum.Von/Bis`, `Sitzungsnummer`, `Gesetzgebungsperiode` ✓ (XXVII → 235) — Pdf-only ✓ (no Titel) |
| Erlaesse | `Bundesministerium` (historical-inclusive enum), `Abteilung`, `Fundstelle`, `Geschaeftszahl`, `Norm` ✓ (DSG → 10), `VonInkrafttretensdatum`/`BisInkrafttretensdatum`, `FassungVom` |
| History | `Anwendung` ✓ (own names for the four konsolidiert/municipal apps ✓ — `BrKons` rejected with "Application BrKons not found"), `AenderungenVon/Bis` ✓ (2-week BrKons window → 1,417), `IncludeDeletedDocuments` |

**Response envelope:** success → `OgdSearchResult.OgdDocumentResults` with `Hits {@pageNumber, @pageSize, #text}` ✓ and `OgdDocumentReference` (object when 1 hit, array when >1 ✓). Each hit: `Data.Metadaten.Technisch {ID, Applikation, Organ, Einbringer?}`, `Data.Metadaten.Allgemein {Veroeffentlicht, Geaendert, DokumentUrl}`, `Data.Metadaten.{Bundesrecht|Landesrecht|Judikatur|Bezirke|Gemeinden|Sonstige}` ✓ (per-controller class fields incl. Eli / EuropeanCaseLawIdentifier), `Data.Dokumentliste.ContentReference{,[]}` with `ContentType` ∈ {MainDocument, Attachment, Material, Statement, Letter, EmbeddedAttachment, BaseDocument} and `Urls.ContentUrl[] {DataType, Url}`, DataType ∈ {Xml, Html, Pdf, Rtf, Authentisch, Gif, Jpg, Tiff, Png, Odt, Docx, Unknown} ✓ (Authentisch = amtssigniert `.pdfsig`). Dokumentliste may be absent entirely (BgblAlt ✓).

**Errors arrive in-band** ✓: `OgdSearchResult.Error {@type: "Client"|"Server", Applikation, Message}` — Client messages are schema-validation errors that enumerate valid elements/values (useful passthrough) and ride HTTP 200 ✓; Server errors additionally carry HTTP 500 (handbook). **A not-found document/GZ is NOT an error** — status ok, `Hits = 0` ✓.

**Netiquette** (RIS OGD guidance): descriptive User-Agent + contact; pace paged/bulk retrieval ~1–2 s (interactive lookups exempt); notify `ris.it@bka.gv.at` before mass downloads; prefer off-hours for bulk. Hosted posture: search-read-export traffic is well within guidance; no full-corpus crawls through the tool surface.

**Licensing:** RIS OGD data CC BY 4.0 (attribution required — server description credits RIS/BKA); underlying legal texts are copyright-free official works (UrhG §7). Only amtssignierte publications are legally binding.
