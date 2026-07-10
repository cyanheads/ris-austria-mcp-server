# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-07-09

ris_lookup_citation now parses abbreviation-first norm citations (e.g. DSG §1, DSGVO Art32), including trailing sub-provisions and multi-token abbreviations, so ris_search_case_law's norms_cited output round-trips into citation lookup.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-07-09

ris_get_document returns a retrievable §/Artikel/Anlage section outline for oversized documents instead of truncating, with a sections re-call for selective retrieval; the ris://document/... resource degrades the same way.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-07-09

Content-parity fixes for ris_track_changes and ris_search_case_law; mcp-ts-core ^0.10.14; Bun supply-chain install guard (minimumReleaseAge + Socket scanner).

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-07-05

Initial release — a keyless MCP server over Austria's RIS OGD REST API v2.6: 9 tools + 1 resource spanning all 39 RIS applications, with binding-status labeling, era-tier gazette routing, and a deterministic citation resolver.
