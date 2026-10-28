---
name: ris-austria-guide
description: Austrian legal research with the ris_* tools — from a citation to the legally binding gazette text, from a statute section to court headnotes and full decisions, a law's version history over a date window, and a government bill to its explanatory notes and enacted gazette. Use when working with Austrian statutes, BGBl./LGBl. citations, Geschäftszahlen, RIS-Justiz RS numbers, or Austrian ECLIs.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

RIS holds Austrian law only, in German, with no API key: consolidated federal, state, and municipal law, the federal and state gazettes, court and tribunal decisions, the federal lawmaking pipeline, and sectoral announcements. EU acts are not consolidated here. `ris_lookup_citation` answers a DSGVO or Charter cite with `found: false` and a EUR-Lex link, but the Austrian decisions that apply those acts are here, reached through the case-law `norm` filter.

Three record classes answer different questions, so pick the one that fits before you search:

| You need | Read | Binding? |
|:--|:--|:--|
| What the law says on a date | consolidated law (`BrKons` federal, `LrKons` state) | No, informational |
| The text as promulgated, to quote or cite | the gazette entry (`BgblAuth` 2004+, `LgblAuth`) | Yes, `authentic` with a signed PDF |
| How courts read a provision | case law: Rechtssatz headnotes and decision texts | Decisions |

A federal gazette entry from before 2004 (`BgblPdf`) is `historical_record`. RIS has no signed PDF for it, so cite its gazette number.

## Identifiers

| Identifier | Looks like | Comes from | Use it with |
|:--|:--|:--|:--|
| `law_id` (Gesetzesnummer) | `10001597` (DSG) | any consolidated-law record | `ris_search_legislation` `law_id`, for every section or every version of one law |
| `promulgation` on a consolidated record | `BGBl. I Nr. 165/1999 zuletzt geändert durch BGBl. I Nr. 51/2012` | the same record | each cite inside it goes to `ris_lookup_citation`: the original act, then the act that produced this version |
| Geschäftszahl | `1Ob78/26s`, `Ro 2026/03/0016` | `case_numbers` on case-law records | `ris_search_case_law` `case_number` (same court), or `ris_lookup_citation` |
| RIS-Justiz RS number | `RS0022961` | OGH headnote citations in decisions and commentary | see the Gates section: `ris_lookup_citation` does not parse it |
| Rechtssatz ECLI | `ECLI:AT:OGH0002:1959:RS0022961` | `ecli` on a Justiz Rechtssatz | `ris_lookup_citation` resolves it |
| Gazette `document_url` / `eli` | `https://…/eli/bgbl/I/2012/51/20120605` | gazette records | a web view for people. `ris_get_document` rejects it as `unsupported_url`, so read the entry with its `document_number` + `servedApplication`, or open `authentic_pdf_url` |

## Gates

- **Write `norm` filters with the abbreviation first and no space before the number.** Use `DSGVO Art6` or `ABGB §1295`. The citation form `Art. 6 DSGVO` matches nothing. One string works across courts even where a court stores something longer: VwGH files `32016R0679 DSGVO Art6`, and `DSGVO Art6` returns the same set. An article- or section-level filter also matches its sub-provisions (`Abs1 litf`) and the OGH index suffixes (`ABGB §1295 IIc`), so start at § / Art level and narrow from the results.
- **Pass `state` for state law.** Without it, `ris_lookup_citation` searches federal law only: `§ 1 TROG 2022` misses, and the same cite with `state: tirol` resolves to `LrKons`. On `ris_search_legislation`, set the Bundesland as `scope`.
- **Quote binding text from the gazette, not from consolidated law.** Consolidated documents come back `consolidated_informational`. Before you call a wording "the law", follow the version's `promulgation` to the amending act (workflow 1).
- **Skip versions that never took effect.** If a version's `in_force_until` is earlier than its `in_force_from`, a later amendment replaced it before it entered force. Example: the DSG rows from BGBl. I Nr. 120/2017, dated 2018-05-25 → 2018-05-24, were superseded by BGBl. I Nr. 24/2018.
- **RIS's change date is not a legal amendment.** `ris_track_changes` lists every record RIS re-touched. One or two days in `BrKons` can return over a hundred rows, mostly versions of laws that left force years ago. For "what changed in the law", use the `entered_force_from/to` window on `ris_search_legislation`. Use the change feed for mirrors and sync.
- **On a Rechtssatz, `decision_date` is the date of the newest decision linked to it,** not the date the rule was first stated. `case_numbers[0]` and the date inside `document_number` (`JJR_19590311_…`) give the origin.
- **Resolve an RS number by full text.** `ris_lookup_citation` cannot classify `RS0022961`. `ris_search_case_law` with `court: justiz` and `query: "RS0022961"` returns that Rechtssatz plus the decision texts that cite it. If you know the year the rule was first stated, the Rechtssatz ECLI resolves through `ris_lookup_citation`.

## Workflows

### 1. Citation → current text → binding text

1. `ris_lookup_citation` on the cite, adding `state` for state law. The record carries `law_id` and `promulgation`.
2. `ris_get_document` returns the current consolidated text.
3. Take the last gazette cite in `promulgation` (after "zuletzt geändert durch") and pass it to `ris_lookup_citation`. A 2004+ federal act comes back `authentic` with `authentic_pdf_url`, and `ris_get_document` on its `document_number` + `BgblAuth` returns its text as `authentic`. The amending act may be an omnibus law: BGBl. I Nr. 51/2012 amends many laws, so find the article that touches yours.

### 2. Statute section → headnotes → decisions

1. Cover each relevant court in turn, one call per court. Data-protection questions run through `dsk`, `bvwg`, `vwgh`, and `vfgh`. For OGH civil and criminal law, use `justiz` with `court_name: OGH`.
2. Filter `norm` as described under Gates, with `decision_type: headnote` when you want the abstracted rules first.
3. A Rechtssatz's `case_numbers` list every decision it covers. Pass one as `case_number` with `decision_type: full_text` to get that decision's text (one `Text` hit).

### 3. What changed in a law over a window

1. Get `law_id` from any record of the law.
2. `ris_search_legislation` with `law_id` and `entered_force_from/to` returns one row per section version that entered force in the window (dozens of rows for the DSG in 2018). Page through the results. A force window cannot be combined with `include_all_versions`. Drop the rows that never took effect (see Gates).
3. Each row's `promulgation` names the act that produced that version. Look up that act for its binding text and its title.
4. For the full history of one section, use `law_id` with `section_from`/`section_to` and `include_all_versions: true`. Every version comes back with its in-force window.

### 4. Government bill → explanatory notes → enacted gazette

1. `ris_search_drafts` with `stage: government_bills`, or `review_drafts` with `in_review_on` for drafts still under consultation.
2. Read the Erläuterungen through its `materials[].url` (the server instructions cover this). The *Allgemeiner Teil* gives the purpose and the constitutional basis. The *Besonderer Teil* explains each amendment item (`Zu Z 1 …`). `Textgegenüberstellung` is the old/new redline.
3. To find the enacted version, call `ris_search_gazette` with `title` set to the name of the law being amended and `published_from` set to the bill's `decided` date. The bill amending the Bildungsinvestitionsgesetz (adopted 2025-12-10) came back as BGBl. I Nr. 3/2026, `authentic`. An amending act gets no consolidated entry of its own. Its changes appear in the amended law's consolidated versions.
