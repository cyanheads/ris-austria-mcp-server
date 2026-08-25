/**
 * @fileoverview ris_lookup_citation — the deterministic citation resolver. Parses one
 * Austrian legal citation, classifies it into one of four routes (norm, gazette, case
 * number, collection number), and routes it to the owning search application with a
 * deterministic filter, returning the single best-matching document.
 *
 * The core contract: unparseable OR unresolvable input is a `{ found: false, kind, guidance }`
 * RESULT, never a throw — the agent self-corrects from structured guidance better than from
 * an exception (fleet precedent: eur-lex lookup_celex, pubmed/courtlistener lookup_citation).
 * The only thrown errors are `upstream_error` (a routed search failed upstream) and
 * `upstream_timeout` (it did not answer within the deadline). A service `ValidationError`
 * during a routed lookup is a failed deterministic filter = no resolution = `found: false`,
 * not an error.
 *
 * The resolved record is produced by the corresponding search tool's own record mapper, so an
 * agent chaining a resolved citation sees exactly the shape that tool returns.
 * @module mcp-server/tools/definitions/ris-lookup-citation
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';

import { RIS_COURTS, RIS_STATES } from '@/services/ris/reference/index.js';
import type {
  GazetteApplication,
  GazetteSearchParams,
  LegislationApplication,
  LegislationSearchParams,
  RisCourtCode,
  RisStateCode,
} from '@/services/ris/request-builder.js';
import { getRisService } from '@/services/ris/ris-service.js';
import type { RisHit, RisSearchResult } from '@/services/ris/types.js';

import { isoDateString } from './_shared.js';
import { toRecord as toCaseLawRecord } from './ris-search-case-law.tool.js';
import { toRecord as toGazetteRecord } from './ris-search-gazette.tool.js';
import { toRecord as toLegislationRecord } from './ris-search-legislation.tool.js';

/**
 * Courts a Geschäftszahl can be looked up in. `normenliste` indexes norms rather than
 * decisions, so the request builder rejects a case-number filter there — and that local
 * rejection is one `runSearch` maps to a not-resolved `null`, which would report an
 * impossible court hint as a citation miss. Rejecting it at the input schema instead keeps
 * `found: false` meaning only "valid citation, no document".
 */
const CASE_NUMBER_COURT_CODES = RIS_COURTS.filter((c) => c.code !== 'normenliste').map(
  (c) => c.code,
) as [RisCourtCode, ...RisCourtCode[]];
const STATE_CODES = RIS_STATES.map((s) => s.code) as [RisStateCode, ...RisStateCode[]];
const COURT_APPLICATION = new Map<string, string>(RIS_COURTS.map((c) => [c.code, c.application]));

/** Resolve a court code to its RIS `Applikation` value (falls back to the code). */
function courtApplication(code: RisCourtCode): string {
  return COURT_APPLICATION.get(code) ?? code;
}

/* ------------------------------------------------------------------------------------ */
/* Citation parsing (deterministic, offline)                                             */
/* ------------------------------------------------------------------------------------ */

/** A citation classified into one of the four resolvable routes. */
type CitationKind = 'case_number' | 'collection_number' | 'gazette' | 'norm';

/** Gazette prefixes that signal a promulgation citation (federal, imperial, or state). */
const GAZETTE_PREFIX = /\b(?:BGBl|RGBl|StGBl|LGBl)\b|GBl[ÖO]/i;
/** An explicit norm citation — a section sign, or an Artikel keyword followed by a number. */
const NORM_EXPLICIT = /§|\bart(?:ikel)?\.?\s*\d/i;
/** A bare law abbreviation (whole-law reference) — letters/hyphens, an optional trailing year. */
const BARE_ABBREVIATION = /^[A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß.]*(?:[-\s][A-Za-zÄÖÜäöüß0-9]+)*$/;

/** Parsed norm citation. */
interface NormParse {
  readonly abbreviation: string;
  readonly section?: string;
  readonly sectionType?: 'Artikel' | 'Paragraph';
}

/** The marker RIS cites a section with — "Art" for an Artikel, "§" otherwise. */
function sectionMarker(sectionType: NormParse['sectionType']): string {
  return sectionType === 'Artikel' ? 'Art' : '§';
}

/**
 * Parse a norm citation into an abbreviation and optional §/Artikel number. Handles both
 * orders: section-first ("§ 6 DSG", "Art 10 B-VG") and abbreviation-first ("DSG §1",
 * "DSGVO Art32", "DSG §22 Abs1") — the latter is the shape ris_search_case_law emits in its
 * `norms_cited` output, so a cited norm round-trips straight back into this lookup. Sub-provision
 * refs (Abs / Z / lit / Satz) are dropped either way — RIS filters on the §/Artikel number only,
 * and the document carries every Absatz.
 */
function parseNorm(input: string): NormParse | null {
  const s = input.trim();
  const stripSubRefs = (rest: string): string =>
    rest.replace(/^(?:Abs\.?\s*\d+\w?\s+|Z\s*\d+\s+|lit\.?\s*\w+\s+|Satz\s*\d+\s+)+/i, '').trim();

  /*
   * Abbreviation-first shape — the abbreviation precedes the §/Artikel marker ("DSG §1",
   * "DSGVO Art32"), optionally with a trailing sub-provision that is discarded ("DSG §22 Abs1",
   * "DSGVO Art6 Abs1 litc", "DSGVO Art4 Z2"). Anchored on the marker, not on whitespace, so a
   * multi-token abbreviation stays whole ("B-VG", "TKG 2021"); the leading letter (and, for the
   * §-branch, the §-free abbreviation body) keeps a section-first string out of this branch.
   * These run BEFORE the section-first branches — whose un-anchored regexes would otherwise read
   * "§22 Abs1" as "§ <section> <abbreviation>" and mis-parse the abbreviation to "Abs1" — and
   * BEFORE the BARE_ABBREVIATION fallback, which would otherwise swallow "DSGVO Art32" as a
   * literal abbreviation and resolve nothing.
   */
  const abbrevParagraph = /^([A-Za-zÄÖÜäöüß][^§]*?)\s+§+\s*(\d+\s?[a-zA-Z]?)(?:\s+\S.*)?$/.exec(s);
  if (abbrevParagraph) {
    const [, abbreviation, section] = abbrevParagraph;
    if (abbreviation !== undefined && section !== undefined) {
      return {
        abbreviation: abbreviation.trim(),
        section: section.replace(/\s+/g, ''),
        sectionType: 'Paragraph',
      };
    }
  }
  const abbrevArtikel =
    /^([A-Za-zÄÖÜäöüß].*?)\s+art(?:ikel)?\.?\s*(\d+\s?[a-zA-Z]?)(?:\s+\S.*)?$/i.exec(s);
  if (abbrevArtikel) {
    const [, abbreviation, section] = abbrevArtikel;
    if (abbreviation !== undefined && section !== undefined) {
      return {
        abbreviation: abbreviation.trim(),
        section: section.replace(/\s+/g, ''),
        sectionType: 'Artikel',
      };
    }
  }

  const paragraph = /§+\s*(\d+\s?[a-zA-Z]?)\s+(\S.*)$/.exec(s);
  if (paragraph) {
    const [, section, rest] = paragraph;
    if (section !== undefined && rest !== undefined) {
      return {
        abbreviation: stripSubRefs(rest),
        section: section.replace(/\s+/g, ''),
        sectionType: 'Paragraph',
      };
    }
  }
  const artikel = /\bart(?:ikel)?\.?\s*(\d+\s?[a-zA-Z]?)\s+(\S.*)$/i.exec(s);
  if (artikel) {
    const [, section, rest] = artikel;
    if (section !== undefined && rest !== undefined) {
      return {
        abbreviation: stripSubRefs(rest),
        section: section.replace(/\s+/g, ''),
        sectionType: 'Artikel',
      };
    }
  }
  if (BARE_ABBREVIATION.test(s) && !s.includes('/')) return { abbreviation: s };
  return null;
}

/** Parsed collection-number citation (VfSlg / VwSlg). */
interface CollectionParse {
  readonly court: Extract<RisCourtCode, 'vfgh' | 'vwgh'>;
  /** The `Sammlungsnummer` value sent upstream — court-specific, see `parseCollection`. */
  readonly filter: string;
  readonly label: 'VfSlg' | 'VwSlg';
  /** The number as cited, thousands dot preserved — display only, never the filter. */
  readonly number: string;
  /**
   * Part letter as cited, uppercased (VwSlg only). Absent when the citation carried none,
   * which is what leaves the filter's wildcard spanning both VwGH series.
   */
  readonly partLetter?: string;
}

/**
 * Parse a VfSlg/VwSlg collection citation into the number as cited and the `Sammlungsnummer`
 * value that court actually matches. The two courts store the field differently: VfGH (and
 * UVS) hold the bare number and match it dotted or undotted, while VwGH holds the full
 * labelled undotted cite — `VwSlg 18000 A/2010` — where a bare `18000` and a dotted
 * `VwSlg 18.000 A/2010` both match nothing.
 *
 * The VwGH filter is therefore the label plus the undotted number, closed with a
 * space-anchored trailing wildcard so a citation carrying neither the year nor the part
 * letter still resolves. The space is what bounds it: `VwSlg 1800*` bleeds into the whole
 * `VwSlg 1800N …` decade (52 hits), `VwSlg 1800 *` matches the one cite. A cited part letter
 * is kept and wildcarded in place, since the A (administrative) and F (finance) series reuse
 * numbers — `VwSlg 8000 *` spans both, `VwSlg 8000 A*` picks one. A citation that cited no
 * part letter therefore carries `partLetter: undefined`, and the route checks what its
 * wildcard actually matched before calling the citation resolved.
 */
function parseCollection(input: string): CollectionParse | null {
  const m = /^\s*(vf|vw)slg\b\s*(.*)$/i.exec(input);
  if (!m) return null;
  const [, prefix, rest] = m;
  if (prefix === undefined || rest === undefined) return null;
  const numMatch = /(\d[\d.]*\d|\d)\s*([A-Za-z])?/.exec(rest);
  const number = numMatch?.[1];
  if (number === undefined) return null;
  if (prefix.toLowerCase() === 'vf') {
    return { court: 'vfgh', filter: number, label: 'VfSlg', number };
  }
  const partLetter = numMatch?.[2]?.toUpperCase();
  const undotted = number.replace(/\./g, '');
  return {
    court: 'vwgh',
    filter: `VwSlg ${undotted} ${partLetter ?? ''}*`,
    label: 'VwSlg',
    number,
    ...(partLetter !== undefined && { partLetter }),
  };
}

/** Parsed gazette citation, already routed to its era tier / state application. */
interface GazetteParse {
  readonly application: GazetteApplication;
  /**
   * The Bundesland's pre-e-Recht series, when it has one. Set only on a state route that got
   * its state hint. `Lgbl` is probed after a zero-hit LgblAuth resolution; `LgblNO` is named
   * in guidance instead, since it carries no number param.
   */
  readonly legacyApplication?: Extract<GazetteApplication, 'Lgbl' | 'LgblNO'>;
  /** True when a state gazette (LGBl.) was given without the state hint needed to resolve it. */
  readonly needsState: boolean;
  readonly number: string;
  readonly part?: 'part1' | 'part2' | 'part3';
}

/** Bundesländer RIS carries in the historical non-authentic Lgbl gazette. */
const LGBL_STATES = new Set<RisStateCode>(
  RIS_STATES.filter((state) => state.inLgbl).map((state) => state.code),
);

/**
 * The Bundesland's pre-e-Recht gazette series, or `undefined` when it has none. Each state
 * switched to the authentic LgblAuth on its own date — Kärnten, Steiermark and Tirol in 2014,
 * the other four Lgbl states in 2015 — and the two series are chronologically disjoint at that
 * boundary, so the switch is probed rather than hardcoded per state. Only `Lgbl` is probeable
 * by number: Niederösterreich's LgblNO indexes its systematic collection by Gliederungszahl
 * and has no `Lgblnummer` (upstream ignores one silently; the request builder rejects it
 * locally), and Wien is carried in neither legacy series.
 */
function legacyStateSeries(state: RisStateCode): GazetteParse['legacyApplication'] {
  if (state === 'niederoesterreich') return 'LgblNO';
  return LGBL_STATES.has(state) ? 'Lgbl' : undefined;
}

/**
 * Parse a gazette citation and route it to the owning application: federal BGBl. by year
 * (BgblAuth 2004+, BgblPdf 1945–2003, BgblAlt before 1945), imperial RGBl./StGBl./GBlÖ to
 * BgblAlt, and LGBl. to the state Landesgesetzblatt (LgblAuth) when a state hint is present —
 * carrying that state's legacy series alongside, since a pre-switch citation lives there.
 */
function parseGazette(input: string, stateHint: RisStateCode | undefined): GazetteParse | null {
  const s = input.trim();
  const isState = /\bLGBl\b/i.test(s);
  const isImperial = /\bRGBl\b|\bStGBl\b/i.test(s) || /GBl[ÖO]/i.test(s);
  const isFederal = /\bBGBl\b/i.test(s);
  if (!isState && !isImperial && !isFederal) return null;

  const numYear = /(\d+)\s*\/\s*(\d{4})/.exec(s);
  if (!numYear) return null;
  const [, numberPart, yearPart] = numYear;
  if (numberPart === undefined || yearPart === undefined) return null;
  const number = `${numberPart}/${yearPart}`;
  const year = Number.parseInt(yearPart, 10);

  let part: GazetteParse['part'];
  const partMatch = /\bBGBl\.?\s*(I{1,3})\b/i.exec(s);
  if (partMatch?.[1] !== undefined) {
    const romanLength = partMatch[1].length;
    part = romanLength === 1 ? 'part1' : romanLength === 2 ? 'part2' : 'part3';
  }

  if (isState) {
    const legacy = stateHint === undefined ? undefined : legacyStateSeries(stateHint);
    return {
      application: 'LgblAuth',
      needsState: stateHint === undefined,
      number,
      ...(legacy !== undefined && { legacyApplication: legacy }),
    };
  }
  if (isImperial) {
    return { application: 'BgblAlt', needsState: false, number };
  }
  const application: GazetteApplication =
    year >= 2004 ? 'BgblAuth' : year >= 1945 ? 'BgblPdf' : 'BgblAlt';
  // Parts exist only from 1997 and never on the metadata-only imperial tier.
  return {
    application,
    needsState: false,
    number,
    ...(part !== undefined && application !== 'BgblAlt' && { part }),
  };
}

/**
 * Match a Geschäftszahl to its owning court(s) by format. Returns up to two candidate courts
 * (probed in order); the shared DSB/Dok "YYYY-0.NNN.NNN" shape yields both. An empty result
 * means the format wasn't recognized — the caller falls back to `found: false`.
 */
function matchCaseCourts(input: string): RisCourtCode[] {
  const s = input.trim();
  const patterns: readonly [RegExp, readonly RisCourtCode[]][] = [
    [/\bUPTS\b/i, ['upts']],
    [/^LVwG-/i, ['lvwg']],
    [/^B-GBK\b/i, ['gbk']],
    [/\bPVA[BK]\b/i, ['pvak']],
    [/^VKS-/i, ['verg']],
    [/^[WLG]\d{2,4}\b/i, ['bvwg']],
    [/^R[aou]\s+\d{4}\//i, ['vwgh']],
    [/^\d{4}-\d\.\d{3}\.\d{3}\b/, ['dsk', 'dok']],
    [/^[A-Za-z]{1,3}\s+\d+\/\d{2,4}\b/, ['vfgh']],
    [/^\d{1,2}\s?[A-Za-zÄÖÜ]{1,4}\s?\d+\/\d{2}[a-z]?\b/, ['justiz']],
  ];
  for (const [re, courts] of patterns) {
    if (re.test(s)) return [...courts];
  }
  return [];
}

/** Classify a citation by shape (auto mode). Returns `null` when it doesn't classify. */
function classify(input: string, courtHint: RisCourtCode | undefined): CitationKind | null {
  if (parseCollection(input)) return 'collection_number';
  if (GAZETTE_PREFIX.test(input)) return 'gazette';
  if (NORM_EXPLICIT.test(input)) return 'norm';
  if (courtHint !== undefined || matchCaseCourts(input).length > 0) return 'case_number';
  if (BARE_ABBREVIATION.test(input.trim()) && !input.includes('/')) return 'norm';
  return null;
}

/* ------------------------------------------------------------------------------------ */
/* found: false guidance (verbatim per parse outcome — design.md)                        */
/* ------------------------------------------------------------------------------------ */

function unknownGuidance(input: string): string {
  return `Could not classify '${input}'. Expected forms — norm: '§ 6 DSG' / 'Art 10 B-VG'; gazette: 'BGBl. I Nr. 165/1999' (also pre-2004 and RGBl/StGBl forms, and LGBl with a state hint); case number: 'Ro 2026/03/0016'; collection: 'VfSlg 19.632/2012'. Formats: ris_list_reference topic citation_formats. Or set kind explicitly; for keyword search use ris_search_legislation / ris_search_case_law.`;
}

/**
 * Guidance for an unresolved norm citation. Takes the whole parse so the section type reaches
 * both the label and the retry recipe: `section_type` defaults to Paragraph once a section range
 * is set, so an Artikel recipe that omits it searches § N and returns zero even when the Artikel
 * exists. It is emitted for both types — the recipe is meant to be run verbatim, so it states the
 * filter rather than leaning on the default.
 */
function normGuidance(parsed: NormParse, date: string): string {
  const { abbreviation, section, sectionType } = parsed;
  const head =
    section !== undefined
      ? `No document for ${abbreviation} ${sectionMarker(sectionType)} ${section} in force on ${date}.`
      : `No document for ${abbreviation} in force on ${date}.`;
  const retry =
    section !== undefined
      ? `retry ris_search_legislation with title: '${abbreviation}', section_from/to: '${section}', section_type: '${sectionType ?? 'Paragraph'}', include_all_versions: true.`
      : `retry ris_search_legislation with title: '${abbreviation}', include_all_versions: true.`;
  return `${head} If the provision existed at another time, ${retry} If the abbreviation is uncertain, search ris_search_legislation title: '${abbreviation}*'. State law resolves only with an explicit state hint.`;
}

/**
 * Guidance for a gazette citation whose number could not be read. The prefix classified it as
 * a gazette but no number/year pair was present, so no tier was ever searched — the retry is
 * a corrected citation or a date browse, not a different filter.
 */
function gazetteFormatGuidance(citation: string): string {
  return `Could not read a gazette number from '${citation}'. A gazette citation needs a number and a year — 'BGBl. I Nr. 165/1999', 'BGBl. Nr. 194/1961', 'RGBl. Nr. 189/1902', or 'LGBl. Nr. 61/2026' with a state hint. Formats: ris_list_reference topic citation_formats. To search without a number, browse with ris_search_gazette published_from/published_to.`;
}

/**
 * Guidance for a gazette citation that parsed but did not resolve, composed from the route
 * that missed. Each route gets only the hints that bear on it: the part sentence reaches the
 * two federal tiers that carry a part split, the state-hint sentence only the state route that
 * lacks one, and the legacy-series pointer only a state route that has one. A single shared
 * string sent every route but one somewhere it could not act on.
 */
function gazetteGuidance(parsed: GazetteParse, state: RisStateCode | undefined): string {
  const { application, legacyApplication, needsState, number, part } = parsed;

  if (needsState) {
    return `Cannot resolve LGBl. Nr. ${number} without a state — each of the nine Bundesländer keeps its own Landesgesetzblatt, so nothing was searched. Set state to the issuing Bundesland and retry; codes: ris_list_reference topic states.`;
  }

  if (application === 'LgblAuth') {
    if (legacyApplication === 'Lgbl') {
      return `No gazette entry for ${number} in LgblAuth or the legacy Lgbl series — both were searched. The two are chronologically disjoint at that Bundesland's e-Recht switch, so a wrong year misses both. Verify the number and year against the cite; browse the surrounding range with ris_search_gazette scope: ${state ?? 'the Bundesland'}, published_from/published_to, adding state_era: legacy for the pre-switch series.`;
    }
    if (legacyApplication === 'LgblNO') {
      return `No gazette entry for ${number} in LgblAuth. Niederösterreich's pre-e-Recht record is the systematic LgblNO collection, keyed by Gliederungszahl rather than an LGBl. number, so it cannot be reached by this citation — search it with ris_search_gazette scope: niederoesterreich, state_era: legacy plus title or published_from/published_to. Otherwise verify the number and year against the cite.`;
    }
    return `No gazette entry for ${number} in LgblAuth. Wien is carried in neither legacy series, so a pre-e-Recht Wiener number has no route here. Verify the number and year against the cite; browse the surrounding range with ris_search_gazette scope: wien, published_from/published_to.`;
  }

  if (application === 'BgblAlt') {
    return `No gazette entry for ${number} in BgblAlt, which covers 1848–1940 and carries no part split — RIS holds no federal gazette for 1941–1944. Verify the number and year against the cite; browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number.`;
  }

  const partLabel = part === undefined ? undefined : 'I'.repeat(Number(part.slice(-1)));
  const partHint =
    partLabel === undefined
      ? 'No part filter was applied, so the number or the year is the mismatch.'
      : `Part ${partLabel} was applied as a filter — verify it and the year against the cite.`;
  const pre1997 =
    application === 'BgblPdf'
      ? ' Parts I/II/III exist only from 1997; ris_search_gazette takes part: pre_1997 for an earlier issue.'
      : '';
  return `No gazette entry for ${number} in ${application}. ${partHint}${pre1997} Browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number.`;
}

function caseGuidance(gz: string, candidates: readonly RisCourtCode[]): string {
  const probed =
    candidates.length > 0 ? candidates.map(courtApplication).join(', ') : 'no matching court';
  return `No decision for '${gz}' in ${probed}. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query.`;
}

/**
 * Guidance for an unresolved collection citation. Names the `Sammlungsnummer` value that was
 * actually sent and says it already carries the form that court stores, so the caller narrows
 * the cite rather than re-sending the same filter — the retry that made the old shared string
 * a dead end.
 */
function collectionGuidance(parsed: CollectionParse): string {
  const { court, filter, label, number } = parsed;
  const shape =
    court === 'vwgh'
      ? 'That filter already carries the labelled undotted form VwGH stores, so the number or the part letter (A administrative, F finance) is the mismatch — verify both against the cite.'
      : 'That filter is the bare number VfGH stores, matched dotted or undotted, so the number is the mismatch — verify it against the cite.';
  return `No decision for ${label} ${number} — Sammlungsnummer "${filter}" matched nothing. ${shape} Keyword fallback: ris_search_case_law court: ${court} with query.`;
}

/**
 * Guidance for a VwSlg citation that named more than one decision. With no part letter cited
 * the filter's wildcard spans both VwGH series, and they reuse numbers — so the match is not
 * one decision plus alternatives but several distinct cites, and returning the first would
 * answer a decision the caller did not cite.
 */
function collectionAmbiguityGuidance(parsed: CollectionParse, matched: readonly string[]): string {
  return `${parsed.label} ${parsed.number} names more than one decision — Sammlungsnummer "${parsed.filter}" matched ${matched.join(' and ')}. VwGH runs two collection series that reuse numbers (A administrative, F finance), so the part letter is what picks one — retry with the full cite. All matches: ris_search_case_law court: vwgh, collection_number "${parsed.filter}".`;
}

/** Distinct `Sammlungsnummer` values across one case-law result page, in hit order. */
function distinctCollectionNumbers(hits: readonly RisHit[]): string[] {
  const seen = new Set<string>();
  for (const { metadata } of hits) {
    if (metadata.controller === 'Judikatur' && metadata.collectionNumber !== undefined) {
      seen.add(metadata.collectionNumber);
    }
  }
  return [...seen];
}

/* ------------------------------------------------------------------------------------ */
/* Output shape                                                                          */
/* ------------------------------------------------------------------------------------ */

/**
 * Flat result. `record` is a passthrough object (the linter's escape hatch): the exact
 * normalized shape the corresponding search tool returns flows through to structuredContent
 * via the reused `toRecord` mapper, without re-declaring each field here.
 */
const LookupResultSchema = z.object({
  found: z
    .boolean()
    .describe('True when the citation resolved to a single best-matching document.'),
  kind: z
    .enum(['unknown', 'norm', 'gazette', 'case_number', 'collection_number'])
    .describe('What the citation parsed as — "unknown" when it did not classify into any route.'),
  resolution_note: z
    .string()
    .optional()
    .describe('Which application and filter resolved the citation. Present when found is true.'),
  record: z
    .object({})
    .passthrough()
    .optional()
    .describe(
      'The resolved document, in the same normalized shape the corresponding search tool returns — ris_search_legislation for a norm, ris_search_case_law for a case or collection number, ris_search_gazette for a gazette. Present when found is true.',
    ),
  alternatives_count: z
    .number()
    .optional()
    .describe(
      'Documents that also matched beyond the one returned — present only when more than one matched. List them all with the search tool named in resolution_note.',
    ),
  guidance: z
    .string()
    .optional()
    .describe('Next-step guidance naming a concrete tool. Present when found is false.'),
});

/** The resolver's result — contextual-types each handler return so `kind` stays a literal. */
type LookupResult = z.infer<typeof LookupResultSchema>;

/** Render any resolved record generically — every field of every record shape appears. */
function renderRecord(record: Readonly<Record<string, unknown>>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) lines.push(`**${key}**: ${value.join(', ')}`);
    } else if (typeof value === 'object') {
      const parts = Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([subKey, subValue]) => `${subKey} ${subValue}`);
      if (parts.length > 0) lines.push(`**${key}**: ${parts.join(' · ')}`);
    } else {
      lines.push(`**${key}**: ${String(value)}`);
    }
  }
  return lines.join('\n');
}

/** Today's date in Austria (Europe/Vienna), ISO `YYYY-MM-DD`. */
function todayInAustria(): string {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Vienna',
    year: 'numeric',
  }).format(new Date());
}

/** Map an empty string from a form-based client to `undefined`. */
function meaningful(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

export const risLookupCitation = tool('ris_lookup_citation', {
  title: 'Resolve Austrian Legal Citation',
  description:
    'Resolve a single Austrian legal citation to its canonical RIS document deterministically — no keyword search. Four routes are auto-detected from the citation shape (or forced with kind): a norm citation — section-first ("§ 6 DSG", "Art 10 B-VG"), abbreviation-first ("DSG §1", "DSGVO Art32", the shape ris_search_case_law returns in norms_cited), or a bare abbreviation like "ABGB" — resolves through consolidated federal law, or a Bundesland with a state hint, as in force today or on in_force_as_of; a gazette citation ("BGBl. I Nr. 165/1999", pre-2004 "BGBl. Nr. 194/1961", imperial "RGBl. Nr. 189/1902", or "LGBl. Nr. 61/2026" with a state hint) routes to the right federal era tier by year, or to a state Landesgesetzblatt — falling back to that Bundesland’s pre-e-Recht series when the citation predates its switch; a case number ("Ro 2026/03/0016", "G 287/2022", "14Os49/26a", "2025-0.934.677", "W256 …") is matched to its court — pass court to skip detection, and ambiguous formats probe up to two courts; a collection number ("VfSlg 19.632/2012", "VwSlg 18.000 A/2010") resolves through the VfGH/VwGH collection — a VwSlg cite given without its part letter can name one decision in each of the two VwGH series, and comes back as ambiguous with both cites named rather than resolved to one of them. Returns the single best-matching document in the same shape as the corresponding search tool, with alternatives_count when more than one matched. A citation that cannot be classified or resolved returns found: false with next-step guidance — it never throws for a miss; only an upstream RIS outage is an error. For keyword rather than citation lookup, use ris_search_legislation or ris_search_case_law.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    citation: z
      .string()
      .describe(
        'The legal citation to resolve, e.g. "§ 6 DSG" or "DSG §1", "Art 10 B-VG", "BGBl. I Nr. 165/1999", "Ro 2026/03/0016", or "VfSlg 19.632/2012".',
      ),
    kind: z
      .enum(['auto', 'norm', 'gazette', 'case_number', 'collection_number'])
      .default('auto')
      .describe(
        'Force a route, or auto (default) to classify by shape. Set explicitly when the citation shape is ambiguous.',
      ),
    court: z
      .enum(CASE_NUMBER_COURT_CODES)
      .optional()
      .describe(
        'Court hint for a case number — short-circuits court detection to this court. Codes: ris_list_reference topic courts, minus normenliste (a norm index, which carries no case numbers).',
      ),
    state: z
      .enum(STATE_CODES)
      .optional()
      .describe(
        'Bundesland hint — routes a norm to that state’s consolidated law (LrKons) and an LGBl. gazette to that state’s Landesgesetzblatt (LgblAuth, then the legacy Lgbl series for a citation predating the state’s e-Recht switch).',
      ),
    in_force_as_of: isoDateString
      .optional()
      .describe(
        'For a norm, resolve the version in force on this date (YYYY-MM-DD). Defaults to today in Austria.',
      ),
  }),
  output: LookupResultSchema,
  errors: [
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'A routed RIS search was unreachable, returned a server error, or served an HTML error page. An unparseable or unresolvable citation is NOT this error — it returns found: false.',
      retryable: true,
      recovery: 'RIS is temporarily unavailable — retry the same citation after a short delay.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'A routed RIS search did not answer within the request deadline.',
      retryable: true,
      recovery:
        'RIS did not answer in time — retry the same citation shortly, or pass kind plus a court or state hint so fewer routes are tried.',
    },
  ],

  async handler(input, ctx): Promise<LookupResult> {
    const citation = input.citation.trim();
    const courtHint = input.court;
    const stateHint = input.state;
    const asOf = meaningful(input.in_force_as_of) ?? todayInAustria();

    /**
     * Run a routed search: map an upstream failure to this tool's `upstream_error` or
     * `upstream_timeout` (separate codes since 0.10.17 split them — `ctx.fail` resolves the
     * code from the contract entry, so one reason cannot carry both), and a failed
     * deterministic filter (`ValidationError`) to a not-resolved `null`.
     */
    const runSearch = async (
      run: () => Promise<RisSearchResult>,
    ): Promise<RisSearchResult | null> => {
      try {
        return await run();
      } catch (err: unknown) {
        if (!(err instanceof McpError)) throw err;
        if (err.code === JsonRpcErrorCode.ServiceUnavailable) {
          throw ctx.fail('upstream_error', err.message, { ...ctx.recoveryFor('upstream_error') });
        }
        if (err.code === JsonRpcErrorCode.Timeout) {
          throw ctx.fail('upstream_timeout', err.message, {
            ...ctx.recoveryFor('upstream_timeout'),
          });
        }
        if (err.code === JsonRpcErrorCode.ValidationError) {
          return null;
        }
        throw err;
      }
    };

    const route = input.kind === 'auto' ? classify(citation, courtHint) : input.kind;

    if (route === null) {
      return { found: false, kind: 'unknown', guidance: unknownGuidance(citation) };
    }

    if (route === 'collection_number') {
      const parsed = parseCollection(citation);
      if (!parsed) {
        return {
          found: false,
          kind: 'collection_number',
          guidance: `Could not read a collection number from '${citation}'. Expected 'VfSlg 19.632/2012' or 'VwSlg 18.000 A/2010'. Fallback: ris_search_case_law court: vfgh | vwgh with query.`,
        };
      }
      const result = await runSearch(() =>
        getRisService().searchCaseLaw(
          { collectionNumber: parsed.filter, court: parsed.court },
          ctx,
        ),
      );
      const hit = result?.hits[0];
      if (!result || hit === undefined) {
        return {
          found: false,
          kind: 'collection_number',
          guidance: collectionGuidance(parsed),
        };
      }
      /*
       * A VwSlg cite carrying no part letter leaves the wildcard spanning both series, which
       * reuse numbers — "VwSlg 8000" is VwSlg 8000 A/1971 in one and VwSlg 8000 F/2005 in the
       * other. Returning the first would present a decision the caller never cited as the
       * resolution, so a span that actually shows up in the results is reported as such.
       */
      if (parsed.court === 'vwgh' && parsed.partLetter === undefined) {
        const matched = distinctCollectionNumbers(result.hits);
        if (matched.length > 1) {
          return {
            found: false,
            kind: 'collection_number',
            guidance: collectionAmbiguityGuidance(parsed, matched),
          };
        }
      }
      const application = courtApplication(parsed.court);
      const alternatives = result.total > 1 ? result.total - 1 : undefined;
      ctx.log.info('Citation resolved', { kind: route, application, total: result.total });
      return {
        found: true,
        kind: 'collection_number',
        record: toCaseLawRecord(hit, application),
        resolution_note: `Resolved via ris_search_case_law (${application}) — Sammlungsnummer "${parsed.filter}".${alternatives !== undefined ? ` ${alternatives} more matched — list them with ris_search_case_law court: ${parsed.court}.` : ''}`,
        ...(alternatives !== undefined && { alternatives_count: alternatives }),
      };
    }

    if (route === 'norm') {
      const parsed = parseNorm(citation);
      if (!parsed) {
        return {
          found: false,
          kind: 'norm',
          guidance: normGuidance({ abbreviation: citation }, asOf),
        };
      }
      const application: LegislationApplication = stateHint !== undefined ? 'LrKons' : 'BrKons';
      const params: LegislationSearchParams = {
        application,
        inForceAsOf: asOf,
        title: parsed.abbreviation,
        ...(parsed.section !== undefined && {
          sectionFrom: parsed.section,
          sectionTo: parsed.section,
          sectionType: parsed.sectionType,
        }),
        ...(stateHint !== undefined && { state: stateHint }),
      };
      const result = await runSearch(() => getRisService().searchLegislation(params, ctx));
      const hit = result?.hits[0];
      if (!result || hit === undefined) {
        return { found: false, kind: 'norm', guidance: normGuidance(parsed, asOf) };
      }
      const alternatives = result.total > 1 ? result.total - 1 : undefined;
      const sectionPhrase =
        parsed.section !== undefined
          ? `, ${sectionMarker(parsed.sectionType)} ${parsed.section}`
          : '';
      ctx.log.info('Citation resolved', { kind: route, application, total: result.total });
      return {
        found: true,
        kind: 'norm',
        record: toLegislationRecord(hit, application),
        resolution_note: `Resolved via ris_search_legislation (${application}) — title "${parsed.abbreviation}"${sectionPhrase}, in force ${asOf}.${alternatives !== undefined ? ` ${alternatives} more matched — list them with ris_search_legislation.` : ''}`,
        ...(alternatives !== undefined && { alternatives_count: alternatives }),
      };
    }

    if (route === 'gazette') {
      const parsed = parseGazette(citation, stateHint);
      if (!parsed) {
        return { found: false, kind: 'gazette', guidance: gazetteFormatGuidance(citation) };
      }
      if (parsed.needsState) {
        return { found: false, kind: 'gazette', guidance: gazetteGuidance(parsed, stateHint) };
      }
      /*
       * Applications probed in order. A state citation predating that Bundesland's e-Recht
       * switch lives in the legacy Lgbl series rather than LgblAuth, and the switch year
       * differs per state — so the boundary is probed the way the case-number route probes
       * its candidate courts, not hardcoded.
       */
      const applications: GazetteApplication[] =
        parsed.legacyApplication === 'Lgbl' ? [parsed.application, 'Lgbl'] : [parsed.application];
      let resolved: { application: GazetteApplication; hit: RisHit; total: number } | undefined;
      for (const application of applications) {
        const params: GazetteSearchParams = {
          application,
          number: parsed.number,
          ...(parsed.part !== undefined && { part: parsed.part }),
          ...(stateHint !== undefined &&
            (application === 'LgblAuth' || application === 'Lgbl') && { state: stateHint }),
        };
        const result = await runSearch(() => getRisService().searchGazette(params, ctx));
        const hit = result?.hits[0];
        if (result && hit !== undefined) {
          resolved = { application, hit, total: result.total };
          break;
        }
      }
      if (resolved === undefined) {
        return { found: false, kind: 'gazette', guidance: gazetteGuidance(parsed, stateHint) };
      }
      const alternatives = resolved.total > 1 ? resolved.total - 1 : undefined;
      const partPhrase = parsed.part !== undefined ? `, part ${parsed.part.slice(-1)}` : '';
      /*
       * Both halves of the state recipe — a number alone reproduces nothing without the scope.
       * Only the two state series took the hint, so a stray state on a federal citation must
       * not be reported as a filter that was applied.
       */
      const scopePhrase =
        stateHint !== undefined &&
        (resolved.application === 'LgblAuth' || resolved.application === 'Lgbl')
          ? `, scope: ${stateHint}`
          : '';
      const eraPhrase = resolved.application === 'Lgbl' ? ', state_era: legacy' : '';
      ctx.log.info('Citation resolved', {
        application: resolved.application,
        kind: route,
        total: resolved.total,
      });
      return {
        found: true,
        kind: 'gazette',
        record: toGazetteRecord(resolved.hit, resolved.application),
        resolution_note: `Resolved via ris_search_gazette (${resolved.application}) — number "${parsed.number}"${partPhrase}${scopePhrase}${eraPhrase}.${alternatives !== undefined ? ` ${alternatives} more matched — list them with ris_search_gazette.` : ''}`,
        ...(alternatives !== undefined && { alternatives_count: alternatives }),
      };
    }

    // route === 'case_number'
    const candidates = courtHint !== undefined ? [courtHint] : matchCaseCourts(citation);
    if (candidates.length === 0) {
      return { found: false, kind: 'case_number', guidance: caseGuidance(citation, candidates) };
    }
    let resolved: { court: RisCourtCode; hit: RisHit; total: number } | undefined;
    for (const court of candidates) {
      const result = await runSearch(() =>
        getRisService().searchCaseLaw({ caseNumber: citation, court }, ctx),
      );
      const hit = result?.hits[0];
      if (result && hit !== undefined) {
        resolved = { court, hit, total: result.total };
        break;
      }
    }
    if (resolved === undefined) {
      return { found: false, kind: 'case_number', guidance: caseGuidance(citation, candidates) };
    }
    const application = courtApplication(resolved.court);
    const alternatives = resolved.total > 1 ? resolved.total - 1 : undefined;
    ctx.log.info('Citation resolved', { application, kind: route, total: resolved.total });
    return {
      found: true,
      kind: 'case_number',
      record: toCaseLawRecord(resolved.hit, application),
      resolution_note: `Resolved via ris_search_case_law (${application}) — Geschäftszahl "${citation}".${alternatives !== undefined ? ` ${alternatives} more matched — list them with ris_search_case_law court: ${resolved.court}.` : ''}`,
      ...(alternatives !== undefined && { alternatives_count: alternatives }),
    };
  },

  // format() populates content[] — the markdown twin of structuredContent. Renders every
  // output field: found/kind/resolution_note, the resolved record, alternatives_count, and
  // the found: false guidance.
  format: (result) => {
    const lines: string[] = [`**found**: ${result.found}`, `**kind**: ${result.kind}`];
    if (result.resolution_note !== undefined) {
      lines.push(`**resolution_note**: ${result.resolution_note}`);
    }
    if (result.record !== undefined) {
      lines.push(
        '',
        '### Resolved document',
        renderRecord(result.record as Readonly<Record<string, unknown>>),
      );
    }
    if (result.alternatives_count !== undefined) {
      lines.push('', `**alternatives_count**: ${result.alternatives_count}`);
    }
    if (result.guidance !== undefined) lines.push('', result.guidance);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
