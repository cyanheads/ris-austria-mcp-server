# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-07-26

ris_lookup_citation rejects impossible calendar dates and the normenliste court hint as input errors instead of reporting them as citation misses, Artikel miss guidance now carries section_type into the retry recipe, and the vwgh/justiz Geschäftszahl reference examples are replaced with citations that resolve.

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-07-26

ris_search_case_law surfaces normenliste law identity plus cross-court indexes/state/note, ris_search_legislation surfaces English-translation provenance, and the search retry budget no longer exceeds the client's request deadline on a slow upstream.

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-07-26

ris_get_document: malformed document_url escapes, duplicated screen-reader citations, and unmatched section selectors now surface their real outcome instead of falling back silently.

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-07-26

Schema-valid rejections, generic upstream 5xx, and slow content renders now carry the declared error contract instead of a bare undocumented code.

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-07-16 · ⚠️ Breaking

ris_search_gazette's include_non_authentic boolean is removed and replaced by an explicit state_era: 'current' | 'legacy' selector; un-migrated callers silently get authentic results instead of an error.

## [0.1.7](changelog/0.1.x/0.1.7.md) — 2026-07-15

RIS's HTTP 500 for a rejected input parameter (e.g. an out-of-range page) now surfaces as a typed client error with RIS's own message instead of an opaque InternalError, fixed once for all six search-shaped tools; plus tool-description and error-contract-prose corrections.

## [0.1.6](changelog/0.1.x/0.1.6.md) — 2026-07-09

A public hosted instance is now available at https://ris-austria.caseyjhand.com/mcp, reachable over Streamable HTTP with no install. Advertised via the server.json remotes array and documented in the README.

## [0.1.5](changelog/0.1.x/0.1.5.md) — 2026-07-09

First public release — published to npm, the MCP Registry, and GHCR. README adds install badges (Claude Desktop, Cursor, VS Code), npm and Docker header badges, and an npm-first Getting started section.

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-07-09

ris_get_document's document_url mode now rejects content-attachment / non-rendition URLs (Materialien_…, Anlagen_…, or a file whose stem doesn't match the document number) with an unsupported_url error instead of silently fetching the main document.

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-07-09

ris_lookup_citation now parses abbreviation-first norm citations (e.g. DSG §1, DSGVO Art32), including trailing sub-provisions and multi-token abbreviations, so ris_search_case_law's norms_cited output round-trips into citation lookup.

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-07-09

ris_get_document returns a retrievable §/Artikel/Anlage section outline for oversized documents instead of truncating, with a sections re-call for selective retrieval; the ris://document/... resource degrades the same way.

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-07-09

Content-parity fixes for ris_track_changes and ris_search_case_law; mcp-ts-core ^0.10.14; Bun supply-chain install guard (minimumReleaseAge + Socket scanner).

## [0.1.0](changelog/0.1.x/0.1.0.md) — 2026-07-05

Initial release — a keyless MCP server over Austria's RIS OGD REST API v2.6: 9 tools + 1 resource spanning all 39 RIS applications, with binding-status labeling, era-tier gazette routing, and a deterministic citation resolver.
