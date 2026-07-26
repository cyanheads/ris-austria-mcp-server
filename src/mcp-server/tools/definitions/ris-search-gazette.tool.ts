/**
 * @fileoverview ris_search_gazette — browse Austria's promulgation record at every level of
 * government. `scope` selects the jurisdiction; the three federal era tiers (BgblAuth 2004+,
 * BgblPdf 1945–2003, BgblAlt 1848–1940) are auto-routed by the year in the number or date
 * range, and the resolved application is echoed in enrichment. State scopes pick a `series`
 * (law vs ordinance gazette) and a `state_era` (the authentic LgblAuth vs the state's earlier
 * Lgbl/LgblNO series) — orthogonal axes, with `legacy` under `ordinance_gazette` rejected
 * locally since Vbl has no legacy counterpart. Conditional filters are guarded locally before
 * any upstream call. Ordinance gazettes (Vbl) currently cover Tirol only — a non-Tirol request
 * short-circuits to a zero-hit notice rather than a server error.
 * @module mcp-server/tools/definitions/ris-search-gazette
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { RIS_STATES } from '@/services/ris/reference/index.js';
import type {
  GazetteApplication,
  GazetteSearchParams,
  RisStateCode,
} from '@/services/ris/request-builder.js';
import { getRisService } from '@/services/ris/ris-service.js';
import type { RisHit } from '@/services/ris/types.js';

import { failSearchError, isoDateString } from './_shared.js';

const STATE_CODES = RIS_STATES.map((s) => s.code) as [RisStateCode, ...RisStateCode[]];
const GAZETTE_SCOPE_VALUES = ['federal', ...STATE_CODES, 'district', 'municipal'] as [
  'federal',
  ...RisStateCode[],
  'district',
  'municipal',
];
const STATE_CODE_SET = new Set<string>(STATE_CODES);

/** Binding label per gazette application (canonical seven-label list, Design Decisions). */
const GAZETTE_BINDING: Record<
  GazetteApplication,
  'authentic' | 'consolidated_informational' | 'historical_record'
> = {
  BgblAlt: 'historical_record',
  BgblAuth: 'authentic',
  BgblPdf: 'historical_record',
  Bvb: 'authentic',
  GrA: 'authentic',
  Lgbl: 'historical_record',
  LgblAuth: 'authentic',
  LgblNO: 'consolidated_informational',
  Vbl: 'authentic',
};

/** Roman-numeral part the federal `part` filter names — for the number/part consistency notice. */
const PART_ROMAN: Partial<Record<NonNullable<GazetteSearchParams['part']>, string>> = {
  part1: 'I',
  part2: 'II',
  part3: 'III',
};

/** States the Verordnungsblätter (Vbl) backend actually resolves — currently Tirol only. */
const VBL_COVERED = new Set<string>(['tirol']);

type GazetteEra = 'current' | 'imperial' | 'postwar';

/** True when a `scope` value is one of the nine Bundesländer. */
function isStateScope(scope: string): scope is RisStateCode {
  return STATE_CODE_SET.has(scope);
}

/** Year at the trailing edge of a gazette number ("171/2026", "189/1902"); bare numbers → undefined. */
function yearFromNumber(number: string | undefined): number | undefined {
  const match = number === undefined ? null : /(\d{4})\s*$/.exec(number.trim());
  return match ? Number.parseInt(match[1] as string, 10) : undefined;
}

/** Leading four-digit year of an ISO date ("1961-03-01" → 1961). */
function yearFromDate(date: string | undefined): number | undefined {
  const match = date === undefined ? null : /^(\d{4})/.exec(date.trim());
  return match ? Number.parseInt(match[1] as string, 10) : undefined;
}

/**
 * Route a federal (Bundesgesetzblatt) query to its era tier by the year signal: the number's
 * trailing year, else the date range. `part: pre_1997` forces the post-war PDF tier.
 */
function resolveFederalTier(
  number: string | undefined,
  publishedFrom: string | undefined,
  publishedTo: string | undefined,
  part: GazetteSearchParams['part'],
): { application: GazetteApplication; era: GazetteEra } {
  if (part === 'pre_1997') return { application: 'BgblPdf', era: 'postwar' };
  const year = yearFromNumber(number) ?? yearFromDate(publishedFrom) ?? yearFromDate(publishedTo);
  if (year === undefined || year >= 2004) return { application: 'BgblAuth', era: 'current' };
  if (year >= 1945) return { application: 'BgblPdf', era: 'postwar' };
  return { application: 'BgblAlt', era: 'imperial' };
}

/** Map an empty string from a form-based client to `undefined`. */
function meaningful(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

const ContentUrlsSchema = z
  .object({
    xml: z.string().optional().describe('XML rendition URL (RIS Nutzdaten schema).'),
    html: z.string().optional().describe('HTML rendition URL.'),
    pdf: z.string().optional().describe('PDF rendition URL.'),
    rtf: z.string().optional().describe('RTF rendition URL.'),
  })
  .describe(
    'Rendition URLs of the main document. BgblAlt carries none (metadata-only, ÖNB scans); district/municipal gazettes publish the authentic PDF only (see authentic_pdf_url).',
  );

export const GazetteRecordSchema = z
  .object({
    document_number: z
      .string()
      .describe(
        'Technical RIS document number (e.g. BGBLA_2026_II_171, 1961_194_0, rgb1902_…, LGBLA_SA_…, VBL_TI_…, BVB_ST_…, GEMREA_OB_…) — pass together with the served application to ris_get_document.',
      ),
    gazette_number: z
      .string()
      .optional()
      .describe(
        'Gazette number (Bgblnummer / Lgblnummer / Kundmachungsnummer / BgblAlt Fundstelle), where assigned.',
      ),
    part: z
      .string()
      .optional()
      .describe('Federal gazette part (Teil — I / II / III), where the tier carries a part split.'),
    type: z
      .string()
      .optional()
      .describe(
        'Norm/document type (Typ — Gesetz, Verordnung, …) — glossary: ris_list_reference topic law_types.',
      ),
    published: z
      .string()
      .optional()
      .describe('Promulgation / publication date (Kundmachungsdatum / Ausgabedatum).'),
    issuer: z
      .string()
      .optional()
      .describe('Issuing body (Einbringer / Organ), where the record carries one.'),
    district_authority: z
      .string()
      .optional()
      .describe(
        'District administrative authority (Bezirksverwaltungsbehörde) — district gazettes only.',
      ),
    municipality: z
      .string()
      .optional()
      .describe('Municipality the promulgation belongs to (Gemeinde) — municipal gazettes only.'),
    title: z.string().optional().describe('Full document title, HTML markup stripped.'),
    short_title: z.string().optional().describe('Short title (Kurztitel), where assigned.'),
    eli: z
      .string()
      .optional()
      .describe('European Legislation Identifier, where assigned (federal coverage is best).'),
    binding: z
      .enum(['authentic', 'consolidated_informational', 'historical_record'])
      .describe(
        'Legal binding status: authentic (amtssigniert, legally binding — BgblAuth/LgblAuth/Vbl/Bvb/GrA), historical_record (superseded/pre-e-Recht promulgation — BgblPdf/BgblAlt/Lgbl), or consolidated_informational (NÖ systematic collection — LgblNO).',
      ),
    authentic_pdf_url: z
      .string()
      .optional()
      .describe(
        'The amtssigniert authentic PDF (.pdfsig, Authentisch DataType) — the legally binding artifact — where the gazette publishes one.',
      ),
    alex_url: z
      .string()
      .optional()
      .describe(
        'ÖNB ALEX scan of the gazette issue (AlexUrl) — the fetchable document for the metadata-only imperial/interwar tier (BgblAlt, 1848–1940), which carries no content_urls.',
      ),
    document_url: z
      .string()
      .optional()
      .describe('RIS web view of the gazette document (DokumentUrl) — for humans.'),
    content_urls: ContentUrlsSchema,
  })
  .describe('One gazette entry from the resolved application.');

export type GazetteRecord = z.infer<typeof GazetteRecordSchema>;

/** Pick the four core rendition URLs off a normalized hit. */
function pickContentUrls(hit: RisHit): GazetteRecord['content_urls'] {
  const { html, pdf, rtf, xml } = hit.contentUrls;
  return {
    ...(xml !== undefined && { xml }),
    ...(html !== undefined && { html }),
    ...(pdf !== undefined && { pdf }),
    ...(rtf !== undefined && { rtf }),
  };
}

/** Map a normalized RIS hit to the tool's record shape (application drives the binding label). */
export function toRecord(hit: RisHit, application: GazetteApplication): GazetteRecord {
  const base: GazetteRecord = {
    binding: GAZETTE_BINDING[application],
    content_urls: pickContentUrls(hit),
    document_number: hit.documentNumber,
    ...(hit.contentUrls.authentic !== undefined && {
      authentic_pdf_url: hit.contentUrls.authentic,
    }),
    ...(hit.documentUrl !== undefined && { document_url: hit.documentUrl }),
  };
  const issuer = hit.submitter ?? hit.organ;
  const md = hit.metadata;
  if (md.controller === 'Bundesrecht') {
    return {
      ...base,
      ...(md.alexUrl !== undefined && { alex_url: md.alexUrl }),
      ...(md.eli !== undefined && { eli: md.eli }),
      ...(md.gazetteNumber !== undefined && { gazette_number: md.gazetteNumber }),
      ...(issuer !== undefined && { issuer }),
      ...(md.part !== undefined && { part: md.part }),
      ...(md.publishedDate !== undefined && { published: md.publishedDate }),
      ...(md.shortTitle !== undefined && { short_title: md.shortTitle }),
      ...(md.title !== undefined && { title: md.title }),
      ...(md.normType !== undefined && { type: md.normType }),
    };
  }
  if (md.controller === 'Landesrecht') {
    return {
      ...base,
      ...(md.eli !== undefined && { eli: md.eli }),
      ...(md.gazetteNumber !== undefined && { gazette_number: md.gazetteNumber }),
      ...(issuer !== undefined && { issuer }),
      ...(md.publishedDate !== undefined && { published: md.publishedDate }),
      ...(md.shortTitle !== undefined && { short_title: md.shortTitle }),
      ...(md.title !== undefined && { title: md.title }),
      ...(md.normType !== undefined && { type: md.normType }),
    };
  }
  if (md.controller === 'Bezirke') {
    return {
      ...base,
      ...(md.districtAuthority !== undefined && { district_authority: md.districtAuthority }),
      ...(md.gazetteNumber !== undefined && { gazette_number: md.gazetteNumber }),
      ...(issuer !== undefined && { issuer }),
      ...(md.publishedDate !== undefined && { published: md.publishedDate }),
      ...(md.shortTitle !== undefined && { short_title: md.shortTitle }),
      ...(md.title !== undefined && { title: md.title }),
      ...(md.normType !== undefined && { type: md.normType }),
    };
  }
  if (md.controller === 'Gemeinden') {
    return {
      ...base,
      ...(md.gazetteNumber !== undefined && { gazette_number: md.gazetteNumber }),
      ...(issuer !== undefined && { issuer }),
      ...(md.municipality !== undefined && { municipality: md.municipality }),
      ...(md.publishedDate !== undefined && { published: md.publishedDate }),
      ...(md.shortTitle !== undefined && { short_title: md.shortTitle }),
      ...(md.title !== undefined && { title: md.title }),
      ...(md.normType !== undefined && { type: md.normType }),
    };
  }
  return base;
}

export const risSearchGazette = tool('ris_search_gazette', {
  title: 'Search Austrian Gazettes',
  description:
    'Browse Austria’s promulgation record — the authentic, legally binding gazettes — at every level of government. scope picks the jurisdiction: federal (default; the Bundesgesetzblatt across three era tiers auto-routed by year — BgblAuth 2004+ authentic, BgblPdf 1945–2003, BgblAlt 1848–1940 metadata-only ÖNB scans), one Bundesland (its Landesgesetzblatt), district (Bezirke promulgations), or municipal (Gemeinde promulgations). For a state scope, series selects law gazettes (law_gazette, the default → LGBl) vs ordinance gazettes (ordinance_gazette → Verordnungsblätter, currently Tirol only), and state_era picks which era of that series to search: current (the default → the authentic LGBl) or legacy (the state’s earlier non-authentic series — Niederösterreich’s systematic LgblNO, or the older Lgbl elsewhere; Wien carries neither, and ordinance gazettes have no legacy series). Filter by query (full text), title, number ("171/2026" — a pre-2004 number auto-routes to the right era tier), part (federal I/II/III or pre_1997), type (laws/regulations/announcements/other), published_from/to, issuer (federal or ordinance gazettes only), district_authority (district only), or municipality (municipal only). Every result carries a binding label (authentic vs historical_record vs consolidated_informational) and the amtssigniert authentic PDF wherever it exists — the binding artifact, never a paraphrase. For one known gazette number, ris_lookup_citation resolves it directly. Coverage windows, era tiers, and part semantics: ris_list_reference topic applications or gazette_parts.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    scope: z
      .enum(GAZETTE_SCOPE_VALUES)
      .default('federal')
      .describe(
        'Jurisdiction level: federal (default — the Bundesgesetzblatt, era tier auto-routed), a Bundesland (burgenland … wien, its Landesgesetzblatt), district (Bezirke promulgations), or municipal (Gemeinde promulgations).',
      ),
    series: z
      .enum(['law_gazette', 'ordinance_gazette'])
      .optional()
      .describe(
        'State scopes only. law_gazette (default when omitted) searches the authentic Landesgesetzblatt; ordinance_gazette searches the Verordnungsblätter (Vbl — currently Tirol only, 2022+).',
      ),
    state_era: z
      .enum(['current', 'legacy'])
      .optional()
      .describe(
        'State scopes only. current (default when omitted) searches the authentic Landesgesetzblatt; legacy searches the state’s earlier non-authentic series — Niederösterreich’s systematic LgblNO collection, or the historical Lgbl for the other Bundesländer (Wien carries neither).',
      ),
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search (Suchworte). Boolean operators UND/ODER/NICHT or AND/OR/NOT, parentheses, quoted phrases; wildcard * is trailing-only. Syntax: ris_list_reference topic search_syntax.',
      ),
    title: z
      .string()
      .optional()
      .describe(
        'Title search (Titel) — phrase field: * allowed leading or trailing with ≥2 characters beside it.',
      ),
    number: z
      .string()
      .optional()
      .describe(
        'Gazette number, e.g. "171/2026" or "BGBl. II Nr. 171/2026" (federal), "61/2026" (state), a Kundmachungsnummer (district/municipal). A trailing year routes a federal query to the right era tier; a bare number searches the current tier.',
      ),
    part: z
      .enum(['part1', 'part2', 'part3', 'pre_1997'])
      .optional()
      .describe(
        'Federal only. part1 (Gesetze) | part2 (Verordnungen) | part3 (Staatsverträge) — parts exist from 1997; pre_1997 searches the older partless BGBl (routes to the 1945–2003 tier). Semantics: ris_list_reference topic gazette_parts.',
      ),
    type: z
      .enum(['laws', 'regulations', 'announcements', 'other'])
      .optional()
      .describe(
        'Document-type filter (Typ) for federal and state law gazettes: laws (Gesetze) | regulations (Verordnungen) | announcements (Kundmachungen) | other (Sonstiges).',
      ),
    published_from: isoDateString
      .optional()
      .describe(
        'Earliest promulgation date (YYYY-MM-DD). A pre-2004 range routes a federal query to an earlier era tier.',
      ),
    published_to: isoDateString.optional().describe('Latest promulgation date (YYYY-MM-DD).'),
    issuer: z
      .string()
      .optional()
      .describe(
        'Issuing body — federal (EinbringendeStelle, e.g. "BMF") or ordinance gazettes (Vbl Einbringer: Landeshauptmann/frau, Landesregierung, Amt der Landesregierung, Sonstige Landesbehörden) only. Phrase field.',
      ),
    district_authority: z
      .string()
      .optional()
      .describe(
        'District only. Bezirksverwaltungsbehörde name, e.g. "Bezirkshauptmannschaft Liezen" — full list: ris_list_reference topic district_authorities.',
      ),
    municipality: z
      .string()
      .optional()
      .describe('Municipal only. Exact municipality name (Gemeinde), RIS’s spelling.'),
    sort_by: z
      .enum(['published', 'number'])
      .optional()
      .describe(
        'Sort column: published (Kundmachungsdatum) or number. Availability varies by tier; default: upstream order.',
      ),
    sort_direction: z
      .enum(['ascending', 'descending'])
      .optional()
      .describe('Sort direction; applies with sort_by.'),
    page: z.number().int().min(1).optional().describe('1-based result page. Default 1.'),
    page_size: z
      .union([z.literal(10), z.literal(20), z.literal(50), z.literal(100)])
      .optional()
      .describe('Documents per page — RIS accepts 10, 20, 50, or 100. Default 20.'),
  }),
  output: z.object({
    results: z
      .array(GazetteRecordSchema)
      .describe(
        'Matching gazette entries for the requested page. Totals, paging, and the served application in enrichment.',
      ),
  }),
  enrichment: {
    totalCount: z.number().describe('Total matching entries across all pages.'),
    page: z.number().describe('1-based page number RIS served.'),
    pageSize: z.number().describe('Page size RIS applied.'),
    truncated: z
      .boolean()
      .optional()
      .describe('Present and true when more pages exist beyond this one — raise page to continue.'),
    servedApplication: z
      .string()
      .describe(
        'The RIS application that served the query — for federal, the era tier auto-routed by year (BgblAuth 2004+, BgblPdf 1945–2003, BgblAlt 1848–1940); otherwise the resolved state/district/municipal application.',
      ),
    notice: z
      .string()
      .optional()
      .describe('Zero-hit guidance — names the likely cause and the concrete next call.'),
  },
  errors: [
    {
      reason: 'scope_filter_mismatch',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A filter was combined with a scope that does not support it (part off federal; series/state_era off a state scope; district_authority off district; municipality off municipal; issuer outside federal/ordinance gazettes), or series: ordinance_gazette was combined with state_era: legacy (ordinance gazettes have no legacy counterpart) — rejected locally before any upstream call; the message names the offending pair.',
      recovery:
        'Drop the named filter or adjust scope: part applies only to scope: federal; series and state_era only to a state scope; district_authority only to scope: district; municipality only to scope: municipal; issuer only to federal or ordinance gazettes. state_era: legacy has no ordinance-gazette counterpart — drop one of that pair. Semantics: ris_list_reference topic gazette_parts or applications.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A parameter value was rejected — either locally, because the gazette series the scope routes to carries no mapping for it (a sort_by column, or a state absent from the historical Lgbl series), or by RIS in-band (the Client error message is passed through verbatim and names the invalid element and its valid values).',
      recovery:
        'Correct the parameter named in the message, or drop it if this gazette series does not carry it. Part and type semantics: ris_list_reference topic gazette_parts or law_types.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'RIS is unreachable, returned a server error, or served an HTML error page.',
      retryable: true,
      recovery:
        'RIS is temporarily unavailable — retry after a short delay. If it persists, reduce page_size or narrow the query.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'RIS did not answer the search within the request deadline.',
      retryable: true,
      recovery:
        'RIS did not answer in time — retry the same search shortly, or make it cheaper upstream: drop leading wildcards, reduce page_size, or narrow the date range.',
    },
  ],

  async handler(input, ctx) {
    const { scope } = input;
    const query = meaningful(input.query);
    const title = meaningful(input.title);
    const number = meaningful(input.number);
    const publishedFrom = meaningful(input.published_from);
    const publishedTo = meaningful(input.published_to);
    const issuer = meaningful(input.issuer);
    const districtAuthority = meaningful(input.district_authority);
    const municipality = meaningful(input.municipality);
    const { series } = input;
    const stateEra = input.state_era;
    const isState = isStateScope(scope);

    const fail = (message: string) =>
      ctx.fail('scope_filter_mismatch', message, { ...ctx.recoveryFor('scope_filter_mismatch') });

    if (input.part !== undefined && scope !== 'federal') {
      throw fail(`part applies only to scope: federal — got scope: '${scope}'.`);
    }
    if (series !== undefined && !isState) {
      throw fail(`series applies only to a state scope (a Bundesland) — got scope: '${scope}'.`);
    }
    if (stateEra !== undefined && !isState) {
      throw fail(`state_era applies only to a state scope (a Bundesland) — got scope: '${scope}'.`);
    }
    if (districtAuthority !== undefined && scope !== 'district') {
      throw fail(`district_authority applies only to scope: district — got scope: '${scope}'.`);
    }
    if (municipality !== undefined && scope !== 'municipal') {
      throw fail(`municipality applies only to scope: municipal — got scope: '${scope}'.`);
    }
    if (
      issuer !== undefined &&
      !(scope === 'federal' || (isState && series === 'ordinance_gazette'))
    ) {
      throw fail(
        `issuer applies only to federal or ordinance gazettes — got scope: '${scope}'${isState ? ' with law_gazette' : ''}.`,
      );
    }
    if (series === 'ordinance_gazette' && stateEra === 'legacy') {
      throw fail(
        "state_era: 'legacy' cannot be combined with series: 'ordinance_gazette' — the Verordnungsblätter have no legacy series; RIS carries the authentic Vbl only.",
      );
    }

    let application: GazetteApplication;
    let era: GazetteEra | undefined;
    if (scope === 'federal') {
      const tier = resolveFederalTier(number, publishedFrom, publishedTo, input.part);
      application = tier.application;
      era = tier.era;
    } else if (scope === 'district') {
      application = 'Bvb';
    } else if (scope === 'municipal') {
      application = 'GrA';
    } else if (series === 'ordinance_gazette') {
      application = 'Vbl';
    } else if (stateEra === 'legacy') {
      application = scope === 'niederoesterreich' ? 'LgblNO' : 'Lgbl';
    } else {
      application = 'LgblAuth';
    }

    // Vbl (Verordnungsblätter) resolves Tirol only upstream; a non-Tirol request would 500.
    // Short-circuit to a zero-hit notice instead of a retryable upstream_error.
    if (application === 'Vbl' && !VBL_COVERED.has(scope)) {
      ctx.enrich.total(0);
      ctx.enrich({
        page: input.page ?? 1,
        pageSize: input.page_size ?? 20,
        servedApplication: application,
      });
      ctx.enrich.notice(
        "0 gazette entries matched. Verordnungsblätter in RIS currently cover Tirol (2022+) — other states' ordinance gazettes are not yet published here.",
      );
      return { results: [] };
    }

    const stateForBuilder: RisStateCode | undefined =
      isStateScope(scope) && application !== 'LgblNO' ? scope : undefined;

    const params: GazetteSearchParams = {
      application,
      ...(query !== undefined && { query }),
      ...(title !== undefined && { title }),
      ...(number !== undefined && { number }),
      ...(input.part !== undefined && { part: input.part }),
      ...(input.type !== undefined && { type: input.type }),
      ...(publishedFrom !== undefined && { publishedFrom }),
      ...(publishedTo !== undefined && { publishedTo }),
      ...(issuer !== undefined && { issuer }),
      ...(stateForBuilder !== undefined && { state: stateForBuilder }),
      ...(districtAuthority !== undefined && { districtAuthority }),
      ...(municipality !== undefined && { municipality }),
      ...(input.sort_by !== undefined && { sortBy: input.sort_by }),
      ...(input.sort_direction !== undefined && { sortDirection: input.sort_direction }),
      ...(input.page !== undefined && { page: input.page }),
      ...(input.page_size !== undefined && { pageSize: input.page_size }),
    };

    // Map request-builder and service failures onto this tool's declared contract so reason
    // + recovery reach the wire (neither carries them on its own).
    const result = await getRisService()
      .searchGazette(params, ctx)
      .catch((err: unknown) => {
        throw failSearchError(err, ctx);
      });
    ctx.log.info('Gazette search completed', {
      application,
      hits: result.hits.length,
      total: result.total,
    });

    ctx.enrich.total(result.total);
    ctx.enrich({ page: result.page, pageSize: result.pageSize, servedApplication: application });
    if (result.total > (result.page - 1) * result.pageSize + result.hits.length) {
      ctx.enrich({ truncated: true });
    }

    if (result.total === 0) {
      const fragments = ['0 gazette entries matched.'];
      if (number !== undefined) {
        fragments.push(
          "Verify part and year — a 'BGBl. II' number returns nothing when filtered to part1. For a single known number, ris_lookup_citation resolves it directly (and routes pre-2004 numbers to the right era tier).",
        );
      }
      if (number !== undefined && input.part !== undefined) {
        const romanInNumber = /\bI{1,3}\b/.exec(number)?.[0];
        const partRoman = PART_ROMAN[input.part];
        if (romanInNumber !== undefined && partRoman !== undefined && romanInNumber !== partRoman) {
          fragments.push(
            `number names part ${romanInNumber} but the part filter is ${partRoman} — drop one.`,
          );
        }
      }
      if (issuer !== undefined) {
        fragments.push(
          "issuer is a phrase field — try the ministry abbreviation with a trailing * ('BMK*').",
        );
      }
      if (scope === 'federal' && (era === 'postwar' || era === 'imperial')) {
        const tier = era === 'postwar' ? 'BgblPdf 1945–2003' : 'BgblAlt 1848–1940';
        fragments.push(
          `Range served by ${tier}; pre-1848 gazettes are not in RIS. BgblAlt is metadata-only — scans are ÖNB-hosted.`,
        );
      }
      if (scope === 'district') {
        fragments.push(
          'District promulgations cover NÖ (2021+), OÖ/Tirol (2022+), Vorarlberg (2022-07+), Burgenland (2023+), Steiermark (2013+); Salzburg districts publish in the Salzburg LGBl. Windows: ris_list_reference topic applications.',
        );
      }
      if (isState && series === 'ordinance_gazette') {
        fragments.push(
          "Verordnungsblätter in RIS currently cover Tirol (2022+) — other states' ordinance gazettes are not yet published here.",
        );
      }
      ctx.enrich.notice(fragments.join(' '));
    }

    return { results: result.hits.map((hit) => toRecord(hit, application)) };
  },

  // format() populates content[] — the markdown twin of structuredContent. Every output
  // field renders here; totals, paging, and the served application ride the enrichment trailer.
  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: '_No gazette entries on this page._' }];
    }
    const blocks = result.results.map((r) => {
      const lines = [`## ${r.title ?? r.short_title ?? r.gazette_number ?? r.document_number}`];
      lines.push(`**Document:** ${r.document_number}`);
      const facts: string[] = [];
      if (r.gazette_number !== undefined) facts.push(`**Number:** ${r.gazette_number}`);
      if (r.part !== undefined) facts.push(`**Part:** ${r.part}`);
      if (r.type !== undefined) facts.push(`**Type:** ${r.type}`);
      if (r.published !== undefined) facts.push(`**Published:** ${r.published}`);
      if (facts.length > 0) lines.push(facts.join(' | '));
      const origin: string[] = [];
      if (r.issuer !== undefined) origin.push(`**Issuer:** ${r.issuer}`);
      if (r.district_authority !== undefined) {
        origin.push(`**District authority:** ${r.district_authority}`);
      }
      if (r.municipality !== undefined) origin.push(`**Municipality:** ${r.municipality}`);
      if (origin.length > 0) lines.push(origin.join(' | '));
      if (r.short_title !== undefined) lines.push(`**Short title:** ${r.short_title}`);
      lines.push(`**Binding:** ${r.binding}`);
      if (r.eli !== undefined) lines.push(`**ELI:** ${r.eli}`);
      if (r.authentic_pdf_url !== undefined)
        lines.push(`**Authentic PDF:** ${r.authentic_pdf_url}`);
      if (r.alex_url !== undefined) lines.push(`**ÖNB scan:** ${r.alex_url}`);
      const urls = (['html', 'pdf', 'rtf', 'xml'] as const)
        .filter((key) => r.content_urls[key] !== undefined)
        .map((key) => `[${key.toUpperCase()}](${r.content_urls[key]})`);
      if (urls.length > 0) lines.push(`**Text:** ${urls.join(' · ')}`);
      if (r.document_url !== undefined) lines.push(`**RIS view:** ${r.document_url}`);
      return lines.join('\n');
    });
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
