/**
 * @fileoverview ris_lookup_citation — the deterministic citation resolver. Parses one
 * Austrian legal citation, classifies it into one of four routes (norm, gazette, case
 * number, collection number), and routes it to the owning search application with a
 * deterministic filter, returning the single best-matching document.
 *
 * The core contract: unparseable OR unresolvable input is a `{ found: false, kind, guidance }`
 * RESULT, never a throw — the agent self-corrects from structured guidance better than from
 * an exception (fleet precedent: eur-lex lookup_celex, pubmed/courtlistener lookup_citation).
 * The ONLY thrown error is `upstream_error` when a routed search fails upstream
 * (ServiceUnavailable). A service InvalidParams/ValidationError during a routed lookup is a
 * failed deterministic filter = no resolution = `found: false`, not an error.
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

const COURT_CODES = RIS_COURTS.map((c) => c.code) as [RisCourtCode, ...RisCourtCode[]];
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
  readonly label: 'VfSlg' | 'VwSlg';
  readonly number: string;
}

/**
 * Parse a VfSlg/VwSlg collection citation. The Sammlungsnummer is the dotted numeric core:
 * the trailing `/year` and any part letter ("A"/"F" in VwSlg) are dropped, the thousands dot
 * kept (the canonical cite form).
 */
function parseCollection(input: string): CollectionParse | null {
  const m = /^\s*(vf|vw)slg\b\s*(.*)$/i.exec(input);
  if (!m) return null;
  const [, prefix, rest] = m;
  if (prefix === undefined || rest === undefined) return null;
  const numMatch = /\d[\d.]*\d|\d/.exec(rest);
  if (!numMatch) return null;
  const isVfgh = prefix.toLowerCase() === 'vf';
  return {
    court: isVfgh ? 'vfgh' : 'vwgh',
    label: isVfgh ? 'VfSlg' : 'VwSlg',
    number: numMatch[0],
  };
}

/** Parsed gazette citation, already routed to its era tier / state application. */
interface GazetteParse {
  readonly application: GazetteApplication;
  /** True when a state gazette (LGBl.) was given without the state hint needed to resolve it. */
  readonly needsState: boolean;
  readonly number: string;
  readonly part?: 'part1' | 'part2' | 'part3';
}

/**
 * Parse a gazette citation and route it to the owning application: federal BGBl. by year
 * (BgblAuth 2004+, BgblPdf 1945–2003, BgblAlt before 1945), imperial RGBl./StGBl./GBlÖ to
 * BgblAlt, and LGBl. to the state Landesgesetzblatt (LgblAuth) when a state hint is present.
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
    return { application: 'LgblAuth', needsState: stateHint === undefined, number };
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
  return `Could not classify '${input}'. Expected forms — norm: '§ 6 DSG' / 'Art 10 B-VG'; gazette: 'BGBl. I Nr. 165/1999' (also pre-2004 and RGBl/StGBl forms, and LGBl with a state hint); case number: 'Ra 2019/22/0184'; collection: 'VfSlg 19.632/2012'. Formats: ris_list_reference topic citation_formats. Or set kind explicitly; for keyword search use ris_search_legislation / ris_search_case_law.`;
}

function normGuidance(abbreviation: string, section: string | undefined, date: string): string {
  const head =
    section !== undefined
      ? `No document for ${abbreviation} § ${section} in force on ${date}.`
      : `No document for ${abbreviation} in force on ${date}.`;
  const retry =
    section !== undefined
      ? `retry ris_search_legislation with title: '${abbreviation}', section_from/to: '${section}', include_all_versions: true.`
      : `retry ris_search_legislation with title: '${abbreviation}', include_all_versions: true.`;
  return `${head} If the provision existed at another time, ${retry} If the abbreviation is uncertain, search ris_search_legislation title: '${abbreviation}*'. State law resolves only with an explicit state hint.`;
}

function gazetteGuidance(number: string, tier: string): string {
  return `No gazette entry for ${number} in ${tier}. Verify part (I/II/III — none before 1997) and year; browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number. State gazettes need the state hint.`;
}

function caseGuidance(gz: string, candidates: readonly RisCourtCode[]): string {
  const probed =
    candidates.length > 0 ? candidates.map(courtApplication).join(', ') : 'no matching court';
  return `No decision for '${gz}' in ${probed}. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query.`;
}

function collectionGuidance(label: string, number: string, court: 'vfgh' | 'vwgh'): string {
  return `No decision for ${label} ${number}. Verify the number against the cite; fallback: ris_search_case_law court: ${court} with query.`;
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
    'Resolve a single Austrian legal citation to its canonical RIS document deterministically — no keyword search. Four routes are auto-detected from the citation shape (or forced with kind): a norm citation — section-first ("§ 6 DSG", "Art 10 B-VG"), abbreviation-first ("DSG §1", "DSGVO Art32", the shape ris_search_case_law returns in norms_cited), or a bare abbreviation like "ABGB" — resolves through consolidated federal law, or a Bundesland with a state hint, as in force today or on in_force_as_of; a gazette citation ("BGBl. I Nr. 165/1999", pre-2004 "BGBl. Nr. 194/1961", imperial "RGBl. Nr. 189/1902", or "LGBl. Nr. 61/2026" with a state hint) routes to the right federal era tier by year or to a state Landesgesetzblatt; a case number ("Ra 2019/22/0184", "G 287/2022", "6Ob56/25k", "2025-0.934.677", "W256 …") is matched to its court — pass court to skip detection, and ambiguous formats probe up to two courts; a collection number ("VfSlg 19.632/2012", "VwSlg 18.000 A/2010") resolves through the VfGH/VwGH collection. Returns the single best-matching document in the same shape as the corresponding search tool, with alternatives_count when more than one matched. A citation that cannot be classified or resolved returns found: false with next-step guidance — it never throws for a miss; only an upstream RIS outage is an error. For keyword rather than citation lookup, use ris_search_legislation or ris_search_case_law.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    citation: z
      .string()
      .describe(
        'The legal citation to resolve, e.g. "§ 6 DSG" or "DSG §1", "Art 10 B-VG", "BGBl. I Nr. 165/1999", "Ra 2019/22/0184", or "VfSlg 19.632/2012".',
      ),
    kind: z
      .enum(['auto', 'norm', 'gazette', 'case_number', 'collection_number'])
      .default('auto')
      .describe(
        'Force a route, or auto (default) to classify by shape. Set explicitly when the citation shape is ambiguous.',
      ),
    court: z
      .enum(COURT_CODES)
      .optional()
      .describe(
        'Court hint for a case number — short-circuits court detection to this court. Codes: ris_list_reference topic courts.',
      ),
    state: z
      .enum(STATE_CODES)
      .optional()
      .describe(
        'Bundesland hint — routes a norm to that state’s consolidated law (LrKons) and an LGBl. gazette to that state’s Landesgesetzblatt (LgblAuth).',
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
  ],

  async handler(input, ctx): Promise<LookupResult> {
    const citation = input.citation.trim();
    const courtHint = input.court;
    const stateHint = input.state;
    const asOf = meaningful(input.in_force_as_of) ?? todayInAustria();

    /**
     * Run a routed search: map an upstream failure to this tool's `upstream_error`, and a
     * failed deterministic filter (InvalidParams / ValidationError) to a not-resolved `null`.
     */
    const runSearch = async (
      run: () => Promise<RisSearchResult>,
    ): Promise<RisSearchResult | null> => {
      try {
        return await run();
      } catch (err: unknown) {
        if (err instanceof McpError && err.code === JsonRpcErrorCode.ServiceUnavailable) {
          throw ctx.fail('upstream_error', err.message, { ...ctx.recoveryFor('upstream_error') });
        }
        if (
          err instanceof McpError &&
          (err.code === JsonRpcErrorCode.InvalidParams ||
            err.code === JsonRpcErrorCode.ValidationError)
        ) {
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
          { collectionNumber: parsed.number, court: parsed.court },
          ctx,
        ),
      );
      const hit = result?.hits[0];
      if (!result || hit === undefined) {
        return {
          found: false,
          kind: 'collection_number',
          guidance: collectionGuidance(parsed.label, parsed.number, parsed.court),
        };
      }
      const application = courtApplication(parsed.court);
      const alternatives = result.total > 1 ? result.total - 1 : undefined;
      ctx.log.info('Citation resolved', { kind: route, application, total: result.total });
      return {
        found: true,
        kind: 'collection_number',
        record: toCaseLawRecord(hit, application),
        resolution_note: `Resolved via ris_search_case_law (${application}) — Sammlungsnummer "${parsed.number}".${alternatives !== undefined ? ` ${alternatives} more matched — list them with ris_search_case_law court: ${parsed.court}.` : ''}`,
        ...(alternatives !== undefined && { alternatives_count: alternatives }),
      };
    }

    if (route === 'norm') {
      const parsed = parseNorm(citation);
      if (!parsed) {
        return { found: false, kind: 'norm', guidance: normGuidance(citation, undefined, asOf) };
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
        return {
          found: false,
          kind: 'norm',
          guidance: normGuidance(parsed.abbreviation, parsed.section, asOf),
        };
      }
      const alternatives = result.total > 1 ? result.total - 1 : undefined;
      const sectionPhrase =
        parsed.section !== undefined
          ? `, ${parsed.sectionType === 'Artikel' ? 'Art' : '§'} ${parsed.section}`
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
        return {
          found: false,
          kind: 'gazette',
          guidance: gazetteGuidance(citation, 'the requested gazette tier'),
        };
      }
      if (parsed.needsState) {
        return {
          found: false,
          kind: 'gazette',
          guidance: gazetteGuidance(parsed.number, 'a state Landesgesetzblatt'),
        };
      }
      const params: GazetteSearchParams = {
        application: parsed.application,
        number: parsed.number,
        ...(parsed.part !== undefined && { part: parsed.part }),
        ...(stateHint !== undefined && parsed.application === 'LgblAuth' && { state: stateHint }),
      };
      const result = await runSearch(() => getRisService().searchGazette(params, ctx));
      const hit = result?.hits[0];
      if (!result || hit === undefined) {
        return {
          found: false,
          kind: 'gazette',
          guidance: gazetteGuidance(parsed.number, parsed.application),
        };
      }
      const alternatives = result.total > 1 ? result.total - 1 : undefined;
      const partPhrase = parsed.part !== undefined ? `, part ${parsed.part.slice(-1)}` : '';
      ctx.log.info('Citation resolved', {
        application: parsed.application,
        kind: route,
        total: result.total,
      });
      return {
        found: true,
        kind: 'gazette',
        record: toGazetteRecord(hit, parsed.application),
        resolution_note: `Resolved via ris_search_gazette (${parsed.application}) — number "${parsed.number}"${partPhrase}.${alternatives !== undefined ? ` ${alternatives} more matched — list them with ris_search_gazette.` : ''}`,
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
