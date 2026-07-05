/**
 * @fileoverview ris_list_reference — static, offline reference for the opaque German codes
 * across the RIS surface. No service dependency, no upstream calls: every topic renders
 * from the typed tables in `src/services/ris/reference/`. The other ris_* tools' recovery
 * hints and zero-hit notices route here.
 * @module mcp-server/tools/definitions/ris-list-reference
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  COURTS_WITHOUT_DECISION_KIND,
  RIS_APPLICATIONS,
  RIS_CHANGED_SINCE_INTERVALS,
  RIS_CITATION_FORMATS,
  RIS_COLLECTIONS,
  RIS_COURTS,
  RIS_DECISION_KINDS,
  RIS_DECISION_TYPES,
  RIS_DISTRICT_AUTHORITIES,
  RIS_FEDERAL_GAZETTE_TIERS,
  RIS_GAZETTE_PARTS,
  RIS_ISSUING_BODIES,
  RIS_JUSTIZ_SUBJECT_AREAS,
  RIS_LAW_TYPES,
  RIS_MINISTRIES,
  RIS_SEARCH_SYNTAX,
  RIS_SECTION_TYPES,
  RIS_STAGES,
  RIS_STATES,
} from '@/services/ris/reference/index.js';

const TOPICS = [
  'applications',
  'courts',
  'states',
  'decision_types',
  'decision_kinds',
  'issuing_bodies',
  'ministries',
  'collections',
  'stages',
  'changed_since_intervals',
  'section_types',
  'gazette_parts',
  'law_types',
  'district_authorities',
  'justiz_subject_areas',
  'search_syntax',
  'citation_formats',
] as const;

type Topic = (typeof TOPICS)[number];

interface ReferenceEntry {
  details: { key: string; value: string }[];
  label: string;
  value: string;
}

interface TopicPayload {
  entries: ReferenceEntry[];
  notes: string[];
  summary: string;
}

/** Build a details array, dropping pairs whose value is null/undefined. */
function kv(...pairs: [string, string | null | undefined][]): { key: string; value: string }[] {
  return pairs.flatMap(([key, value]) => (value == null ? [] : [{ key, value }]));
}

const TOPIC_BUILDERS: Record<Topic, () => TopicPayload> = {
  applications: () => ({
    summary:
      'All 39 RIS OGD applications with controller, document class, binding status, coverage window, content-format availability, and the History feed name. ris_track_changes takes the application code; the search tools route to applications via scope, court, stage, and collection.',
    entries: RIS_APPLICATIONS.map((a) => ({
      value: a.code,
      label: a.name,
      details: kv(
        ['German name', a.germanName],
        ['Controller', a.controller],
        ['Document class', a.documentClass],
        ['Binding', a.binding],
        ['Coverage', a.coverage],
        ['Formats', a.formats],
        ['History feed name', a.historyName === a.code ? null : a.historyName],
        ['Note', a.note],
      ),
    })),
    notes: [
      'Binding labels: only "authentic" (amtssignierte) publications are legally binding; consolidated and historical texts are informational.',
      'Formats: full = Xml/Html/Rtf (plus Pdf and the signed Authentisch PDF where published); authentic_pdf_only = signed PDF, no text renditions; pdf_only = plain PDF; none = metadata only.',
      'The History change feed uses the application code, except the four aliases shown under "History feed name" (BrKons → Bundesnormen, LrKons → Landesnormen, Gr → Gemeinderecht, GrA → GemeinderechtAuth).',
    ],
  }),
  courts: () => ({
    summary:
      'The 17 court codes for ris_search_case_law: what each body is, its coverage window, active-vs-historical status with successor, and a real Geschäftszahl showing the case-number format ris_lookup_citation pattern-matches.',
    entries: RIS_COURTS.map((c) => ({
      value: c.code,
      label: c.name,
      details: kv(
        ['Application', c.application],
        ['German name', c.germanName],
        ['Status', c.status],
        ['Coverage', c.window],
        ['Successor', c.successor],
        ['Geschäftszahl example', c.gzExample],
        ['Note', c.note],
      ),
    })),
    notes: [
      'One court per call — cross-court research is one call per court.',
      'Historical bodies are closed windows: search the successor for current decisions.',
      'Decision-kind values per court: topic decision_kinds. Issuing bodies for dsk/dok/pvak/verg: topic issuing_bodies.',
    ],
  }),
  states: () => ({
    summary:
      'The nine Bundesländer and their RIS request spellings. RIS uses three shapes: Bundesland.SucheIn<Land> boolean flags (consolidated state law and state gazettes), a flat ASCII enum without umlauts (municipal law, state administrative courts, ordinance gazettes, health-plan regions), and a flat umlauted enum (district promulgations only).',
    entries: RIS_STATES.map((s) => ({
      value: s.code,
      label: s.name,
      details: kv(
        ['SucheIn flag', s.flagParam],
        ['Flat enum (most applications)', s.flatAscii],
        ['Flat enum (Bvb districts)', s.flatUmlaut],
        ['In historical Lgbl gazette', s.inLgbl ? 'yes' : 'no'],
      ),
    })),
    notes: [
      'Sending the wrong spelling fails schema validation — "Kaernten" errors on Bvb, "Kärnten" errors everywhere else.',
      'The historical non-authentic Lgbl gazette has no Niederösterreich and no Wien; Niederösterreich uses the LgblNO systematic collection instead.',
      'Vbl (ordinance gazettes) accepts every ASCII state value in its schema, but only Tirol resolves — other states fail on the RIS backend.',
    ],
  }),
  decision_types: () => ({
    summary:
      'Values for the decision_type parameter of ris_search_case_law — whether to search headnotes (Rechtssätze), full decision texts (Entscheidungstexte), or both.',
    entries: RIS_DECISION_TYPES.map((t) => ({
      value: t.code,
      label: `${t.germanName}`,
      details: kv(['Upstream', t.upstream], ['Description', t.description]),
    })),
    notes: [
      'A single decision can appear as several headnote documents plus one text document sharing the same Geschäftszahl — deduplicate by case number when needed.',
    ],
  }),
  decision_kinds: () => ({
    summary:
      'Per-court Entscheidungsart values for the decision_kind parameter of ris_search_case_law. Most courts validate against a schema enum; justiz matches an exact string.',
    entries: RIS_DECISION_KINDS.map((k) => ({
      value: k.court,
      label: k.paramKind === 'schema_enum' ? 'Schema enum' : 'Exact-match string',
      details: kv(['Values', k.values.join(' | ')], ['Note', k.note]),
    })),
    notes: [
      `No Entscheidungsart parameter exists for: ${COURTS_WITHOUT_DECISION_KIND.join(', ')}.`,
      'Values are passed verbatim as shown — they are German compound codes, not free text.',
    ],
  }),
  issuing_bodies: () => ({
    summary:
      'Issuing-body values for the issuing_body parameter (courts dsk, dok, pvak, verg) and the social-insurance issuer parameter of ris_search_announcements (collection social_insurance, upstream Urheber).',
    entries: RIS_ISSUING_BODIES.map((b) => ({
      value: b.value,
      label: `${b.application} ${b.parameter}`,
      details: kv(['Note', b.note]),
    })),
    notes: [
      'Dsk and Pvak values are schema enums in ASCII spelling; Dok and Avsv values are exact-match strings — pass them completely, including any "(ÖGK)"-style suffix.',
      'Live check 2026-07-05: Urheber "Österreichische Gesundheitskasse (ÖGK)" matches 78 notices; the name without the suffix matches none.',
    ],
  }),
  ministries: () => ({
    summary:
      'Ministry designations, including historical ministries, for the ministry parameter of ris_search_drafts and the issuer parameter of ris_search_announcements (ministerial_decrees, council_minutes). Three upstream formats exist — see the notes.',
    entries: RIS_MINISTRIES.map((m) => ({
      value: m.abbreviation ?? m.designation,
      label: m.designation,
      details: kv(['Accepted by', m.acceptedBy.join(', ')], ['Mrp exact value', m.mrpComposite]),
    })),
    notes: [
      'einbringende_stelle = EinbringendeStelle on BgblAuth/Begut/RegV — a phrase field, so the bare abbreviation matches ("BMF" → 536 review drafts, live check 2026-07-05).',
      'mrp_einbringer = Einbringer on Mrp — exact match; pass the full "ABBR (Name)" composite shown under "Mrp exact value".',
      'erlaesse_bundesministerium = Bundesministerium on Erlaesse — exact match against the full designation without any abbreviation prefix.',
      'The historical designation at submission time counts — a 2015 draft carries the 2015 ministry name, not today’s successor.',
    ],
  }),
  collections: () => ({
    summary:
      'The seven collections of ris_search_announcements, each mapping to one RIS application with its own parameter set. Five are legally binding authentic publications.',
    entries: RIS_COLLECTIONS.map((c) => ({
      value: c.code,
      label: c.name,
      details: kv(
        ['Application', c.application],
        ['German name', c.germanName],
        ['Authentic', c.authentic ? 'yes' : 'no'],
        ['Coverage', c.coverage],
        ['Supported parameters', c.params.join(', ')],
      ),
    })),
    notes: [
      'Parameters outside a collection’s supported set are rejected locally before any upstream call.',
      'changed_since, sort_by, sort_direction, page, and page_size apply to every collection.',
    ],
  }),
  stages: () => ({
    summary:
      'The two lawmaking-pipeline stages of ris_search_drafts: ministerial drafts in public review, and government bills adopted by the council of ministers.',
    entries: RIS_STAGES.map((s) => ({
      value: s.code,
      label: s.name,
      details: kv(
        ['Application', s.application],
        ['German name', s.germanName],
        ['Description', s.description],
        ['Stage-specific parameters', s.stageParams.join(', ')],
        ['Coverage', s.coverage],
      ),
    })),
    notes: [
      'in_review_on applies only to review_drafts; decided_from/decided_to only to government_bills.',
    ],
  }),
  changed_since_intervals: () => ({
    summary:
      'Values for the changed_since parameter across the search tools — coarse recency filtering over when a document last changed in RIS.',
    entries: RIS_CHANGED_SINCE_INTERVALS.map((i) => ({
      value: i.code,
      label: i.english,
      details: kv(['RIS value', i.risValue]),
    })),
    notes: [
      'Maps to the upstream ImRisSeit parameter; gazette-law applications use Kundmachung.Periode with the same value set.',
      'For exact-dated change windows and deletions, use ris_track_changes instead.',
    ],
  }),
  section_types: () => ({
    summary:
      'Values for the section_type parameter of ris_search_legislation — which kind of section a section_from/section_to range addresses.',
    entries: RIS_SECTION_TYPES.map((t) => ({
      value: t.value,
      label: t.english,
      details: kv(['Note', t.note]),
    })),
    notes: ['Maps to the upstream Abschnitt.Typ parameter alongside Abschnitt.Von/Bis.'],
  }),
  gazette_parts: () => ({
    summary:
      'Federal gazette parts for the part parameter of ris_search_gazette, plus the three federal era tiers the tool auto-routes across by year.',
    entries: [
      ...RIS_GAZETTE_PARTS.map((p) => ({
        value: p.code,
        label: p.germanName,
        details: kv(['Contents', p.contents], ['Upstream', p.upstream]),
      })),
      ...RIS_FEDERAL_GAZETTE_TIERS.map((t) => ({
        value: t.application,
        label: `Era tier ${t.window}`,
        details: kv(
          ['Authentic', t.authentic ? 'yes' : 'no'],
          ['Number lookup', t.numberParams],
          ['Note', t.note],
        ),
      })),
    ],
    notes: [
      'Parts I/II/III exist only from 1997 — earlier issues are partless (pre_1997, BgblPdf only).',
      'A "BGBl. II" number filtered to part1 returns nothing — verify part and year together.',
    ],
  }),
  law_types: () => ({
    summary:
      'Principal norm-type codes carried in consolidated-law records and accepted by the type filter (upstream Typ, a full-text field — not a closed enum).',
    entries: RIS_LAW_TYPES.map((t) => ({
      value: t.code,
      label: t.english,
      details: kv(['German name', t.germanName], ['Note', t.note]),
    })),
    notes: [
      'Live-confirmed against the corpus 2026-07-05; further variants exist (treaties carry per-party suffixes).',
    ],
  }),
  district_authorities: () => ({
    summary:
      'All district administrative authorities accepted by the district_authority parameter of ris_search_gazette (scope district). Exact-match values — pass the name verbatim.',
    entries: RIS_DISTRICT_AUTHORITIES.map((d) => ({
      value: d.name,
      label: `${d.kind === 'statutory_city' ? 'Statutory city' : 'District commission'} — ${d.state}`,
      details: [],
    })),
    notes: [
      'Harvested from the complete live Bvb corpus (2,433 documents, 2026-07-05) — the values documents actually carry.',
      'District promulgations cover Niederösterreich (2021-09+), Oberösterreich and Tirol (2022+), Vorarlberg (2022-07+), Burgenland (2023+), and Steiermark (2013+); Salzburg districts publish in the Salzburg LGBl.',
      'The Bvb Bundesland filter uses umlauted spellings ("Kärnten") — see topic states.',
    ],
  }),
  justiz_subject_areas: () => ({
    summary:
      'The documented Fachgebiet taxonomy for the subject_area parameter of ris_search_case_law (court justiz).',
    entries: RIS_JUSTIZ_SUBJECT_AREAS.map((a) => ({
      value: a.value,
      label: a.english,
      details: [],
    })),
    notes: [
      'The filter is documented in API v2.6 but the corpus carries no tagged documents yet — every probed value returned 0 hits on 2026-07-05. Until RIS populates the tags, filter with query or norm instead.',
    ],
  }),
  search_syntax: () => ({
    summary:
      'The RIS search grammar: boolean operators, wildcard rules per field type, phrase quoting, and which parameters are full-text, phrase, or exact-match fields.',
    entries: RIS_SEARCH_SYNTAX.map((r) => ({
      value: r.element,
      label: r.appliesTo,
      details: kv(['Description', r.description], ['Example', r.example]),
    })),
    notes: [
      'Unknown parameter names are silently ignored upstream — a typo returns plausible but unfiltered results, never an error. Invalid values of known enum parameters do error.',
    ],
  }),
  citation_formats: () => ({
    summary:
      'The citation shapes ris_lookup_citation parses — norm cites, gazette numbers across all era tiers, case numbers, and official collection numbers — with the deterministic route each resolves through.',
    entries: RIS_CITATION_FORMATS.map((f) => ({
      value: f.kind,
      label: f.description,
      details: kv(['Examples', f.examples.join(' · ')], ['Resolves via', f.resolvesVia]),
    })),
    notes: [
      'Per-court Geschäftszahl format examples: topic courts.',
      'Unresolvable citations return found: false with guidance — never an error.',
    ],
  }),
};

/** Escape a string for use inside a markdown table cell. */
function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export const risListReference = tool('ris_list_reference', {
  title: 'RIS Reference Lists',
  description:
    'Ground the opaque German codes across the RIS surface — static and offline, no upstream call. Topics: applications (all 39, with coverage windows, binding status, and content formats), courts (17 codes with Geschäftszahl examples and successor mapping), states (the three Bundesland request spellings), decision_types, decision_kinds (per-court Entscheidungsart values), issuing_bodies (dsk/dok/pvak/verg bodies and social-insurance issuers), ministries (abbreviations and full designations, historical included), collections (the 7 announcement collections and their parameter matrix), stages (lawmaking pipeline), changed_since_intervals, section_types, gazette_parts (BGBl parts and era tiers), law_types, district_authorities (all Bezirksverwaltungsbehörden), justiz_subject_areas (Fachgebiet taxonomy), search_syntax (operators and wildcard rules), and citation_formats (the shapes ris_lookup_citation parses). Recovery hints from the other ris_* tools route here.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    topic: z
      .enum(TOPICS)
      .describe(
        'Which reference table to return. Pick the topic named in the error recovery hint or zero-hit notice that sent you here.',
      ),
  }),
  output: z.object({
    topic: z.string().describe('The requested topic, echoed back.'),
    summary: z
      .string()
      .describe('What this topic covers and which tool parameters consume its values.'),
    entries: z
      .array(
        z
          .object({
            value: z
              .string()
              .describe(
                'The reference value — an enum value, application code, exact filter string, or syntax element, depending on the topic.',
              ),
            label: z.string().describe('Concise human-readable label or gloss for the value.'),
            details: z
              .array(
                z
                  .object({
                    key: z.string().describe('Attribute name.'),
                    value: z.string().describe('Attribute value.'),
                  })
                  .describe('One key–value attribute pair.'),
              )
              .describe(
                'Additional attributes as key–value pairs; keys vary by topic (coverage windows, upstream spellings, examples, notes).',
              ),
          })
          .describe('One reference entry: a value, its label, and its attributes.'),
      )
      .describe('Reference entries for the topic.'),
    notes: z
      .array(z.string())
      .describe('Topic-level caveats and usage guidance. Empty when none apply.'),
  }),

  handler(input) {
    const payload = TOPIC_BUILDERS[input.topic]();
    return { topic: input.topic, ...payload };
  },

  // format() populates content[] — the markdown twin of structuredContent. Both surfaces
  // must carry the same data: every entry, every detail pair, every note.
  format: (result) => {
    const lines: string[] = [`# ris_list_reference — ${result.topic}`, '', result.summary, ''];
    const detailKeys: string[] = [];
    for (const entry of result.entries) {
      for (const d of entry.details) {
        if (!detailKeys.includes(d.key)) detailKeys.push(d.key);
      }
    }
    lines.push(`| Value | Label |${detailKeys.map((k) => ` ${cell(k)} |`).join('')}`);
    lines.push(`|---|---|${detailKeys.map(() => '---|').join('')}`);
    for (const entry of result.entries) {
      const detailCells = detailKeys.map((k) => {
        const found = entry.details.find((d) => d.key === k);
        return ` ${found ? cell(found.value) : ''} |`;
      });
      lines.push(`| ${cell(entry.value)} | ${cell(entry.label)} |${detailCells.join('')}`);
    }
    if (result.notes.length > 0) {
      lines.push('', '**Notes:**');
      for (const note of result.notes) lines.push(`- ${note}`);
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
