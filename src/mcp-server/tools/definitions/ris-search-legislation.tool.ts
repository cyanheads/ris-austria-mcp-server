/**
 * @fileoverview ris_search_legislation — one search surface over Austrian consolidated
 * federal law (BrKons), consolidated state law (LrKons), municipal law (Gr), and English
 * translations of selected federal laws (Erv). `scope`, `municipality`, and `language`
 * route to the owning application; conditional filters are guarded locally before any
 * upstream call. The flagship behavior: `in_force_as_of` defaults to today (Austria) so
 * "what does the law say" questions never silently search all historical versions — the
 * applied date is echoed in enrichment.
 * @module mcp-server/tools/definitions/ris-search-legislation
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

import { RIS_CHANGED_SINCE_INTERVALS, RIS_STATES } from '@/services/ris/reference/index.js';
import type {
  ChangedSinceCode,
  LegislationApplication,
  LegislationSearchParams,
  RisStateCode,
} from '@/services/ris/request-builder.js';
import { getRisService } from '@/services/ris/ris-service.js';
import type { RisHit } from '@/services/ris/types.js';

import { failSearchError, isoDateString } from './_shared.js';

const STATE_CODES = RIS_STATES.map((s) => s.code) as [RisStateCode, ...RisStateCode[]];
const SCOPE_VALUES = ['federal', ...STATE_CODES] as ['federal', ...RisStateCode[]];
const CHANGED_SINCE_CODES = RIS_CHANGED_SINCE_INTERVALS.map((i) => i.code) as [
  ChangedSinceCode,
  ...ChangedSinceCode[],
];

/** Heuristic: the query/title looks like a legal citation (§ / gazette number / GZ shape). */
const CITATION_SHAPE =
  /§|\b(?:bgbl|lgbl|rgbl|stgbl|gbl[öo]|vfslg|vwslg)\b|\b\d{1,4}\/\d{2,4}\b|\b\d{4}-\d\.\d{3}\.\d{3}\b/iu;

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

const ContentUrlsSchema = z
  .object({
    xml: z.string().optional().describe('XML rendition URL (RIS Nutzdaten schema).'),
    html: z.string().optional().describe('HTML rendition URL.'),
    pdf: z.string().optional().describe('PDF rendition URL.'),
    rtf: z.string().optional().describe('RTF rendition URL.'),
  })
  .describe('Rendition URLs of the main document. Municipal and translation hits may be sparse.');

/**
 * Provenance of an English translation. Grouped rather than flattened: both fields belong
 * to the Erv arm alone, and `source`/`author` at the top level of a legislation record would
 * read as the record's own gazette source and author rather than the translation's.
 */
const TranslationSchema = z
  .object({
    source: z
      .string()
      .optional()
      .describe(
        'Which German version this translation renders, as RIS states it — the originating gazette, the last amendment applied, and the date of the version, one per line.',
      ),
    author: z
      .string()
      .optional()
      .describe('Body that produced the translation, e.g. "Federal Chancellery".'),
  })
  .describe(
    'Provenance of an unofficial English translation. Present only on Erv records (language: english), which carry no in_force_from, promulgation, or eli of their own — this is the only statement of which German version the text corresponds to, and how old it is.',
  );

export const LegislationRecordSchema = z
  .object({
    document_number: z
      .string()
      .describe(
        'Technical RIS document number (e.g. NOR40262691, GEMRE_WI_…, ERV_1999_1_165) — pass together with application to ris_get_document.',
      ),
    application: z
      .string()
      .describe(
        'RIS application the record belongs to: BrKons (federal), LrKons (state), Gr (municipal), or Erv (English translation).',
      ),
    title: z.string().optional().describe('Full document title, HTML markup stripped.'),
    short_title: z.string().optional().describe('Short title (Kurztitel), where assigned.'),
    abbreviation: z
      .string()
      .optional()
      .describe('Official abbreviation, where the record carries one.'),
    section_label: z
      .string()
      .optional()
      .describe('§ / Artikel / Anlage label of this document (ArtikelParagraphAnlage).'),
    law_id: z
      .string()
      .optional()
      .describe(
        'Law-level grouping key (Gesetzesnummer) — filter by law_id to fetch every section of the same law.',
      ),
    law_url: z
      .string()
      .optional()
      .describe('RIS web view of the whole law (GesamteRechtsvorschriftUrl) — for humans.'),
    in_force_from: z
      .string()
      .optional()
      .describe('Date this version entered force (Inkrafttretensdatum).'),
    in_force_until: z
      .string()
      .optional()
      .describe('Date this version left force (Ausserkrafttretensdatum). Absent while in force.'),
    promulgation: z
      .string()
      .optional()
      .describe('Promulgation reference (Kundmachungsorgan), e.g. "BGBl. I Nr. 165/1999".'),
    type: z
      .string()
      .optional()
      .describe('Norm type code (BG, V, K, …) — glossary: ris_list_reference topic law_types.'),
    indexes: z
      .array(z.string().describe('One Systematik index entry, e.g. "10/10 Datenschutz".'))
      .describe('Systematik classification entries (Index). Empty when unclassified.'),
    eli: z
      .string()
      .optional()
      .describe('European Legislation Identifier, where assigned (federal coverage is best).'),
    celex_references: z
      .array(z.string().describe('One CELEX number of a transposed EU act.'))
      .describe(
        'CELEX numbers parsed from the record — the EU-transposition hook for eur-lex chaining. Empty when none.',
      ),
    municipality: z
      .string()
      .optional()
      .describe('Municipality the norm belongs to (municipal law only).'),
    translation: TranslationSchema.optional(),
    content_urls: ContentUrlsSchema,
  })
  .describe('One consolidated-law document — one § / Artikel / Anlage — or one translation.');

export type LegislationRecord = z.infer<typeof LegislationRecordSchema>;

/** Pick the four core rendition URLs off a normalized hit. */
function pickContentUrls(hit: RisHit): LegislationRecord['content_urls'] {
  const { html, pdf, rtf, xml } = hit.contentUrls;
  return {
    ...(xml !== undefined && { xml }),
    ...(html !== undefined && { html }),
    ...(pdf !== undefined && { pdf }),
    ...(rtf !== undefined && { rtf }),
  };
}

/**
 * Translation provenance of an Erv hit, or `undefined` for the German corpus. Erv records
 * arrive under the Bundesrecht controller; no other application populates either field.
 */
function pickTranslation(md: RisHit['metadata']): LegislationRecord['translation'] {
  if (md.controller !== 'Bundesrecht') return;
  const translation = {
    ...(md.source !== undefined && { source: md.source }),
    ...(md.author !== undefined && { author: md.author }),
  };
  return Object.keys(translation).length > 0 ? translation : undefined;
}

/** Map a normalized RIS hit to the tool's record shape. */
export function toRecord(
  hit: RisHit,
  fallbackApplication: LegislationApplication,
): LegislationRecord {
  const base: LegislationRecord = {
    application: hit.application ?? fallbackApplication,
    celex_references: [],
    content_urls: pickContentUrls(hit),
    document_number: hit.documentNumber,
    indexes: [],
  };
  const md = hit.metadata;
  const translation = pickTranslation(md);
  if (md.controller === 'Bundesrecht' || md.controller === 'Landesrecht') {
    return {
      ...base,
      ...('abbreviation' in md && md.abbreviation !== undefined
        ? { abbreviation: md.abbreviation }
        : {}),
      celex_references: [...md.celexReferences],
      ...(md.eli !== undefined && { eli: md.eli }),
      ...(md.inForceFrom !== undefined && { in_force_from: md.inForceFrom }),
      ...(md.inForceUntil !== undefined && { in_force_until: md.inForceUntil }),
      indexes: [...md.indexes],
      ...(md.lawId !== undefined && { law_id: md.lawId }),
      ...(md.lawUrl !== undefined && { law_url: md.lawUrl }),
      ...(md.promulgation !== undefined && { promulgation: md.promulgation }),
      ...(md.sectionLabel !== undefined && { section_label: md.sectionLabel }),
      ...(md.shortTitle !== undefined && { short_title: md.shortTitle }),
      ...(md.title !== undefined && { title: md.title }),
      ...(translation !== undefined && { translation }),
      ...(md.normType !== undefined && { type: md.normType }),
    };
  }
  if (md.controller === 'Gemeinden') {
    return {
      ...base,
      ...(md.abbreviation !== undefined && { abbreviation: md.abbreviation }),
      ...(md.inForceFrom !== undefined && { in_force_from: md.inForceFrom }),
      indexes: [...md.indexes],
      ...(md.municipality !== undefined && { municipality: md.municipality }),
      ...(md.shortTitle !== undefined && { short_title: md.shortTitle }),
      ...(md.title !== undefined && { title: md.title }),
      ...(md.normType !== undefined && { type: md.normType }),
    };
  }
  return base;
}

export const risSearchLegislation = tool('ris_search_legislation', {
  title: 'Search Austrian Legislation',
  description:
    'Search Austrian consolidated law and English translations: federal law (scope: federal, the default), one Bundesland (scope: burgenland … wien), municipal law (municipality plus a state scope — selected norms in 6 Bundesländer), or English translations of selected federal laws (language: english, federal only, ~138 documents). One document is one § / Artikel / Anlage; fetch a whole law by filtering law_id. Searches apply the version in force today in Austria by default — set in_force_as_of for another date, include_all_versions: true for full version history, or an entered_force / left_force window for new-law and repeal tracking; the three version filters are mutually exclusive, and the applied date is echoed back in the result. query is full text (boolean UND/ODER/NICHT or AND/OR/NOT, trailing-only * wildcard); title matches title, short title, and abbreviation ("DSG"). For a specific citation like "§ 6 DSG", ris_lookup_citation resolves it deterministically instead. Consolidated text is informational, not legally binding — the authentic gazette artifact lives in ris_search_gazette.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .optional()
      .describe(
        'Full-text search (Suchworte). Boolean operators UND/ODER/NICHT or AND/OR/NOT, parentheses, quoted phrases; wildcard * is trailing-only ("Datenschutz*", never "*schutz"). Syntax: ris_list_reference topic search_syntax.',
      ),
    title: z
      .string()
      .optional()
      .describe(
        'Title search (Titel) — matches title, short title, and official abbreviation ("ABGB", "DSG"). Phrase field: * allowed leading or trailing with ≥2 characters beside it.',
      ),
    scope: z
      .enum(SCOPE_VALUES)
      .default('federal')
      .describe(
        'Jurisdiction: federal (default) searches consolidated federal law; a Bundesland searches that state’s consolidated law (or, with municipality set, its municipal law).',
      ),
    municipality: z
      .string()
      .optional()
      .describe(
        'Municipality name for municipal law (e.g. "Graz" — RIS’s spelling, not "Stadt Graz"). Requires a state scope; combines only with query, title, and in_force_as_of. Coverage is selected norms in 6 Bundesländer (no Burgenland/Tirol/Vorarlberg).',
      ),
    language: z
      .enum(['german', 'english'])
      .default('german')
      .describe(
        'german (default) searches the authoritative German corpus; english searches the ~138 unofficial English translations of selected federal laws (requires scope: federal; combines only with query and title).',
      ),
    in_force_as_of: isoDateString
      .optional()
      .describe(
        'Return only the version in force on this date (YYYY-MM-DD). DEFAULTS TO TODAY in Austria — omitting it never searches all historical versions; opt into that with include_all_versions.',
      ),
    include_all_versions: z
      .boolean()
      .optional()
      .describe(
        'true searches every historical version (no in-force date filter) — version-history research. Overrides in_force_as_of; mutually exclusive with the force-window filters.',
      ),
    entered_force_from: isoDateString
      .optional()
      .describe(
        'Provisions that entered force on/after this date (YYYY-MM-DD) — new-law tracking. Federal/state consolidated law only; mutually exclusive with in_force_as_of and include_all_versions.',
      ),
    entered_force_to: isoDateString
      .optional()
      .describe('Provisions that entered force on/before this date (YYYY-MM-DD).'),
    left_force_from: isoDateString
      .optional()
      .describe(
        'Provisions that left force on/after this date (YYYY-MM-DD) — repeal tracking. Same exclusivity as entered_force_from.',
      ),
    left_force_to: isoDateString
      .optional()
      .describe('Provisions that left force on/before this date (YYYY-MM-DD).'),
    section_from: z
      .string()
      .optional()
      .describe(
        'Start of a § / Artikel / Anlage number range, digits with optional letter ("6", "1a"). Federal/state consolidated law only.',
      ),
    section_to: z
      .string()
      .optional()
      .describe('End of the section range. Equal to section_from for a single section.'),
    section_type: z
      .enum(['Alle', 'Artikel', 'Paragraph', 'Anlage'])
      .optional()
      .describe(
        'Which section kind the range addresses. Defaults to Paragraph when a section range is set. Values: ris_list_reference topic section_types.',
      ),
    law_id: z
      .string()
      .optional()
      .describe(
        'Law-level grouping key (Gesetzesnummer, e.g. 10001597 = DSG) — exact match; returns every section of that law. Federal/state consolidated law only.',
      ),
    index: z
      .string()
      .optional()
      .describe(
        'Systematik classification filter (e.g. "10/10 Datenschutz"). Federal/state consolidated law only.',
      ),
    changed_since: z
      .enum(CHANGED_SINCE_CODES)
      .optional()
      .describe(
        'Coarse recency filter — documents changed in RIS within the interval. For exact windows and deletions use ris_track_changes.',
      ),
    sort_by: z
      .enum(['section', 'in_force_date'])
      .optional()
      .describe(
        'Sort column: section (§/Artikel/Anlage label) or in_force_date. Default: upstream order. Federal/state consolidated law only.',
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
      .array(LegislationRecordSchema)
      .describe('Matching documents for the requested page. Totals and paging in enrichment.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total matching documents across all pages.'),
    page: z.number().describe('1-based page number RIS served.'),
    pageSize: z.number().describe('Page size RIS applied.'),
    truncated: z
      .boolean()
      .optional()
      .describe('Present and true when more pages exist beyond this one — raise page to continue.'),
    appliedInForceAsOf: z
      .string()
      .optional()
      .describe(
        'The in-force date the server actually applied (defaulted to today in Austria when omitted). Absent when include_all_versions, a force-window, or language: english searched without a date filter.',
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
      when: 'A filter was combined with a scope, municipality, or language that does not support it, or mutually exclusive version filters were combined — rejected locally before any upstream call; the message names the offending pair.',
      recovery:
        'Drop the named filter or adjust scope: municipality needs a state scope and supports query/title/in_force_as_of; english supports query/title under scope: federal. Version filters are exclusive — pick in_force_as_of, include_all_versions, OR a force-window.',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'RIS rejected a parameter value in-band — the Client error message is passed through verbatim; it names the invalid element and its valid values. Unsupported filter combinations are caught earlier as scope_filter_mismatch.',
      recovery:
        'Correct the parameter named in the message. Ground valid codes with ris_list_reference (topic: states, section_types, changed_since_intervals, or search_syntax).',
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
    const query = meaningful(input.query);
    const title = meaningful(input.title);
    const municipality = meaningful(input.municipality);
    const explicitAsOf = meaningful(input.in_force_as_of);
    const enteredForceFrom = meaningful(input.entered_force_from);
    const enteredForceTo = meaningful(input.entered_force_to);
    const leftForceFrom = meaningful(input.left_force_from);
    const leftForceTo = meaningful(input.left_force_to);
    const sectionFrom = meaningful(input.section_from);
    const sectionTo = meaningful(input.section_to);
    const lawId = meaningful(input.law_id);
    const index = meaningful(input.index);
    const { language, scope } = input;
    const includeAllVersions = input.include_all_versions === true;

    const fail = (message: string) =>
      ctx.fail('scope_filter_mismatch', message, { ...ctx.recoveryFor('scope_filter_mismatch') });

    if (language === 'english' && scope !== 'federal') {
      throw fail(
        `language: 'english' is served by the federal Erv application — got scope: '${scope}'.`,
      );
    }
    if (municipality !== undefined && scope === 'federal') {
      throw fail(
        `municipality ("${municipality}") requires a state scope — got scope: 'federal'. Set scope to the municipality's Bundesland.`,
      );
    }

    const application: LegislationApplication =
      language === 'english'
        ? 'Erv'
        : municipality !== undefined
          ? 'Gr'
          : scope === 'federal'
            ? 'BrKons'
            : 'LrKons';

    const consolidatedOnly: readonly [name: string, value: unknown][] = [
      ['section_from', sectionFrom],
      ['section_to', sectionTo],
      ['section_type', input.section_type],
      ['law_id', lawId],
      ['index', index],
      ['entered_force_from', enteredForceFrom],
      ['entered_force_to', enteredForceTo],
      ['left_force_from', leftForceFrom],
      ['left_force_to', leftForceTo],
      ['sort_by', input.sort_by],
      ['sort_direction', input.sort_direction],
    ];
    if (application === 'Gr' || application === 'Erv') {
      const offending = consolidatedOnly.find(([, value]) => value !== undefined);
      if (offending) {
        throw fail(
          application === 'Gr'
            ? `${offending[0]} cannot be combined with municipality ("${municipality}") — municipal law supports query, title, and in_force_as_of only.`
            : `${offending[0]} cannot be combined with language: 'english' — English translations support query and title only.`,
        );
      }
      if (application === 'Erv' && explicitAsOf !== undefined) {
        throw fail(
          `in_force_as_of cannot be combined with language: 'english' — English translations carry no version dates and support query and title only.`,
        );
      }
    }

    const windowParam =
      enteredForceFrom !== undefined
        ? 'entered_force_from'
        : enteredForceTo !== undefined
          ? 'entered_force_to'
          : leftForceFrom !== undefined
            ? 'left_force_from'
            : leftForceTo !== undefined
              ? 'left_force_to'
              : undefined;
    if (windowParam !== undefined && (explicitAsOf !== undefined || includeAllVersions)) {
      throw fail(
        `${windowParam} cannot be combined with ${includeAllVersions ? 'include_all_versions' : 'in_force_as_of'} — version filters are exclusive: pick in_force_as_of, include_all_versions, OR a force-window.`,
      );
    }

    const appliedInForceAsOf =
      application === 'Erv' || includeAllVersions || windowParam !== undefined
        ? undefined
        : (explicitAsOf ?? todayInAustria());

    const params: LegislationSearchParams = {
      application,
      ...(query !== undefined && { query }),
      ...(title !== undefined && { title }),
      ...(scope !== 'federal' && { state: scope }),
      ...(municipality !== undefined && { municipality }),
      ...(appliedInForceAsOf !== undefined && { inForceAsOf: appliedInForceAsOf }),
      ...(enteredForceFrom !== undefined && { enteredForceFrom }),
      ...(enteredForceTo !== undefined && { enteredForceTo }),
      ...(leftForceFrom !== undefined && { leftForceFrom }),
      ...(leftForceTo !== undefined && { leftForceTo }),
      ...(sectionFrom !== undefined && { sectionFrom }),
      ...(sectionTo !== undefined && { sectionTo }),
      ...(input.section_type !== undefined && { sectionType: input.section_type }),
      ...(lawId !== undefined && { lawId }),
      ...(index !== undefined && { index }),
      ...(input.changed_since !== undefined && { changedSince: input.changed_since }),
      ...(input.sort_by !== undefined && { sortBy: input.sort_by }),
      ...(input.sort_direction !== undefined && { sortDirection: input.sort_direction }),
      ...(input.page !== undefined && { page: input.page }),
      ...(input.page_size !== undefined && { pageSize: input.page_size }),
    };

    // Map request-builder and service failures onto this tool's declared contract so reason
    // + recovery reach the wire (neither carries them on its own).
    const result = await getRisService()
      .searchLegislation(params, ctx)
      .catch((err: unknown) => {
        throw failSearchError(err, ctx);
      });
    ctx.log.info('Legislation search completed', {
      application,
      hits: result.hits.length,
      total: result.total,
    });

    ctx.enrich.total(result.total);
    ctx.enrich({ page: result.page, pageSize: result.pageSize });
    if (result.total > (result.page - 1) * result.pageSize + result.hits.length) {
      ctx.enrich({ truncated: true });
    }
    if (appliedInForceAsOf !== undefined) ctx.enrich({ appliedInForceAsOf });

    if (result.total === 0) {
      const fragments = ['0 documents matched.'];
      if (appliedInForceAsOf !== undefined) {
        fragments.push(
          `Only versions in force on ${appliedInForceAsOf} were searched — a repealed or not-yet-enacted provision returns nothing. Set include_all_versions: true to search all historical versions.`,
        );
      }
      if (query !== undefined) {
        fragments.push(
          "query wildcards are trailing-only ('Datenschutz*', never '*schutz'); boolean operators UND/ODER/NICHT or AND/OR/NOT. Syntax reference: ris_list_reference topic search_syntax.",
        );
      }
      if (title !== undefined) {
        fragments.push(
          "title matches title, short title, and abbreviation — try the official abbreviation ('DSG') with a trailing *.",
        );
      }
      if (municipality !== undefined) {
        fragments.push(
          "Municipal coverage is selected norms in 6 Bundesländer (no Burgenland/Tirol/Vorarlberg) — coverage: ris_list_reference topic applications. The municipality name must match RIS's spelling ('Graz', not 'Stadt Graz').",
        );
      }
      if (language === 'english') {
        fragments.push(
          'Erv holds ~138 selected translations only — absence means untranslated, not nonexistent. Search the German original instead (language: german).',
        );
      }
      if ([query, title].some((text) => text !== undefined && CITATION_SHAPE.test(text))) {
        fragments.push(
          'For a specific citation, ris_lookup_citation resolves it deterministically instead of keyword search.',
        );
      }
      ctx.enrich.notice(fragments.join(' '));
    }

    return { results: result.hits.map((hit) => toRecord(hit, application)) };
  },

  // format() populates content[] — the markdown twin of structuredContent. Every output
  // field renders here; totals, paging, and notices ride the enrichment trailer.
  format: (result) => {
    if (result.results.length === 0) {
      return [{ type: 'text', text: '_No documents on this page._' }];
    }
    const blocks = result.results.map((r) => {
      const lines = [`## ${r.title ?? r.short_title ?? r.document_number}`];
      lines.push(`**Document:** ${r.document_number} (${r.application})`);
      const identity: string[] = [];
      if (r.short_title !== undefined) identity.push(`**Short title:** ${r.short_title}`);
      if (r.abbreviation !== undefined) identity.push(`**Abbreviation:** ${r.abbreviation}`);
      if (r.section_label !== undefined) identity.push(`**Section:** ${r.section_label}`);
      if (r.type !== undefined) identity.push(`**Type:** ${r.type}`);
      if (identity.length > 0) lines.push(identity.join(' | '));
      if (r.law_id !== undefined || r.law_url !== undefined) {
        lines.push(
          `**Law:** ${[r.law_id !== undefined ? `id ${r.law_id}` : undefined, r.law_url].filter((part) => part !== undefined).join(' — ')}`,
        );
      }
      if (r.in_force_from !== undefined || r.in_force_until !== undefined) {
        lines.push(
          `**In force:** ${r.in_force_from ?? 'unknown'} → ${r.in_force_until ?? 'still in force'}`,
        );
      }
      if (r.promulgation !== undefined) lines.push(`**Promulgated:** ${r.promulgation}`);
      if (r.municipality !== undefined) lines.push(`**Municipality:** ${r.municipality}`);
      if (r.translation !== undefined) {
        if (r.translation.source !== undefined) {
          lines.push(`**Translation of:** ${r.translation.source}`);
        }
        if (r.translation.author !== undefined) {
          lines.push(`**Translated by:** ${r.translation.author}`);
        }
      }
      if (r.indexes.length > 0) lines.push(`**Index:** ${r.indexes.join('; ')}`);
      if (r.eli !== undefined) lines.push(`**ELI:** ${r.eli}`);
      if (r.celex_references.length > 0) {
        lines.push(`**CELEX:** ${r.celex_references.join(', ')}`);
      }
      const urls = (['html', 'pdf', 'rtf', 'xml'] as const)
        .filter((key) => r.content_urls[key] !== undefined)
        .map((key) => `[${key.toUpperCase()}](${r.content_urls[key]})`);
      if (urls.length > 0) lines.push(`**Text:** ${urls.join(' · ')}`);
      return lines.join('\n');
    });
    return [{ type: 'text', text: blocks.join('\n\n') }];
  },
});
