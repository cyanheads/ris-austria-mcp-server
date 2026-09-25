/**
 * @fileoverview Request-builder tests: every emitted param name comes from the confirmed
 * ledger, per-application conditionals throw locally instead of forwarding, and ministry
 * expansion resolves abbreviations per issuer-param family. Fully offline.
 * @module tests/services/ris/request-builder
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';

import {
  type IssuingBody,
  type Ministry,
  RIS_CHANGED_SINCE_INTERVALS,
  RIS_ISSUING_BODIES,
  RIS_MINISTRIES,
} from '@/services/ris/reference/index.js';
import {
  buildAnnouncementsRequest,
  buildCaseLawRequest,
  buildDraftsRequest,
  buildGazetteRequest,
  buildLegislationRequest,
  buildTrackChangesRequest,
  expandMinistry,
} from '@/services/ris/request-builder.js';

/** Capture the McpError a synchronous call throws. */
function captureThrow(fn: () => unknown): McpError {
  try {
    fn();
  } catch (error) {
    if (error instanceof McpError) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
}

function expectValidationError(fn: () => unknown, messagePart?: string): void {
  let caught: McpError | undefined;
  try {
    fn();
  } catch (error) {
    caught = error as McpError;
  }
  expect(caught).toBeInstanceOf(McpError);
  expect(caught!.code).toBe(JsonRpcErrorCode.ValidationError);
  if (messagePart !== undefined) expect(caught!.message).toContain(messagePart);
}

describe('buildLegislationRequest', () => {
  it('maps the full BrKons filter set to confirmed spellings', () => {
    const { controller, params } = buildLegislationRequest({
      application: 'BrKons',
      changedSince: 'one_month',
      inForceAsOf: '2026-07-05',
      index: '10/10 Datenschutz',
      lawId: '10001597',
      page: 2,
      pageSize: 100,
      query: 'Datenschutz*',
      sectionFrom: '1',
      sectionTo: '6',
      sortBy: 'section',
      sortDirection: 'ascending',
      title: 'DSG',
    });
    expect(controller).toBe('Bundesrecht');
    expect(params).toEqual({
      Applikation: 'BrKons',
      'Abschnitt.Bis': '6',
      'Abschnitt.Typ': 'Paragraph',
      'Abschnitt.Von': '1',
      DokumenteProSeite: 'OneHundred',
      FassungVom: '2026-07-05',
      Gesetzesnummer: '10001597',
      ImRisSeit: 'EinemMonat',
      Index: '10/10 Datenschutz',
      Seitennummer: '2',
      'Sortierung.SortDirection': 'Ascending',
      'Sortierung.SortedByColumn': 'ArtikelParagraphAnlage',
      Suchworte: 'Datenschutz*',
      Titel: 'DSG',
    });
  });

  it('maps force windows to the dotted Fassung params', () => {
    const { params } = buildLegislationRequest({
      application: 'LrKons',
      enteredForceFrom: '2026-01-01',
      enteredForceTo: '2026-06-30',
      state: 'wien',
    });
    expect(params['Fassung.VonInkrafttretensdatum']).toBe('2026-01-01');
    expect(params['Fassung.BisInkrafttretensdatum']).toBe('2026-06-30');
    expect(params['Bundesland.SucheInWien']).toBe('true');
  });

  it('routes municipal law to the Gemeinden controller with flat ASCII state', () => {
    const { controller, params } = buildLegislationRequest({
      application: 'Gr',
      municipality: 'Graz',
      state: 'kaernten',
    });
    expect(controller).toBe('Gemeinden');
    expect(params['Bundesland']).toBe('Kaernten');
    expect(params['Gemeinde']).toBe('Graz');
  });

  it('uses English param names for Erv', () => {
    const { params } = buildLegislationRequest({
      application: 'Erv',
      query: 'data protection',
      title: 'DSG',
    });
    expect(params['SearchTerms']).toBe('data protection');
    expect(params['Title']).toBe('DSG');
    expect(params['Suchworte']).toBeUndefined();
  });

  it('rejects params without a confirmed mapping instead of forwarding them', () => {
    expectValidationError(
      () => buildLegislationRequest({ application: 'Erv', inForceAsOf: '2026-07-05' }),
      'Erv',
    );
    expectValidationError(
      () => buildLegislationRequest({ application: 'Gr', lawId: '10001597' }),
      'lawId',
    );
    expectValidationError(() =>
      buildLegislationRequest({ application: 'BrKons', municipality: 'Graz' }),
    );
    expectValidationError(() => buildLegislationRequest({ application: 'Gr', sortBy: 'section' }));
  });
});

describe('buildCaseLawRequest', () => {
  it('maps the standard Judikatur filters', () => {
    const { controller, params } = buildCaseLawRequest({
      caseNumber: 'G 287/2022',
      court: 'vfgh',
      decidedFrom: '2020-01-01',
      decidedTo: '2026-01-01',
      decisionKind: 'Erkenntnis',
      decisionType: 'headnote',
      norm: 'DSG §1',
      query: 'Datenschutz',
      sortBy: 'decision_date',
    });
    expect(controller).toBe('Judikatur');
    expect(params['Applikation']).toBe('Vfgh');
    expect(params['Geschaeftszahl']).toBe('G 287/2022');
    expect(params['EntscheidungsdatumVon']).toBe('2020-01-01');
    expect(params['EntscheidungsdatumBis']).toBe('2026-01-01');
    expect(params['Dokumenttyp.SucheInRechtssaetzen']).toBe('true');
    expect(params['Dokumenttyp.SucheInEntscheidungstexten']).toBeUndefined();
    expect(params['Entscheidungsart']).toBe('Erkenntnis');
    expect(params['Sortierung.SortedByColumn']).toBe('Datum');
  });

  it('routes Upts through Sonstige with its own spellings', () => {
    const { controller, params } = buildCaseLawRequest({
      caseNumber: '2026-0.074.605/UPTS/Grüne',
      court: 'upts',
      decidedFrom: '2026-01-01',
      party: 'SPÖ',
      sortBy: 'decision_date',
    });
    expect(controller).toBe('Sonstige');
    expect(params['Applikation']).toBe('Upts');
    expect(params['GZ']).toBe('2026-0.074.605/UPTS/Grüne');
    expect(params['Entscheidungsdatum.Von']).toBe('2026-01-01');
    expect(params['Partei']).toBe('SPÖ');
    expect(params['Sortierung.SortedByColumn']).toBe('Entscheidungsdatum');
  });

  it('emits no Dokumenttyp flags for decision_type all', () => {
    const { params } = buildCaseLawRequest({ court: 'justiz', decisionType: 'all' });
    expect(params['Dokumenttyp.SucheInRechtssaetzen']).toBeUndefined();
    expect(params['Dokumenttyp.SucheInEntscheidungstexten']).toBeUndefined();
  });

  it('maps court-conditional filters with their flat confirmed spellings', () => {
    expect(buildCaseLawRequest({ court: 'lvwg', state: 'tirol' }).params['Bundesland']).toBe(
      'Tirol',
    );
    expect(
      buildCaseLawRequest({ court: 'justiz', legalArea: 'civil' }).params['Rechtsgebiet'],
    ).toBe('Zivilrecht');
    expect(buildCaseLawRequest({ court: 'justiz', courtName: 'OGH' }).params['Gericht']).toBe(
      'OGH',
    );
    const gbk = buildCaseLawRequest({
      commission: 'federal',
      court: 'gbk',
      discriminationGround: 'Geschlecht',
      senate: 'II',
    }).params;
    expect(gbk['Kommission']).toBe('BundesGleichbehandlungskommission');
    expect(gbk['Senat']).toBe('II');
    expect(gbk['Diskriminierungsgrund']).toBe('Geschlecht');
    expect(buildCaseLawRequest({ commission: 'general', court: 'gbk' }).params['Kommission']).toBe(
      'Gleichbehandlungskommission',
    );
    expect(buildCaseLawRequest({ court: 'bks', subjectLaw: 'ORF-Gesetz' }).params['Bereich']).toBe(
      'ORF-Gesetz',
    );
    expect(
      buildCaseLawRequest({ collectionNumber: '19632', court: 'vfgh' }).params['Sammlungsnummer'],
    ).toBe('19632');
    expect(
      buildCaseLawRequest({ court: 'dsk', issuingBody: 'Datenschutzbehoerde' }).params[
        'EntscheidendeBehoerde'
      ],
    ).toBe('Datenschutzbehoerde');
  });

  it('rejects court-conditional filters on the wrong court, locally', () => {
    expectValidationError(() =>
      buildCaseLawRequest({ court: 'vfgh', issuingBody: 'Datenschutzbehoerde' }),
    );
    expectValidationError(() =>
      buildCaseLawRequest({ court: 'justiz', collectionNumber: '19632' }),
    );
    expectValidationError(() => buildCaseLawRequest({ court: 'vfgh', party: 'SPÖ' }));
    expectValidationError(() => buildCaseLawRequest({ court: 'normenliste', caseNumber: 'x' }));
    expectValidationError(() =>
      buildCaseLawRequest({ court: 'normenliste', decidedFrom: '2020-01-01' }),
    );
    expectValidationError(() => buildCaseLawRequest({ court: 'gbk', decisionType: 'headnote' }));
    expectValidationError(() => buildCaseLawRequest({ court: 'dok', decisionKind: 'Beschluss' }));
  });

  it('validates decision kinds against the per-court table', () => {
    expectValidationError(
      () => buildCaseLawRequest({ court: 'vfgh', decisionKind: 'Bogus' }),
      'Erkenntnis',
    );
  });
});

describe('buildGazetteRequest', () => {
  it('maps BgblAuth filters including part and type flags', () => {
    const { controller, params } = buildGazetteRequest({
      application: 'BgblAuth',
      issuer: 'BMKOES',
      number: '171/2026',
      part: 'part2',
      publishedFrom: '2026-06-01',
      publishedTo: '2026-06-30',
      sortBy: 'published',
      type: 'laws',
    });
    expect(controller).toBe('Bundesrecht');
    expect(params['Bgblnummer']).toBe('171/2026');
    expect(params['Teil.SucheInTeil2']).toBe('true');
    expect(params['Typ.SucheInGesetzen']).toBe('true');
    expect(params['KundmachungsdatumVon']).toBe('2026-06-01');
    expect(params['KundmachungsdatumBis']).toBe('2026-06-30');
    expect(params['EinbringendeStelle']).toBe('BMKOES');
    expect(params['Sortierung.SortedByColumn']).toBe('Kundmachungsdatum');
  });

  it('maps the era-tier number and date spellings', () => {
    expect(
      buildGazetteRequest({ application: 'BgblPdf', number: '194/1961' }).params[
        'Bundesgesetzblatt'
      ],
    ).toBe('194/1961');
    expect(
      buildGazetteRequest({ application: 'BgblPdf', part: 'pre_1997' }).params['Teil.SucheInAlt'],
    ).toBe('true');
    // BgblAlt resolves via the full N/YYYY form in Gesetzblattnummer (live-confirmed);
    // Jahrgang is an independent volume-year filter.
    const alt = buildGazetteRequest({
      application: 'BgblAlt',
      number: '189/1902',
      year: '1902',
    }).params;
    expect(alt['Gesetzblattnummer']).toBe('189/1902');
    expect(alt['Jahrgang']).toBe('1902');
    expect(
      buildGazetteRequest({ application: 'BgblPdf', publishedFrom: '1975-01-01' }).params[
        'Kundgemacht.Von'
      ],
    ).toBe('1975-01-01');
    expect(
      buildGazetteRequest({ application: 'LgblAuth', publishedFrom: '2026-06-01' }).params[
        'Kundmachung.Von'
      ],
    ).toBe('2026-06-01');
    expect(
      buildGazetteRequest({ application: 'LgblNO', publishedTo: '2026-06-30' }).params[
        'Ausgabedatum.Bis'
      ],
    ).toBe('2026-06-30');
    expect(
      buildGazetteRequest({ application: 'Bvb', publishedFrom: '2026-06-01' }).params[
        'Kundmachungsdatum.Von'
      ],
    ).toBe('2026-06-01');
  });

  it('applies the three Bundesland spellings correctly', () => {
    expect(
      buildGazetteRequest({ application: 'LgblAuth', state: 'salzburg' }).params[
        'Bundesland.SucheInSalzburg'
      ],
    ).toBe('true');
    // Bvb is the one application requiring umlauted values.
    expect(
      buildGazetteRequest({ application: 'Bvb', state: 'kaernten' }).params['Bundesland'],
    ).toBe('Kärnten');
    expect(
      buildGazetteRequest({ application: 'GrA', state: 'kaernten' }).params['Bundesland'],
    ).toBe('Kaernten');
    expect(buildGazetteRequest({ application: 'Vbl', state: 'tirol' }).params['Bundesland']).toBe(
      'Tirol',
    );
  });

  it('guards Vbl to covered states and Lgbl to carried states, locally', () => {
    expectValidationError(
      () => buildGazetteRequest({ application: 'Vbl', state: 'kaernten' }),
      'Tirol',
    );
    expectValidationError(() => buildGazetteRequest({ application: 'Lgbl', state: 'wien' }));
    expectValidationError(
      () => buildGazetteRequest({ application: 'Lgbl', state: 'niederoesterreich' }),
      'LgblNO',
    );
  });

  it('maps district and municipal filters', () => {
    expect(
      buildGazetteRequest({
        application: 'Bvb',
        districtAuthority: 'Bezirkshauptmannschaft Liezen',
      }).params['Bezirksverwaltungsbehoerde'],
    ).toBe('Bezirkshauptmannschaft Liezen');
    expect(
      buildGazetteRequest({ application: 'GrA', municipality: 'Aurolzmünster' }).params['Gemeinde'],
    ).toBe('Aurolzmünster');
  });

  it('supports number sorting only where a column is confirmed', () => {
    expect(
      buildGazetteRequest({ application: 'BgblAlt', sortBy: 'number' }).params[
        'Sortierung.SortedByColumn'
      ],
    ).toBe('Fundstelle');
    expectValidationError(() => buildGazetteRequest({ application: 'BgblAuth', sortBy: 'number' }));
  });

  it('carries the rejected sort value and the mapped alternatives as separate data fields', () => {
    // The tool layer rewrites this rejection into the caller's vocabulary and needs both the
    // rejected value and the columns that DO exist as data — a `sortBy: number` composite
    // fused into `param` would have to be string-parsed apart to say either (#29).
    let caught: McpError | undefined;
    try {
      buildGazetteRequest({ application: 'BgblAuth', sortBy: 'number' });
    } catch (error) {
      caught = error as McpError;
    }
    expect(caught?.data).toMatchObject({
      alternatives: ['published'],
      application: 'BgblAuth',
      param: 'sortBy',
      value: 'number',
    });
  });

  it('rejects out-of-scope filters locally', () => {
    expectValidationError(() => buildGazetteRequest({ application: 'BgblAuth', year: '1902' }));
    expectValidationError(() => buildGazetteRequest({ application: 'LgblAuth', part: 'part1' }));
    expectValidationError(() => buildGazetteRequest({ application: 'BgblAuth', part: 'pre_1997' }));
    expectValidationError(() => buildGazetteRequest({ application: 'Vbl', type: 'laws' }));
    expectValidationError(() => buildGazetteRequest({ application: 'LgblNO', number: '61/2026' }));
    expectValidationError(() => buildGazetteRequest({ application: 'Lgbl', issuer: 'BMF' }));
  });
});

describe('buildDraftsRequest', () => {
  it('maps review drafts with ministry abbreviation pass-through', () => {
    const { params } = buildDraftsRequest({
      inReviewOn: '2026-07-05',
      ministry: 'bmf',
      sortBy: 'date',
      stage: 'review_drafts',
    });
    expect(params['Applikation']).toBe('Begut');
    expect(params['InBegutachtungAm']).toBe('2026-07-05');
    // Phrase-matched EinbringendeStelle takes the bare abbreviation.
    expect(params['EinbringendeStelle']).toBe('BMF');
    expect(params['Sortierung.SortedByColumn']).toBe('EndeBegutachtungsfrist');
  });

  it('maps government bills with the Beschlussdatum window', () => {
    const { params } = buildDraftsRequest({
      decidedFrom: '2026-01-01',
      decidedTo: '2026-12-31',
      sortBy: 'date',
      stage: 'government_bills',
    });
    expect(params['Applikation']).toBe('RegV');
    expect(params['BeschlussdatumVon']).toBe('2026-01-01');
    expect(params['BeschlussdatumBis']).toBe('2026-12-31');
    expect(params['Sortierung.SortedByColumn']).toBe('Beschlussdatum');
  });

  it('rejects stage-mismatched date filters locally', () => {
    expectValidationError(() =>
      buildDraftsRequest({ inReviewOn: '2026-07-05', stage: 'government_bills' }),
    );
    expectValidationError(() =>
      buildDraftsRequest({ decidedFrom: '2026-01-01', stage: 'review_drafts' }),
    );
  });
});

describe('buildAnnouncementsRequest', () => {
  it('maps per-collection number and date spellings', () => {
    const avsv = buildAnnouncementsRequest({
      collection: 'social_insurance',
      number: '40/2026',
      publishedFrom: '2026-01-01',
      sortBy: 'number',
    }).params;
    expect(avsv['Applikation']).toBe('Avsv');
    expect(avsv['Avsvnummer']).toBe('40/2026');
    expect(avsv['Kundmachung.Von']).toBe('2026-01-01');
    expect(avsv['Sortierung.SortedByColumn']).toBe('Avsvnummer');

    const kmger = buildAnnouncementsRequest({
      collection: 'court_rules',
      inForceAsOf: '2026-07-05',
      publishedFrom: '2026-01-01',
      type: 'Geschaeftsordnung',
    }).params;
    expect(kmger['Fassung.FassungVom']).toBe('2026-07-05');
    expect(kmger['Kundmachungsdatum.Von']).toBe('2026-01-01');
    expect(kmger['Typ']).toBe('Geschaeftsordnung');
  });

  it('maps Erlaesse with flat force params and exact-match ministry expansion', () => {
    const { params } = buildAnnouncementsRequest({
      caseNumber: '2026-0.560.359',
      collection: 'ministerial_decrees',
      department: 'Abteilung IV/5',
      enteredForceFrom: '2020-01-01',
      inForceAsOf: '2026-07-05',
      issuer: 'BMF',
      norm: 'DSG',
    });
    expect(params['Applikation']).toBe('Erlaesse');
    expect(params['FassungVom']).toBe('2026-07-05');
    expect(params['VonInkrafttretensdatum']).toBe('2020-01-01');
    expect(params['Bundesministerium']).toBe('Bundesministerium für Finanzen');
    expect(params['Norm']).toBe('DSG');
    expect(params['Geschaeftszahl']).toBe('2026-0.560.359');
    expect(params['Abteilung']).toBe('Abteilung IV/5');
  });

  it('maps Mrp with the composite issuer and session filters', () => {
    const { params } = buildAnnouncementsRequest({
      collection: 'council_minutes',
      issuer: 'BKA',
      legislature: 'XXVII',
      publishedFrom: '2026-06-01',
      sessionNumber: '59',
    });
    expect(params['Applikation']).toBe('Mrp');
    expect(params['Einbringer']).toBe('BKA (Bundeskanzleramt)');
    expect(params['Sitzungsdatum.Von']).toBe('2026-06-01');
    expect(params['Sitzungsnummer']).toBe('59');
    expect(params['Gesetzgebungsperiode']).toBe('XXVII');
  });

  it('maps Spg plan restrictions to the dotted SuchEinschraenkung complexes', () => {
    const regional = buildAnnouncementsRequest({
      collection: 'health_structure_plans',
      planKind: 'regulation',
      planScope: 'regional',
      planState: 'wien',
    }).params;
    expect(regional['RsgSuchEinschraenkung.SpgStrukturplanType']).toBe('Verordnungen');
    expect(regional['RsgSuchEinschraenkung.Land']).toBe('Wien');
    const federal = buildAnnouncementsRequest({
      collection: 'health_structure_plans',
      planScope: 'federal',
    }).params;
    expect(federal['OsgSuchEinschraenkung.SpgStrukturplanType']).toBe('Alle');
    expectValidationError(() =>
      buildAnnouncementsRequest({
        collection: 'health_structure_plans',
        planScope: 'federal',
        planState: 'wien',
      }),
    );
  });

  it('maps Avn type search flags and validates the token', () => {
    expect(
      buildAnnouncementsRequest({ collection: 'veterinary', type: 'Kundmachungen' }).params[
        'Typ.SucheInKundmachungen'
      ],
    ).toBe('true');
    expectValidationError(() =>
      buildAnnouncementsRequest({ collection: 'veterinary', type: 'Bogus' }),
    );
  });

  it('rejects out-of-matrix params locally', () => {
    expectValidationError(() =>
      buildAnnouncementsRequest({ collection: 'council_minutes', title: 'x' }),
    );
    expectValidationError(() =>
      buildAnnouncementsRequest({ collection: 'social_insurance', norm: 'DSG' }),
    );
    expectValidationError(() =>
      buildAnnouncementsRequest({ collection: 'ministerial_decrees', publishedFrom: '2026-01-01' }),
    );
    expectValidationError(() =>
      buildAnnouncementsRequest({ collection: 'court_rules', number: '1/2026' }),
    );
    expectValidationError(() =>
      buildAnnouncementsRequest({ collection: 'health_structure_plans', sortBy: 'published' }),
    );
  });

  describe('changed_since per collection (#37)', () => {
    const INTERVALS = RIS_CHANGED_SINCE_INTERVALS.map((i) => [i.code, i.risValue] as const);
    const HONORING = [
      ['court_rules', 'KmGer'],
      ['trade_exam_rules', 'PruefGewO'],
      ['health_structure_plans', 'Spg'],
      ['ministerial_decrees', 'Erlaesse'],
      ['council_minutes', 'Mrp'],
    ] as const;
    const IGNORING = [
      ['social_insurance', 'Avsv'],
      ['veterinary', 'Avn'],
    ] as const;

    it.each(
      HONORING.flatMap(([c, app]) =>
        INTERVALS.map(([code, token]) => [c, app, code, token] as const),
      ),
    )('%s (%s) emits ImRisSeit for %s → %s', (collection, application, code, token) => {
      const { params } = buildAnnouncementsRequest({ changedSince: code, collection });
      expect(params).toEqual({ Applikation: application, ImRisSeit: token });
    });

    it.each(IGNORING.flatMap(([c, app]) => INTERVALS.map(([code]) => [c, app, code] as const)))(
      '%s (%s) refuses changedSince %s — RIS accepts ImRisSeit there and ignores it',
      (collection, application, code) => {
        const err = captureThrow(() =>
          buildAnnouncementsRequest({ changedSince: code, collection, query: 'Satzung' }),
        );
        expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(err.data).toMatchObject({ application, param: 'changedSince' });
      },
    );

    it.each(IGNORING)('%s without changed_since builds the same request as before', (c, app) => {
      expect(
        buildAnnouncementsRequest({ collection: c, page: 2, pageSize: 10, query: 'Satzung' }),
      ).toEqual({
        controller: 'Sonstige',
        params: {
          Applikation: app,
          DokumenteProSeite: 'Ten',
          Seitennummer: '2',
          Suchworte: 'Satzung',
        },
      });
    });
  });

  describe('social-insurance issuer abbreviations (#38)', () => {
    const bodies: readonly IssuingBody[] = RIS_ISSUING_BODIES;
    const avsv = bodies.filter((body) => body.application === 'Avsv');
    /** Rows whose designation ends in a parenthesized abbreviation — derived from the value. */
    const SUFFIX = /\(([^()]+)\)$/u;
    const suffixed = avsv.flatMap((body) => {
      const match = SUFFIX.exec(body.value);
      return match === null ? [] : [{ body, suffix: match[1] as string }];
    });

    const urheber = (issuer: string) =>
      buildAnnouncementsRequest({ collection: 'social_insurance', issuer }).params['Urheber'];

    it('carries the abbreviation on exactly the 28 suffixed Avsv rows, equal to the suffix', () => {
      expect(suffixed).toHaveLength(28);
      for (const { body, suffix } of suffixed) expect(body.abbreviation).toBe(suffix);
      const carrying = bodies.filter((body) => body.abbreviation !== undefined);
      expect(new Set(carrying.map((b) => b.value))).toEqual(
        new Set(suffixed.map(({ body }) => body.value)),
      );
    });

    it('keeps abbreviations unique and distinct from every full value', () => {
      const lowered = suffixed.map(({ body }) => (body.abbreviation as string).toLowerCase());
      expect(lowered).toHaveLength(28);
      expect(new Set(lowered).size).toBe(lowered.length);
      const values = new Set(avsv.map((b) => b.value.toLowerCase()));
      for (const abbreviation of lowered) expect(values.has(abbreviation)).toBe(false);
    });

    it.each(suffixed.map(({ body, suffix }) => [suffix, body.value]))(
      'expands %s to %s, case-insensitively',
      (abbreviation, value) => {
        expect(urheber(abbreviation)).toBe(value);
        expect(urheber(abbreviation.toLowerCase())).toBe(value);
        expect(urheber(` ${abbreviation} `)).toBe(value);
      },
    );

    it('expands ÖGK to the carrier, never to its Gesamtvertrag series', () => {
      expect(urheber('ÖGK')).toBe('Österreichische Gesundheitskasse (ÖGK)');
      expect(urheber('ögk')).toBe('Österreichische Gesundheitskasse (ÖGK)');
      expect(urheber('ÖGK Gesamtvertrag')).toBe('ÖGK Gesamtvertrag');
    });

    it.each(avsv.map((body) => [body.value]))('passes the full value %s through unchanged', (v) => {
      expect(urheber(v)).toBe(v);
    });

    it('passes an unlisted issuer through unchanged instead of rejecting it', () => {
      expect(urheber('Unbekannter Versicherungsträger')).toBe('Unbekannter Versicherungsträger');
      expect(urheber('XYZ')).toBe('XYZ');
    });

    it('leaves ministry expansion on the other issuer collections untouched', () => {
      expect(
        buildAnnouncementsRequest({ collection: 'ministerial_decrees', issuer: 'BMF' }).params[
          'Bundesministerium'
        ],
      ).toBe('Bundesministerium für Finanzen');
      expect(
        buildAnnouncementsRequest({ collection: 'council_minutes', issuer: 'BKA' }).params[
          'Einbringer'
        ],
      ).toBe('BKA (Bundeskanzleramt)');
    });
  });

  it('reports an empty alternatives list for a collection with no sortable column', () => {
    // KmGer maps neither sort column, so the tool layer has no substitute to offer and must
    // say "drop sort_by" rather than name one (#29).
    let caught: McpError | undefined;
    try {
      buildAnnouncementsRequest({ collection: 'court_rules', sortBy: 'number' });
    } catch (error) {
      caught = error as McpError;
    }
    expect(caught?.data).toMatchObject({
      alternatives: [],
      application: 'KmGer',
      param: 'sortBy',
      value: 'number',
    });
  });
});

describe('buildTrackChangesRequest', () => {
  it('aliases the four History application names and maps the window', () => {
    const { controller, params } = buildTrackChangesRequest({
      application: 'BrKons',
      changedFrom: '2026-06-15',
      changedTo: '2026-06-17',
      includeDeleted: true,
      pageSize: 100,
    });
    expect(controller).toBe('History');
    expect(params).toEqual({
      AenderungenBis: '2026-06-17',
      AenderungenVon: '2026-06-15',
      Anwendung: 'Bundesnormen',
      DokumenteProSeite: 'OneHundred',
      IncludeDeletedDocuments: 'True',
    });
    expect(buildTrackChangesRequest({ application: 'GrA' }).params['Anwendung']).toBe(
      'GemeinderechtAuth',
    );
    expect(buildTrackChangesRequest({ application: 'Vfgh' }).params['Anwendung']).toBe('Vfgh');
  });

  it('omits IncludeDeletedDocuments unless requested and rejects unknown applications', () => {
    expect(
      buildTrackChangesRequest({ application: 'BrKons' }).params['IncludeDeletedDocuments'],
    ).toBeUndefined();
    expectValidationError(() => buildTrackChangesRequest({ application: 'Bundesnormen' }));
  });
});

describe('expandMinistry', () => {
  it('resolves abbreviations per issuer-param family', () => {
    expect(expandMinistry('BMF', 'einbringende_stelle')).toBe('BMF');
    expect(expandMinistry('bmf', 'erlaesse_bundesministerium')).toBe(
      'Bundesministerium für Finanzen',
    );
    expect(expandMinistry('bka', 'mrp_einbringer')).toBe('BKA (Bundeskanzleramt)');
    expect(expandMinistry('Bundesministerium für Finanzen', 'erlaesse_bundesministerium')).toBe(
      'Bundesministerium für Finanzen',
    );
    expect(expandMinistry('PARLAMENT', 'einbringende_stelle')).toBe('PARLAMENT');
  });

  it('reports ambiguity instead of guessing (BMEIA has two designations)', () => {
    expectValidationError(() => expandMinistry('BMEIA', 'erlaesse_bundesministerium'), 'ambiguous');
    // The phrase-matched family sends the bare abbreviation, so no ambiguity arises.
    expect(expandMinistry('BMEIA', 'einbringende_stelle')).toBe('BMEIA');
  });

  it('names near-misses on unknown input', () => {
    expectValidationError(() => expandMinistry('BMX', 'einbringende_stelle'), 'Unknown ministry');
  });

  it('resolves BMF and BKA exactly as before on every family (#44 regression)', () => {
    expect(expandMinistry('BMF', 'einbringende_stelle')).toBe('BMF');
    expect(expandMinistry('BMF', 'erlaesse_bundesministerium')).toBe(
      'Bundesministerium für Finanzen',
    );
    expect(expandMinistry('BMF', 'mrp_einbringer')).toBe('BMF (Bundesministerium für Finanzen)');
    expect(expandMinistry('BKA', 'einbringende_stelle')).toBe('BKA');
    expect(expandMinistry('BKA', 'erlaesse_bundesministerium')).toBe('Bundeskanzleramt');
    expect(expandMinistry('BKA', 'mrp_einbringer')).toBe('BKA (Bundeskanzleramt)');
  });
});

describe('expandMinistry — ministries in office since 2025 (#44)', () => {
  /**
   * Every Mrp `Einbringer` composite the live corpus carries for these ministries (full Mrp
   * sweep, 359 minutes, 2026-09-24), and the one Erlaesse `Bundesministerium` value among
   * them with decrees on file. Each composite was re-probed and returned its corpus count.
   */
  const NEW_MRP_COMPOSITES = [
    'BMWET (Bundesministerium für Wirtschaft, Energie und Tourismus)',
    'BMWKMS (Bundesministerium für Wohnen, Kunst, Kultur, Medien und Sport)',
    'BMASGPK (Bundesministerium für Arbeit, Soziales, Gesundheit, Pflege und Konsumentenschutz)',
    'BMFWF (Bundesministerium für Frauen, Wissenschaft und Forschung)',
    'BMIMI (Bundesministerium für Innovation, Mobilität und Infrastruktur)',
    'BMLUK (Bundesministerium für Land- und Forstwirtschaft, Klima- und Umweltschutz, Regionen und Wasserwirtschaft)',
    'BMEIF (Bundesministerin für Europa, Integration und Familie im Bundeskanzleramt)',
    'BMEIF (Bundesministerium für Europa, Integration und Familie)',
    'BMFFJI (Bundesministerin für Frauen, Familie, Jugend und Integration im Bundeskanzleramt)',
    'BMFI (Bundesministerin für Frauen und Integration)',
  ] as const;
  const COMPOSITE = /^(\S+) \((.+)\)$/u;
  const rows = NEW_MRP_COMPOSITES.map((composite) => {
    const [, abbreviation, designation] = COMPOSITE.exec(composite) as unknown as [
      string,
      string,
      string,
    ];
    return { abbreviation, composite, designation };
  });
  const single = rows.filter((row) => row.abbreviation !== 'BMEIF');
  const table: readonly Ministry[] = RIS_MINISTRIES;

  it('holds each composite as its own row, accepted by all three issuer families', () => {
    for (const { abbreviation, composite, designation } of rows) {
      const row = table.find((m) => m.mrpComposite === composite);
      expect(row, composite).toBeDefined();
      expect(row).toMatchObject({ abbreviation, designation });
      expect(new Set(row?.acceptedBy)).toEqual(
        new Set(['einbringende_stelle', 'erlaesse_bundesministerium', 'mrp_einbringer']),
      );
    }
  });

  it('keeps every Mrp composite and every abbreviation+designation pair unique', () => {
    const composites = table.flatMap((m) => (m.mrpComposite === null ? [] : [m.mrpComposite]));
    expect(new Set(composites).size).toBe(composites.length);
    const pairs = table.map((m) => `${m.abbreviation ?? ''}|${m.designation}`);
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it.each(single.map((row) => [row.abbreviation, row.designation, row.composite]))(
    '%s resolves by abbreviation and by designation on every family',
    (abbreviation, designation, composite) => {
      for (const input of [abbreviation, abbreviation.toLowerCase(), designation, composite]) {
        expect(expandMinistry(input, 'einbringende_stelle')).toBe(abbreviation);
        expect(expandMinistry(input, 'erlaesse_bundesministerium')).toBe(designation);
        expect(expandMinistry(input, 'mrp_einbringer')).toBe(composite);
      }
    },
  );

  it('handles BMEIF’s two designations the way BMEIA’s are handled', () => {
    expect(expandMinistry('BMEIF', 'einbringende_stelle')).toBe('BMEIF');
    for (const family of ['erlaesse_bundesministerium', 'mrp_einbringer'] as const) {
      const err = captureThrow(() => expandMinistry('BMEIF', family));
      expect(err.message).toContain('ambiguous');
    }
    for (const { composite, designation } of rows.filter((r) => r.abbreviation === 'BMEIF')) {
      expect(expandMinistry(designation, 'mrp_einbringer')).toBe(composite);
      expect(expandMinistry(composite, 'erlaesse_bundesministerium')).toBe(designation);
    }
  });

  it('passes an unknown full designation (contains whitespace) through unchanged', () => {
    const unknown = 'Bundesministerium für Zukunftsfragen und Raumfahrt';
    for (const family of [
      'einbringende_stelle',
      'erlaesse_bundesministerium',
      'mrp_einbringer',
    ] as const) {
      expect(expandMinistry(unknown, family)).toBe(unknown);
      expect(expandMinistry(`  ${unknown} `, family)).toBe(unknown);
    }
  });

  it('still rejects an unknown abbreviation-shaped token, tagged for its own recovery', () => {
    for (const family of [
      'einbringende_stelle',
      'erlaesse_bundesministerium',
      'mrp_einbringer',
    ] as const) {
      const err = captureThrow(() => expandMinistry('BMXX', family));
      expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(err.message).toContain('Unknown ministry "BMXX"');
      expect(err.data).toMatchObject({ input: 'BMXX', reason: 'unresolved_ministry' });
    }
  });

  it('tags the ambiguous rejection with the same reason', () => {
    const err = captureThrow(() => expandMinistry('BMEIA', 'mrp_einbringer'));
    expect(err.data).toMatchObject({ reason: 'unresolved_ministry' });
  });
});

describe('expandMinistry — a known ministry its family does not accept (#45)', () => {
  const table: readonly Ministry[] = RIS_MINISTRIES;

  it.each([
    ['BMEUV', 'erlaesse_bundesministerium', 'Erlaesse Bundesministerium'],
    ['BMFFIM', 'erlaesse_bundesministerium', 'Erlaesse Bundesministerium'],
    ['bmeuv', 'erlaesse_bundesministerium', 'Erlaesse Bundesministerium'],
    ['PARLAMENT', 'mrp_einbringer', 'Mrp Einbringer'],
    ['PARLAMENT', 'erlaesse_bundesministerium', 'Erlaesse Bundesministerium'],
  ] as const)('rejects %s on %s as not accepted, naming %s', (input, family, parameter) => {
    const err = captureThrow(() => expandMinistry(input, family));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.message).toContain(`Ministry "${input}" is not accepted by this issuer parameter`);
    expect(err.message).toContain(parameter);
    // The input is a ministry the table knows — never reported as unknown, never offered
    // back to the caller as its own near-miss.
    expect(err.message).not.toContain('Unknown ministry');
    expect(err.message).not.toContain('closest matches');
    expect(err.data).toMatchObject({ family, input, reason: 'unresolved_ministry' });
  });

  it('names the parameters that do accept the ministry', () => {
    const err = captureThrow(() => expandMinistry('BMEUV', 'erlaesse_bundesministerium'));
    expect(err.message).toContain('EinbringendeStelle');
    expect(err.message).toContain('Mrp Einbringer');
    expect(err.data).toMatchObject({ acceptedBy: ['einbringende_stelle', 'mrp_einbringer'] });
  });

  it('rejects a known full designation its family does not accept, although it contains whitespace', () => {
    for (const [input, family] of [
      ['Bundesministerin für EU und Verfassung im Bundeskanzleramt', 'erlaesse_bundesministerium'],
      ['Bundesministerium für soziale Verwaltung', 'einbringende_stelle'],
      ['Bundesministerium für soziale Verwaltung', 'mrp_einbringer'],
    ] as const) {
      const err = captureThrow(() => expandMinistry(input, family));
      expect(err.message).toContain('is not accepted by this issuer parameter');
      expect(err.data).toMatchObject({ reason: 'unresolved_ministry' });
    }
  });

  it('still resolves BMEUV and BMFFIM on the families that accept them', () => {
    expect(expandMinistry('BMEUV', 'einbringende_stelle')).toBe('BMEUV');
    expect(expandMinistry('BMEUV', 'mrp_einbringer')).toBe(
      'BMEUV (Bundesministerin für EU und Verfassung im Bundeskanzleramt)',
    );
    expect(expandMinistry('BMFFIM', 'einbringende_stelle')).toBe('BMFFIM');
    expect(expandMinistry('BMFFIM', 'mrp_einbringer')).toBe(
      'BMFFIM (Bundesministerin für Frauen, Familie, Integration und Medien im Bundeskanzleramt)',
    );
  });

  it('keeps the unknown and ambiguous messages as they were', () => {
    const unknown = captureThrow(() => expandMinistry('BMXX', 'erlaesse_bundesministerium'));
    expect(unknown.message).toContain('Unknown ministry "BMXX"');
    const ambiguous = captureThrow(() => expandMinistry('BMEIA', 'erlaesse_bundesministerium'));
    expect(ambiguous.message).toContain('ambiguous');
    expect(ambiguous.message).not.toContain('not accepted');
  });

  // Regression over the whole table: every abbreviation a family accepts resolves to the value
  // that family's rows carry — or is reported ambiguous where those rows carry several.
  it('resolves every family-accepted abbreviation exactly as the table dictates', () => {
    const families = [
      'einbringende_stelle',
      'erlaesse_bundesministerium',
      'mrp_einbringer',
    ] as const;
    let checked = 0;
    for (const family of families) {
      const abbreviations = new Set(
        table.flatMap((m) =>
          m.abbreviation !== null && m.acceptedBy.includes(family) ? [m.abbreviation] : [],
        ),
      );
      for (const abbreviation of abbreviations) {
        const rows = table.filter(
          (m) => m.abbreviation === abbreviation && m.acceptedBy.includes(family),
        );
        const values = [
          ...new Set(
            rows.map((m) =>
              family === 'einbringende_stelle'
                ? abbreviation
                : family === 'mrp_einbringer'
                  ? m.mrpComposite
                  : m.designation,
            ),
          ),
        ];
        if (values.length === 1) {
          expect(expandMinistry(abbreviation, family), `${abbreviation} on ${family}`).toBe(
            values[0],
          );
        } else {
          expect(captureThrow(() => expandMinistry(abbreviation, family)).message).toContain(
            'ambiguous',
          );
        }
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(80);
  });
});
