/**
 * @fileoverview Normalizer tests over REAL captured RIS payloads (tests/fixtures/ris/,
 * harvested from the production API 2026-07-05). Fully offline — no network.
 * @module tests/services/ris/normalizer
 */

import { readFileSync } from 'node:fs';

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { describe, expect, it } from 'vitest';

import {
  assertNoInBandError,
  coerceWrappedList,
  errorFromResponseBody,
  isHtmlErrorPage,
  parseCelexReferences,
  parseHistoryResponse,
  parseSearchResponse,
  stripHtmlRemnants,
} from '@/services/ris/normalizer.js';
import type {
  RisBundesrechtMetadata,
  RisJudikaturMetadata,
  RisLandesrechtMetadata,
  RisSonstigeMetadata,
} from '@/services/ris/types.js';

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../fixtures/ris/${name}`, import.meta.url), 'utf8'));
}

/** Read a fixture as the raw body text, the shape an error-response body arrives in. */
function rawFixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/ris/${name}`, import.meta.url), 'utf8');
}

type RawNode = Record<string, unknown>;

/**
 * A captured page with fields of one record's metadata node replaced — the upstream shapes no
 * capture happens to carry, such as an element RIS sends as `{"@xsi:nil": "true"}`. `path`
 * names the node under `Data.Metadaten`; `fields` are merged into it.
 */
function withMetadata(
  name: string,
  documentNumber: string,
  path: readonly string[],
  fields: RawNode,
): unknown {
  const payload = fixture(name) as {
    OgdSearchResult: { OgdDocumentResults: { OgdDocumentReference: RawNode | RawNode[] } };
  };
  const refs = [payload.OgdSearchResult.OgdDocumentResults.OgdDocumentReference].flat();
  const ref = refs.find(
    (candidate) =>
      ((candidate.Data as RawNode).Metadaten as { Technisch: { ID: string } }).Technisch.ID ===
      documentNumber,
  );
  if (ref === undefined) throw new Error(`No record ${documentNumber} in ${name}`);
  let node = (ref.Data as RawNode).Metadaten as RawNode;
  for (const key of path) node = node[key] as RawNode;
  Object.assign(node, fields);
  return payload;
}

const NIL = { '@xsi:nil': 'true' };

/** Every record of a page by document number — the page has to parse whole for any of them to exist. */
function metadataById<T>(payload: unknown): Map<string, T> {
  const { hits } = parseSearchResponse(payload);
  return new Map(hits.map((hit) => [hit.documentNumber, hit.metadata as T]));
}

describe('parseSearchResponse', () => {
  it('parses a multi-hit array page and strips <br/> markup (BrKons)', () => {
    const result = parseSearchResponse(fixture('search-brkons-multi.json'));
    expect(result.total).toBe(439471);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
    expect(result.hits).toHaveLength(3);

    const hit = result.hits[0]!;
    expect(hit.documentNumber).toBe('NOR11013238');
    expect(hit.application).toBe('BrKons');
    expect(hit.changed).toBe('2025-10-28');
    const metadata = hit.metadata as RisBundesrechtMetadata;
    expect(metadata.controller).toBe('Bundesrecht');
    // <br/> markers become newlines; no HTML remnants survive.
    expect(metadata.title).not.toContain('<br');
    expect(metadata.title).toContain('StF: BGBl. II Nr. 130/1998');
    expect(metadata.sectionLabel).toBe('§ 0');
    expect(metadata.lawId).toBe('10012838');
    expect(metadata.lawUrl).toContain('GeltendeFassung.wxe');
    expect(metadata.inForceFrom).toBe('1998-04-24');
    expect(metadata.inForceUntil).toBe('2018-12-31');
    expect(metadata.normType).toBe('V');
    expect(metadata.indexes).toEqual(['96/01 Bundesstraßengesetz 1971']);
    // Content URLs keyed by DataType.
    expect(hit.contentUrls.xml).toContain('/Dokumente/Bundesnormen/NOR11013238/NOR11013238.xml');
    expect(hit.contentUrls.html).toContain('.html');
    expect(hit.contentUrls.rtf).toContain('.rtf');
    expect(hit.contentUrls.pdf).toContain('.pdf');
  });

  it('collapses a single-hit object response to one hit (Upts via Sonstige)', () => {
    const result = parseSearchResponse(fixture('search-upts-single.json'));
    expect(result.total).toBe(1);
    expect(result.hits).toHaveLength(1);
    const hit = result.hits[0]!;
    expect(hit.documentNumber).toBe('UPTS_20260427_2026_0_074_605_UPTS_Grüne');
    const metadata = hit.metadata as RisSonstigeMetadata;
    expect(metadata.controller).toBe('Sonstige');
    expect(metadata.caseNumbers).toEqual(['2026-0.074.605/UPTS/Grüne']);
    expect(metadata.party).toBe('GRUENE (Die Grünen - Die Grüne Alternative)');
    // Upts renders multiple cited norms as one newline-separated scalar — split.
    expect(metadata.normsCited.length).toBeGreaterThan(1);
    expect(metadata.normsCited[0]).toBe('PartG §2 Z1');
  });

  it('returns an empty page on zero hits', () => {
    const result = parseSearchResponse(fixture('search-zero-hits.json'));
    expect(result.total).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it('maps an empty-string Dokumentliste to empty content references (BgblAlt)', () => {
    const result = parseSearchResponse(fixture('search-bgblalt.json'));
    const hit = result.hits[0]!;
    expect(hit.contentReferences).toEqual([]);
    expect(hit.contentUrls).toEqual({});
    const metadata = hit.metadata as RisBundesrechtMetadata;
    expect(metadata.alexUrl).toContain('alex.onb.ac.at');
    expect(metadata.gazetteNumber).toBe('49/1940');
    expect(metadata.issue).toBe('25');
  });

  it('coerces a scalar Geschaeftszahl and an array Normen (Vfgh)', () => {
    const result = parseSearchResponse(fixture('search-vfgh.json'));
    const metadata = result.hits[0]!.metadata as RisJudikaturMetadata;
    expect(metadata.controller).toBe('Judikatur');
    expect(metadata.caseNumbers).toEqual(['V23/2026 (V23/2026-12)']);
    expect(metadata.normsCited.length).toBeGreaterThan(3);
    expect(metadata.ecli).toBe('ECLI:AT:VFGH:2026:V23.2026');
    expect(metadata.decisionKind).toBe('Erkenntnis');
    expect(metadata.decisionDocumentType).toBe('Rechtssatz');
    expect(metadata.decisionDate).toBe('2026-06-16');
  });

  it('coerces an array Geschaeftszahl to multiple case numbers', () => {
    const result = parseSearchResponse(fixture('search-gz-array.json'));
    const metadata = result.hits[0]!.metadata as RisJudikaturMetadata;
    expect(metadata.caseNumbers.length).toBeGreaterThan(1);
    expect(metadata.caseNumbers[0]).toBe('E33/2026 ua');
    expect(metadata.caseNumbers).toEqual([
      'E33/2026 ua',
      'E3622/2025',
      'E214/2026 ua',
      'E217/2026',
      'E219/2026 ua',
      'E234/2026 ua',
      'E256/2026 ua',
      'E338/2026 ua',
      'E349/2026 ua',
    ]);
  });

  // search-justiz-gz-joined.json: the live page for Geschaeftszahl=6Ob236/23h (five
  // Rechtssätze) plus one more live Justiz Rechtssatz whose companions are themselves joined.
  it('splits a joined Justiz Geschaeftszahl into one case number per element, companions lifted (#53)', () => {
    const hits = parseSearchResponse(fixture('search-justiz-gz-joined.json')).hits;
    const caseNumbers = hits.map((hit) => (hit.metadata as RisJudikaturMetadata).caseNumbers);

    const [headnote] = caseNumbers;
    expect(hits[0]!.documentNumber).toBe('JJR_19521210_OGH0002_0010OB00948_5200000_001');
    expect(headnote).toHaveLength(52);
    expect(headnote!.slice(0, 5)).toEqual([
      '1Ob948/52',
      '2Ob398/53',
      '3Ob760/53',
      '3Ob761/53',
      '3Ob15/54',
    ]);
    expect(headnote!.slice(-3)).toEqual(['6Ob236/23h', '3Ob149/25w', '3Ob146/25d']);
    expect(headnote).toContain('1Ob236/53');
    for (const value of headnote!) expect(value).toMatch(/^\d+Ob\d+\/\d+[a-z]?$/u);

    for (const single of caseNumbers.slice(1, 5)) expect(single).toEqual(['6Ob236/23h']);

    // Several companions inside one pair of parentheses, separated by `;` themselves.
    expect(caseNumbers[5]).toEqual([
      '13Os15/07s',
      '15Os4/11v',
      '15Os4/18d',
      '15Os39/19b',
      '15Os52/25y',
      '15Os53/25w',
      '15Os54/25t',
      '15Os52/26z',
      '15Os53/26x',
    ]);
  });

  // search-vfgh-gz-joined.json: four live VfGH Rechtssätze — a comma-joined item, a
  // parenthesized ordinal, an ordinal list holding a comma, and an item array.
  it('splits a comma-joined VfGH item but keeps ordinals and the ua suffix whole (#53)', () => {
    const caseNumbers = parseSearchResponse(fixture('search-vfgh-gz-joined.json')).hits.map(
      (hit) => (hit.metadata as RisJudikaturMetadata).caseNumbers,
    );
    expect(caseNumbers).toEqual([
      ['G179/2024', 'V113/2024'],
      ['G8/2026 (G8/2026-15)'],
      ['G155/2025 ua (G155/2025-16, G209/2025-5)'],
      ['E3811/2025 ua', 'E976/2026 ua'],
    ]);
  });

  it('trims the trailing space a Dsk Geschaeftszahl arrives with (#53)', () => {
    const metadata = parseSearchResponse(fixture('search-dsk-gz-trailing-space.json')).hits[0]!
      .metadata as RisJudikaturMetadata;
    expect(metadata.caseNumbers).toEqual(['2022-0.560.569']);
  });

  it('maps every Normenliste identifying field, preferring the VwGH short form (#19)', () => {
    const result = parseSearchResponse(fixture('search-normenliste-dsg.json'));
    const first = result.hits[0]!.metadata as RisJudikaturMetadata;
    expect(first.controller).toBe('Judikatur');
    expect(first.title).toContain('Bundesgesetz über den Schutz personenbezogener Daten');
    expect(first.abbreviation).toBe('DSG 2000');
    expect(first.normType).toBe('BG');
    expect(first.reference).toBe('BGBl I 165/1999 BGBl. I Nr. 165/1999');
    expect(first.indexes).toEqual(['10/10 Datenschutz']);
    expect(first.note).toContain('Umbenennung ab 2018-05-25, nunmehr DSG');
    // A norm-index record identifies a law, so it carries none of the decision fields.
    expect(first.caseNumbers).toEqual([]);
    expect(first.normsCited).toEqual([]);

    // AbkuerzungDesVerwaltungsgerichtshofes is on every record and is the citable form;
    // Abkuerzung is sparse and here repeats the full name.
    const second = result.hits[1]!.metadata as RisJudikaturMetadata;
    expect(second.abbreviation).toBe('DSG 1978');
    expect(second.abbreviation).not.toBe('Datenschutzgesetz - DSG');
    expect(second.note).toBeUndefined();
    // CRLF-delimited upstream — no carriage returns survive into the normalized text.
    expect(second.reference).toBe('BGBl 565/1978\nBGBl. Nr. 565/1978');
    expect(second.title).not.toContain('\r');
  });

  // The normalizer already mapped these two; #22's loss was at the record mapper, so the
  // regression test lives in the ris_search_case_law suite. This pins the fixture shapes.
  it('maps Lvwg Indizes and Bundesland, in both upstream list shapes', () => {
    const result = parseSearchResponse(fixture('search-lvwg-tirol.json'));
    const single = result.hits[0]!.metadata as RisJudikaturMetadata;
    expect(single.state).toBe('Tirol');
    expect(single.indexes).toEqual(['10/10 Grundrechte, Datenschutz, Auskunftspflicht']);
    const multi = result.hits[1]!.metadata as RisJudikaturMetadata;
    expect(multi.state).toBe('Tirol');
    expect(multi.indexes).toEqual([
      '10/01 Bundes-Verfassungsgesetz (B-VG)',
      '10/10 Datenschutz',
      '10/10 Grundrechte, Datenschutz, Auskunftspflicht',
    ]);
  });

  it('maps Erv translation provenance, stripping the <br/> RIS separates it with (#22)', () => {
    const result = parseSearchResponse(fixture('search-erv-translations.json'));
    const first = result.hits[0]!.metadata as RisBundesrechtMetadata;
    expect(first.source).toBe(
      'Original version: Federal Law Gazette No. 52/1991\nas amended by: Federal Law Gazette I No. 50/2025\ndate of the version: 1 November 2025',
    );
    expect(first.author).toBe('Federal Chancellery');
    // An Erv record states its version only here — it has no consolidated-law fields.
    expect(first.inForceFrom).toBeUndefined();
    expect(first.promulgation).toBeUndefined();
    expect(first.eli).toBeUndefined();

    // Author is <br/>-separated prose too when an amendment was translated by another body.
    const second = result.hits[1]!.metadata as RisBundesrechtMetadata;
    expect(second.author).toBe(
      'Federal Ministry for Labour, Social Affairs and Consumer\namendment: Federal Chancellery',
    );
    expect(second.author).not.toContain('<br');
    expect(second.source).not.toContain('<br');
  });

  it('parses CELEX markers from Titel and Aenderung, multi-value brackets included', () => {
    const result = parseSearchResponse(fixture('search-brkons-celex.json'));
    const metadata = result.hits[0]!.metadata as RisBundesrechtMetadata;
    expect(metadata.celexReferences).toContain('395L0046');
    expect(metadata.celexReferences).toContain('32009L0133');
    expect(metadata.celexReferences).toContain('32010L0024');
    expect(metadata.celexReferences).toContain('32016L0680');
  });

  it('keeps every CELEX number of the ABGB Aenderung and none of its annotation fragments (#71)', () => {
    // NOR40198929's Aenderung CELEX lines as RIS sends them, one marker spelled "CELEX Nr.".
    const aenderung =
      '[CELEX-Nr.: 373L0183, 377L0780, 389L0646, 389L0299, 389L0647, 391L0031, 383L0350, 386L0635, 389L0117, 391L0308 (EWR/Anh. IX)]\r\n[CELEX-Nr.: 387L0102 (EWR/Anh. XIX)]\r\n[CELEX-Nr.: 387L0102, 390L0088, 393L0013, 390L0619, 392L0096]\r\n[CELEX-Nr.: 399L0044]\r\n[CELEX-Nr.: 300L0035]\r\n[CELEX-Nr.: 32003L0058]\r\n[CELEX-Nr.: 32008L0048]\r\n[CELEX-Nr.: 32011L0007, 32011L0090]\r\n[CELEX-Nr.: 32011L0083]\r\n[CELEX-Nr.: 32014L0056]\r\n[CELEX-Nr.: 32011L0093, 32012L0029, 32017L0541]\r\n[CELEX-Nr.: 32019L0770, 32019L0771]\r\n[CELEX-Nr.: 32019L1158]\r\n[CELEX Nr.: 32019L1152]\r\n[CELEX-Nr.: 32022L2041]\r\n[CELEX-Nr.: 32024L1346]\r';
    const metadata = metadataById<RisBundesrechtMetadata>(
      withMetadata('search-brkons-celex.json', 'NOR40262691', ['Bundesrecht', 'BrKons'], {
        Aenderung: aenderung,
      }),
    ).get('NOR40262691')!;
    expect(metadata.celexReferences).toEqual([
      // From the fixture's Titel marker.
      '395L0046',
      '373L0183',
      '377L0780',
      '389L0646',
      '389L0299',
      '389L0647',
      '391L0031',
      '383L0350',
      '386L0635',
      '389L0117',
      '391L0308',
      '387L0102',
      '390L0088',
      '393L0013',
      '390L0619',
      '392L0096',
      '399L0044',
      '300L0035',
      '32003L0058',
      '32008L0048',
      '32011L0007',
      '32011L0090',
      '32011L0083',
      '32014L0056',
      '32011L0093',
      '32012L0029',
      '32017L0541',
      '32019L0770',
      '32019L0771',
      '32019L1158',
      '32019L1152',
      '32022L2041',
      '32024L1346',
    ]);
  });

  it('maps the consolidated BrKons Abkuerzung to abbreviation (#51)', () => {
    const metadata = parseSearchResponse(fixture('search-brkons-celex.json')).hits[0]!
      .metadata as RisBundesrechtMetadata;
    expect(metadata.abbreviation).toBe('DSG');
  });

  it('leaves abbreviation absent on a BrKons record without Abkuerzung (#51)', () => {
    for (const hit of parseSearchResponse(fixture('search-brkons-multi.json')).hits) {
      expect(hit.metadata).not.toHaveProperty('abbreviation');
    }
  });

  it('keeps the Begut and RegV Abkuerzung as the federal draft abbreviation (#51)', () => {
    const begut = parseSearchResponse(fixture('search-begut.json')).hits[0]!
      .metadata as RisBundesrechtMetadata;
    const regv = parseSearchResponse(fixture('search-regv.json')).hits[0]!
      .metadata as RisBundesrechtMetadata;
    expect(begut.abbreviation).toBe('EStG-Novelle 2026');
    expect(regv.abbreviation).toBe('USt-Novelle 2026');
  });

  it('trims a Begut or RegV Abkuerzung RIS pads with whitespace (#68)', () => {
    const begut = metadataById<RisBundesrechtMetadata>(
      withMetadata(
        'search-begut-review-window.json',
        'BEGUT_6A7272C6_F603_4C66_A8EE_3A8A4B956566',
        ['Bundesrecht', 'Begut'],
        { Abkuerzung: 'AbfrageberechtigungBilDokG_LS ' },
      ),
    );
    expect(begut.get('BEGUT_6A7272C6_F603_4C66_A8EE_3A8A4B956566')!.abbreviation).toBe(
      'AbfrageberechtigungBilDokG_LS',
    );
    const regv = metadataById<RisBundesrechtMetadata>(
      withMetadata(
        'search-regv-abkuerzung.json',
        'REGV_1ADD1A33_54AA_4943_99C3_C6C6E7D434C3',
        ['Bundesrecht', 'RegV'],
        { Abkuerzung: ' BattBegG' },
      ),
    );
    expect(regv.get('REGV_1ADD1A33_54AA_4943_99C3_C6C6E7D434C3')!.abbreviation).toBe('BattBegG');
  });

  it('reads the Begut review start and the draft keywords verbatim, ";" separators included (#68)', () => {
    const begut = metadataById<RisBundesrechtMetadata>(fixture('search-begut-review-window.json'));
    expect(begut.get('BEGUT_1174CDB5_3F55_443A_A112_175692DE8744')).toMatchObject({
      keywords: 'F-Gase, Biozide, Chemikalien',
      reviewDeadline: '2026-11-26',
      reviewStart: '2026-10-15',
    });
    expect(begut.get('BEGUT_36D925A7_3CDE_452E_ACCF_486628CEDFFB')!.keywords).toBe(
      'Geologische Speicherung; Kohlenstoffdioxid; CO2',
    );
  });

  // search-lrkons-abkuerzung.json is one page assembled from four live LrKons records: both
  // BO für Wien § 1 / § 1a hits, Salzburg's ALHVO 2022 § 1 (Abkuerzung arrives with a leading
  // space), and a Wien § 1 that carries Schlagworte but no Abkuerzung.
  it('maps the consolidated LrKons Abkuerzung to abbreviation, trimmed (#51)', () => {
    const hits = parseSearchResponse(fixture('search-lrkons-abkuerzung.json')).hits;
    const metadata = hits.map((hit) => hit.metadata as RisLandesrechtMetadata);
    expect(hits.map((hit) => hit.documentNumber)).toEqual([
      'LWI40016426',
      'LWI40017687',
      'LSB40028116',
      'LWI40000588',
    ]);
    expect(metadata.map((md) => md.controller)).toEqual(Array(4).fill('Landesrecht'));
    expect(metadata[0]!.abbreviation).toBe('BO für Wien');
    expect(metadata[1]!.abbreviation).toBe('BO für Wien');
    expect(metadata[2]!.abbreviation).toBe('ALHVO 2022');
    expect(metadata[3]).not.toHaveProperty('abbreviation');
  });

  it('maps the consolidated Schlagworte to keywords, absent where RIS sends none', () => {
    const metadata = parseSearchResponse(fixture('search-lrkons-abkuerzung.json')).hits.map(
      (hit) => hit.metadata as RisLandesrechtMetadata,
    );
    expect(metadata[0]!.keywords).toMatch(/^Bauordnung, Bau, Stadtentwicklung,/u);
    expect(metadata[1]).not.toHaveProperty('keywords');
    expect(metadata[2]).not.toHaveProperty('keywords');
    expect(metadata[3]!.keywords).toMatch(/^Pensionsordnung, /u);
    const brkons = parseSearchResponse(fixture('search-brkons-celex.json')).hits[0]!
      .metadata as RisBundesrechtMetadata;
    // RIS separates keyword groups with <br/>; keywords stay one comma-separated list.
    expect(brkons.keywords).toMatch(/^e-rk3, Inh, Gewinnabsicht, 2\. Euro-Umstellungsgesetz/u);
    expect(brkons.keywords).not.toContain('\n');
  });

  it('joins keyword groups RIS breaks with <br/> into one list on a Sonstige record too (#63, #54)', () => {
    const sonstige = parseSearchResponse(
      withMetadata('search-erlaesse.json', 'ERL_BMJ_20260924_2026_0_710_595', ['Sonstige'], {
        Schlagworte: 'Gebühren,<br/>Vergleich<br/><br/>Gerichtsgebühren <br/>',
      }),
    ).hits.find((hit) => hit.documentNumber === 'ERL_BMJ_20260924_2026_0_710_595')!
      .metadata as RisSonstigeMetadata;
    expect(sonstige.keywords).toBe('Gebühren, Vergleich, Gerichtsgebühren');
  });

  it('normalizes object-or-array content references and keys DataTypes (Mrp, GrA)', () => {
    const mrp = parseSearchResponse(fixture('search-mrp.json')).hits[0]!;
    // ContentReference array with a single-object ContentUrl inside.
    expect(mrp.contentReferences.length).toBeGreaterThan(1);
    expect(mrp.contentReferences[0]!.type).toBe('MainDocument');
    expect(mrp.contentUrls.pdf).toContain('/Dokumente/Mrp/MRP_20260701_59/');
    const mrpMeta = mrp.metadata as RisSonstigeMetadata;
    expect(mrpMeta.issuers.length).toBeGreaterThan(2);
    expect(mrpMeta.sessionNumber).toBe('59');

    const gra = parseSearchResponse(fixture('search-gra.json')).hits[0]!;
    // Single-object ContentReference; the signed PDF arrives as DataType Authentisch.
    expect(gra.contentUrls.authentic).toContain('/Dokumente/GemeinderechtAuth/');
    expect(gra.metadata.controller).toBe('Gemeinden');
  });

  it('normalizes the Landesrecht and Bezirke classes', () => {
    const lgbl = parseSearchResponse(fixture('search-lgblauth.json')).hits[0]!;
    expect(lgbl.metadata.controller).toBe('Landesrecht');
    const bvb = parseSearchResponse(fixture('search-bvb.json')).hits[0]!;
    expect(bvb.metadata.controller).toBe('Bezirke');
  });

  it('throws ValidationError with the RIS message on an in-band Client error', () => {
    let caught: McpError | undefined;
    try {
      parseSearchResponse(fixture('error-client.json'));
    } catch (error) {
      caught = error as McpError;
    }
    expect(caught).toBeInstanceOf(McpError);
    expect(caught!.code).toBe(JsonRpcErrorCode.ValidationError);
    // RIS's schema-validation message passes through and names the element…
    expect(caught!.message).toContain('FassungVom');
    // …but the transport prefix is trimmed.
    expect(caught!.message.startsWith('soap:Client')).toBe(false);
  });

  it('classifies a fault whose soap: prefix sits behind .NET scaffolding (real 500 body)', () => {
    // Landesrecht wraps its faults in `Bka.Ris.…OgdException: soap:Client:…`, which hid the
    // prefix from classification and made this deterministic input error look transient.
    let caught: McpError | undefined;
    try {
      parseSearchResponse(fixture('error-500-vbl-invalid-state.json'));
    } catch (error) {
      caught = error as McpError;
    }
    expect(caught!.code).toBe(JsonRpcErrorCode.ValidationError);
    // The rejected value survives; only the .NET type names and stack marker are dropped.
    expect(caught!.message).toContain("'Kaernten' is not a valid value for RemotionVblBundesland");
    expect(caught!.message).not.toContain('Exception');
    expect(caught!.message).not.toContain('<STACKTRACE>');
  });

  it('rejects unrecognized envelopes as transient', () => {
    expect(() => parseSearchResponse({})).toThrowError(
      expect.objectContaining({ code: JsonRpcErrorCode.ServiceUnavailable }),
    );
    expect(() => parseSearchResponse({ OgdSearchResult: {} })).toThrowError(
      expect.objectContaining({ code: JsonRpcErrorCode.ServiceUnavailable }),
    );
  });
});

describe('the original gazette number of a consolidated law (#80)', () => {
  it('maps StammnormBgblnummer from BrKons and LrKons', () => {
    const federal = metadataById<RisBundesrechtMetadata>(
      fixture('search-brkons-vwgvg-section-28.json'),
    );
    expect(federal.get('NOR40196850')!.originalGazetteNumber).toBe('33/2013');
    const state = metadataById<RisLandesrechtMetadata>(
      fixture('search-lrkons-bo-wien-section-1.json'),
    );
    expect(state.get('LWI40016426')!.originalGazetteNumber).toBe('11/1930');
  });

  it('reads a nil StammnormBgblnummer as no original gazette number', () => {
    const meta = metadataById<RisBundesrechtMetadata>(
      withMetadata(
        'search-brkons-vwgvg-section-28.json',
        'NOR40196850',
        ['Bundesrecht', 'BrKons'],
        { StammnormBgblnummer: NIL },
      ),
    );
    expect(meta.get('NOR40196850')).not.toHaveProperty('originalGazetteNumber');
    expect(meta.get('NOR40196850')!.abbreviation).toBe('VwGVG');
  });
});

describe('gazette identifiers — CELEX lists, Gliederungszahl, issue and page (#55)', () => {
  it('keeps the BgblAlt issue and start page and the LgblNO Gliederungszahl and issue', () => {
    const bgblAlt = metadataById<RisBundesrechtMetadata>(fixture('search-bgblalt.json'));
    expect(bgblAlt.get('glo1940_0049_00357')).toMatchObject({ issue: '25', startPage: '357' });
    const lgblNo = metadataById<RisLandesrechtMetadata>(fixture('search-lgblno.json'));
    expect(lgblNo.get('LRNI_2007006')).toMatchObject({
      issue: '6',
      systematicNumber: '0001/1-62',
    });
  });

  it('reads the BgblAuth CelexNummer list, in both of its wrapped-list shapes', () => {
    const meta = metadataById<RisBundesrechtMetadata>(fixture('search-bgblauth-celex.json'));
    expect(meta.get('BGBLA_2026_I_8')!.celexReferences).toEqual([
      '32019L0633',
      '32019L1161',
      '32022L2041',
      '32022L2381',
      '32023L0970',
      '32023L1791',
      '32024L1760',
    ]);
    // A single CELEX arrives as `{ item: "…" }`, not a one-element array.
    expect(meta.get('BGBLA_2026_I_81')!.celexReferences).toEqual(['32024L1233']);
    expect(meta.get('BGBLA_2026_I_88')!.celexReferences).toEqual([]);
  });

  it('splits the comma-joined BgblPdf CelexNummer string into one entry per act', () => {
    const meta = metadataById<RisBundesrechtMetadata>(fixture('search-bgblpdf-celex.json'));
    const nine = meta.get('2003_570_2')!.celexReferences;
    expect(nine).toEqual([
      '31975L0442',
      '31991L0156',
      '31996D0350',
      '31991L0689',
      '31994L0031',
      '32000D0532',
      '32001D0118',
      '32001D0119',
      '32001D0573',
    ]);
    expect(nine.some((entry) => entry.includes(','))).toBe(false);
    expect(meta.get('2003_140_1')!.celexReferences).toEqual(['32001L0019']);
    expect(meta.get('2003_146_1')!.celexReferences).toEqual([]);
  });

  it('strips the "CELEX-Nr.:" label and splits on "und" in a prose BgblPdf value', () => {
    const meta = metadataById<RisBundesrechtMetadata>(fixture('search-bgblpdf-celex.json'));
    expect(meta.get('2003_130_1')!.celexReferences).toEqual(['31999L0070', '32001L0019']);
  });

  it('reads the LgblNO CelexNummern list verbatim, pre-sector forms and corrigenda included', () => {
    const meta = metadataById<RisLandesrechtMetadata>(fixture('search-lgblno.json'));
    expect(meta.get('LRNI_2007086')!.celexReferences).toEqual([
      '383L0189',
      '388L0182',
      '394L0010',
      '394L0010R(01)',
      '398L0034',
      '398L0048',
    ]);
    expect(meta.get('LRNI_2007006')!.celexReferences).toEqual([]);
  });
});

describe('nil and wrapped upstream shapes on the abbreviation, decree, and CELEX fields', () => {
  it('reads a nil BrKons Abkuerzung as no abbreviation (#51)', () => {
    const meta = metadataById<RisBundesrechtMetadata>(
      withMetadata('search-brkons-celex.json', 'NOR40262691', ['Bundesrecht', 'BrKons'], {
        Abkuerzung: NIL,
      }),
    );
    expect(meta.get('NOR40262691')).not.toHaveProperty('abbreviation');
  });

  it('reads a nil LrKons Abkuerzung as no abbreviation, and the rest of the page still parses (#51)', () => {
    const meta = metadataById<RisLandesrechtMetadata>(
      withMetadata('search-lrkons-abkuerzung.json', 'LWI40016426', ['Landesrecht', 'LrKons'], {
        Abkuerzung: NIL,
      }),
    );
    expect(meta.get('LWI40016426')).not.toHaveProperty('abbreviation');
    expect(meta.get('LWI40017687')!.abbreviation).toBe('BO für Wien');
    expect(meta.size).toBe(4);
  });

  it('reads a nil decree Abteilung as no department, and the rest of the page still parses (#54)', () => {
    const meta = metadataById<RisSonstigeMetadata>(
      withMetadata(
        'search-erlaesse.json',
        'ERL_BMJ_20250930_2025_0_575_430',
        ['Sonstige', 'Erlaesse'],
        { Abteilung: NIL },
      ),
    );
    expect(meta.get('ERL_BMJ_20250930_2025_0_575_430')).not.toHaveProperty('department');
    expect(meta.get('ERL_BMJ_20260924_2026_0_710_595')!.department).toBe('I 7');
    expect(meta.size).toBe(5);
  });

  it('reads a nil BgblPdf CelexNummer as no CELEX entries, and the rest of the page still parses (#55)', () => {
    const meta = metadataById<RisBundesrechtMetadata>(
      withMetadata('search-bgblpdf-celex.json', '2003_570_2', ['Bundesrecht', 'BgblPdf'], {
        CelexNummer: NIL,
      }),
    );
    expect(meta.get('2003_570_2')!.celexReferences).toEqual([]);
    expect(meta.get('2003_130_1')!.celexReferences).toEqual(['31999L0070', '32001L0019']);
  });

  it('splits each item of a wrapped BgblPdf CelexNummer list (#55)', () => {
    const meta = metadataById<RisBundesrechtMetadata>(
      withMetadata('search-bgblpdf-celex.json', '2003_570_2', ['Bundesrecht', 'BgblPdf'], {
        CelexNummer: { item: ['31991L0628, 31995L0029', 'CELEX-Nr.: 31999L0070 und 32001L0019'] },
      }),
    );
    expect(meta.get('2003_570_2')!.celexReferences).toEqual([
      '31991L0628',
      '31995L0029',
      '31999L0070',
      '32001L0019',
    ]);
  });

  it('keeps only the CELEX numbers of a BgblPdf CelexNummer carrying annotation text (#71)', () => {
    const meta = metadataById<RisBundesrechtMetadata>(
      withMetadata('search-bgblpdf-celex.json', '2003_570_2', ['Bundesrecht', 'BgblPdf'], {
        CelexNummer:
          '31991L0628 (EWR/Anh. IX), 31995L0029; CELEX-Nr.: 394L0010R(01) und 32001L0019',
      }),
    );
    expect(meta.get('2003_570_2')!.celexReferences).toEqual([
      '31991L0628',
      '31995L0029',
      '394L0010R(01)',
      '32001L0019',
    ]);
  });

  it('reads nil decree Anmerkung, Fundstelle, Genehmigungsdatum, and Normen, and a nil BgblPdf Fundstelle, as absent or empty', () => {
    const decree = metadataById<RisSonstigeMetadata>(
      withMetadata(
        'search-erlaesse.json',
        'ERL_BMJ_20260924_2026_0_710_595',
        ['Sonstige', 'Erlaesse'],
        { Anmerkung: NIL, Fundstelle: NIL, Genehmigungsdatum: NIL, Normen: NIL },
      ),
    ).get('ERL_BMJ_20260924_2026_0_710_595')!;
    expect(decree.normsCited).toEqual([]);
    for (const key of ['approvalDate', 'note', 'promulgation'] as const) {
      expect(decree).not.toHaveProperty(key);
    }
    const pdf = metadataById<RisBundesrechtMetadata>(
      withMetadata('search-bgblpdf-celex.json', '2003_570_2', ['Bundesrecht', 'BgblPdf'], {
        Fundstelle: NIL,
      }),
    ).get('2003_570_2')!;
    expect(pdf).not.toHaveProperty('promulgation');
  });
});

describe('announcement metadata — decrees, case numbers, repeal dates (#54)', () => {
  const sonstigeById = (name: string) => metadataById<RisSonstigeMetadata>(fixture(name));

  it('keeps the decree fields it already mapped (case number, type, department, in-force date)', () => {
    const decree = sonstigeById('search-erlaesse.json').get('ERL_BMJ_20260924_2026_0_710_595');
    expect(decree).toMatchObject({
      caseNumbers: ['2026-0.710.595'],
      department: 'I 7',
      inForceFrom: '2026-10-01',
      normType: 'Erlass',
    });
    expect(decree!.publishedDate).toBeUndefined();
  });

  it('trims a decree department RIS pads with a trailing space ("I 7 ")', () => {
    const decree = sonstigeById('search-erlaesse.json').get('ERL_BMJ_20250930_2025_0_575_430');
    expect(decree!.department).toBe('I 7');
  });

  it('reads decree Normen verbatim — one item per RIS entry, never split on commas', () => {
    const decrees = sonstigeById('search-erlaesse.json');
    expect(decrees.get('ERL_BMJ_20260924_2026_0_710_595')!.normsCited).toEqual([
      'TP1 GGG, TP2 GGG, TP3 GGG, TP12 GGG',
    ]);
    expect(decrees.get('ERL_BKA_20250110_2025_0_015_115')!.normsCited).toEqual([
      'B-VG Art 22a',
      'IFG',
    ]);
    expect(decrees.get('ERL_BKA_20250813_2025_0_615_241')!.normsCited).toEqual([]);
  });

  it('reads the decree approval date, gazette citation, and note', () => {
    const decrees = sonstigeById('search-erlaesse.json');
    expect(decrees.get('ERL_BMJ_20260924_2026_0_710_595')).toMatchObject({
      approvalDate: '2026-09-24',
      promulgation: 'eJABl Nr. 13/2026',
    });
    expect(decrees.get('ERL_BMJ_20250930_2025_0_575_430')!.note).toBe(
      'Außerkrafttreten des Erlasses vom 20. April 2018',
    );
    expect(decrees.get('ERL_BKA_20250110_2025_0_015_115')!.promulgation).toBeUndefined();
  });

  it('trims the whitespace some veterinary case numbers arrive with', () => {
    const avn = sonstigeById('search-avn.json');
    expect(avn.get('AVN_20261009_AVN_2026_23')!.caseNumbers).toEqual(['2026-0.847.254']);
    expect(avn.get('AVN_20260805_AVN_2026_17')!.caseNumbers).toEqual(['2026-0.613.534']);
  });

  it('reads the repeal date of trade-exam rules and health-structure plans', () => {
    expect(
      sonstigeById('search-pruefgewo.json').get('PRUEF_20210412_2021_0_253_954_BMDW_Gewerberecht_')!
        .inForceUntil,
    ).toBe('2022-11-15');
    expect(sonstigeById('search-spg.json').get('SPG_SA_RSG_V_20250507_3_2025')!.inForceUntil).toBe(
      '2026-02-16',
    );
  });
});

describe('assertNoInBandError', () => {
  it('honors the handbook @type attribute when present', () => {
    expect(() =>
      assertNoInBandError({ Error: { '@type': 'Client', Message: 'bad element' } }),
    ).toThrowError(expect.objectContaining({ code: JsonRpcErrorCode.ValidationError }));
    expect(() =>
      assertNoInBandError({ Error: { '@type': 'Server', Message: 'backend down' } }),
    ).toThrowError(expect.objectContaining({ code: JsonRpcErrorCode.ServiceUnavailable }));
  });

  it('classifies by the soap: message prefix when @type is absent', () => {
    expect(() =>
      assertNoInBandError({ Error: { Message: 'soap:Server. backend degraded' } }),
    ).toThrowError(expect.objectContaining({ code: JsonRpcErrorCode.ServiceUnavailable }));
  });

  it('passes error-free envelopes through', () => {
    expect(() => assertNoInBandError({})).not.toThrow();
  });
});

describe('errorFromResponseBody', () => {
  // RIS answers a rejected parameter with HTTP 500 carrying the same OgdSearchResult.Error
  // envelope it uses in-band on a 200 — so the status alone would call a caller input error
  // a server fault. Both bodies below are verbatim captures from the live API (2026-07-15).
  it('translates an out-of-range page 500 body to ValidationError with RIS’s own message', () => {
    const error = errorFromResponseBody(rawFixture('error-500-page-overflow.json'));
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    // RIS names the cause; the transport prefix is trimmed, the explanation survives.
    expect(error?.message).toBe('Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten');
    expect(error?.data).toMatchObject({ risApplication: 'History' });
  });

  it('translates a non-paging 500 body the same way — the envelope drives it, not the message', () => {
    const error = errorFromResponseBody(rawFixture('error-500-unknown-application.json'));
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error?.message).toBe('Application NotARealApp not found');
  });

  // RIS wraps its fulltext-validation faults in .NET exception scaffolding. The German
  // sentence is the actionable part and must survive whole; the scaffolding must not.
  const FULLTEXT_GUIDANCE =
    'Eine \'FulltextSearchExpression\' enthält eine ungültige Abfrage: Die Eingabe "*" enthält zu wenige Zeichen vor oder nach dem Platzhalter (*). Es müssen mindestens 2 Zeichen vor oder nach dem Platzhalter sein. Bitte korrigieren Sie Ihre Eingabe.';

  it('strips the SoapException scaffolding and stack marker, keeping RIS’s guidance whole', () => {
    const error = errorFromResponseBody(rawFixture('error-500-fulltext-wildcard.json'));
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error?.message).toBe(FULLTEXT_GUIDANCE);
  });

  it('classifies a Landesrecht fault, whose soap: prefix hides behind an outer .NET wrapper', () => {
    // Landesrecht alone prefixes `Bka.Ris.…OgdException: ` — which pushed the soap: prefix
    // off the front, so the fault fell through to the transient ServiceUnavailable bucket
    // and got retried. Same rejected input as the wildcard body above, same verdict.
    const error = errorFromResponseBody(rawFixture('error-500-fulltext-landesrecht.json'));
    expect(error?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error?.code).not.toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error?.message).toBe(FULLTEXT_GUIDANCE);
  });

  it('leaves a fault that carries no scaffolding byte-identical', () => {
    // The paging and schema-validation faults are already clean — RIS's prose names no .NET
    // type, so the strip must be a no-op on them rather than eating a real word.
    expect(errorFromResponseBody(rawFixture('error-500-page-overflow.json'))?.message).toBe(
      'Die Seitennummer ist höher als die Anzahl der verfügbaren Seiten',
    );
    const schema = errorFromResponseBody(rawFixture('error-client.json'));
    expect(schema?.message).toBe(
      "Schema Validation Error: The 'http://ris.bka.gv.at/ogd/V2_6:FassungVom' element is invalid - The value 'notadate' is invalid according to its datatype 'http://www.w3.org/2001/XMLSchema:date' - The string 'notadate' is not a valid Date value.",
    );
  });

  it('classifies a Server-prefixed error body as transient ServiceUnavailable', () => {
    const body = JSON.stringify({
      OgdSearchResult: { Error: { Applikation: 'History', Message: 'soap:Server. backend down' } },
    });
    expect(errorFromResponseBody(body)?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
  });

  it('keeps the original error as the cause when one is supplied', () => {
    const cause = new McpError(JsonRpcErrorCode.InternalError, 'Fetch failed. Status: 500');
    const error = errorFromResponseBody(rawFixture('error-500-page-overflow.json'), { cause });
    expect(error?.cause).toBe(cause);
  });

  it('gives up on a body truncated mid-JSON rather than fabricating an error', () => {
    // fetchWithTimeout captures at most ERROR_BODY_LIMIT (500) bytes of an error body and
    // appends an ellipsis — a longer envelope than RIS's known ones arrives unparseable.
    const longBody = JSON.stringify({
      OgdSearchResult: {
        Error: { Applikation: 'History', Message: `soap:Client. ${'detail '.repeat(100)}` },
      },
    });
    expect(longBody.length).toBeGreaterThan(500);
    expect(errorFromResponseBody(`${longBody.slice(0, 500)}…`)).toBeUndefined();
  });

  it('gives up on bodies that carry no RIS error envelope', () => {
    expect(errorFromResponseBody(undefined)).toBeUndefined();
    expect(errorFromResponseBody('<!DOCTYPE html><html>Gateway Timeout</html>')).toBeUndefined();
    expect(errorFromResponseBody('{"OgdSearchResult":{}}')).toBeUndefined();
    // A successful envelope carries no Error node — nothing to translate.
    expect(errorFromResponseBody(JSON.stringify(fixture('search-zero-hits.json')))).toBeUndefined();
  });
});

describe('parseHistoryResponse', () => {
  it('separates changed documents from deletion records', () => {
    const result = parseHistoryResponse(fixture('history-with-deleted.json'));
    expect(result.total).toBe(101);
    const documents = result.changes.filter((change) => change.kind === 'document');
    const deleted = result.changes.filter((change) => change.kind === 'deleted');
    expect(documents).toHaveLength(2);
    expect(deleted).toHaveLength(5);
    const record = deleted[0]!;
    if (record.kind !== 'deleted') throw new Error('unreachable');
    expect(record.record.documentNumber).toBe('NOR30003318');
    // Deletion records carry the History application name, not the search code.
    expect(record.record.application).toBe('Bundesnormen');
    expect(record.record.deletedAt).toBe('2026-06-17T14:46:31');
    // Changed documents keep the standard normalized record shape.
    const doc = documents[0]!;
    if (doc.kind !== 'document') throw new Error('unreachable');
    expect(doc.hit.metadata.controller).toBe('Bundesrecht');
  });
});

describe('text helpers', () => {
  it('coerceWrappedList handles every upstream list shape', () => {
    expect(coerceWrappedList(undefined)).toEqual([]);
    expect(coerceWrappedList('')).toEqual([]);
    expect(coerceWrappedList('one')).toEqual(['one']);
    expect(coerceWrappedList({ item: 'one' })).toEqual(['one']);
    expect(coerceWrappedList({ item: ['a', 'b'] })).toEqual(['a', 'b']);
    expect(coerceWrappedList({})).toEqual([]);
  });

  it('stripHtmlRemnants converts <br/> to newlines, drops tags, decodes entities', () => {
    expect(stripHtmlRemnants('a<br/>b<br />c<br>d')).toBe('a\nb\nc\nd');
    expect(stripHtmlRemnants('x &amp; y &lt;z&gt;')).toBe('x & y <z>');
    expect(stripHtmlRemnants('trailing<br/><br/><br/>')).toBe('trailing');
    expect(stripHtmlRemnants('<i>styled</i> text')).toBe('styled text');
  });

  it('stripHtmlRemnants normalizes the CRLF line endings RIS emits in text fields', () => {
    // Normenliste titles and Fundstellen are CRLF-delimited upstream; a literal \r reaches
    // the caller as escape noise around every line break.
    expect(stripHtmlRemnants('line one\r\nline two\rline three')).toBe(
      'line one\nline two\nline three',
    );
    expect(stripHtmlRemnants('one break<br/>\r\nnot two')).toBe('one break\nnot two');
  });

  it('parseCelexReferences splits multi-value brackets and deduplicates', () => {
    expect(
      parseCelexReferences('x [CELEX-Nr.: 32009L0133, 32010L0024] y', '[CELEX-Nr.: 32009L0133]'),
    ).toEqual(['32009L0133', '32010L0024']);
    expect(parseCelexReferences(undefined, 'no markers here')).toEqual([]);
  });

  it('parseCelexReferences keeps the pre-1999 short form, the sector-less year, and corrigendum suffixes as written', () => {
    expect(
      parseCelexReferences('[CELEX-Nr.: 373L0183, 32018L2001; 32023L1791R(05), 2003L0087]'),
    ).toEqual(['373L0183', '32018L2001', '32023L1791R(05)', '2003L0087']);
  });

  it('parseCelexReferences drops parenthesized annotation text, across both separators (#71)', () => {
    // The ABGB Aenderung brackets, as RIS sends them.
    expect(
      parseCelexReferences(
        '[CELEX-Nr.: 383L0350, 386L0635, 389L0117, 391L0308 (EWR/Anh. IX)]\n[CELEX-Nr.: 387L0102 (EWR/Anh. XIX)]',
        '[CELEX-Nr.: 390L0088; 393L0013 (EWR/Anh. IX), 390L0619]',
      ),
    ).toEqual([
      '383L0350',
      '386L0635',
      '389L0117',
      '391L0308',
      '387L0102',
      '390L0088',
      '393L0013',
      '390L0619',
    ]);
  });

  it('parseCelexReferences drops the "und" joining the last two numbers of a bracket (#71)', () => {
    expect(parseCelexReferences('[CELEX-Nr.: 396L0082, 300L0076 und 399L0031]')).toEqual([
      '396L0082',
      '300L0076',
      '399L0031',
    ]);
  });

  it('parseCelexReferences reads past an unclosed bracket without keeping the gazette lines it spans (#71)', () => {
    // An Aenderung RIS closes with ")" instead of "]": the marker runs on to the next "]".
    const aenderung =
      '[CELEX-Nr.: 393L0006, 395L0026, 396L0010)\r\nBGBl. Nr. 757/1996 (NR: GP XX RV 397 AB 477 S. 47. BR: AB 5314 S. 619.)\r\nBGBl. I Nr. 58/1997 (K über Idat)\r\n[CELEX-Nr.: 390L0314]';
    expect(parseCelexReferences(aenderung)).toEqual([
      '393L0006',
      '395L0026',
      '396L0010',
      '390L0314',
    ]);
  });

  it('isHtmlErrorPage detects HTML bodies', () => {
    expect(isHtmlErrorPage('<!DOCTYPE html><html>…')).toBe(true);
    expect(isHtmlErrorPage('  <html lang="de">')).toBe(true);
    expect(isHtmlErrorPage('{"OgdSearchResult":{}}')).toBe(false);
  });
});

describe('gazette promulgation — the gazette each federal entry appeared in (#65)', () => {
  /** The promulgation of record `id` on the captured page `name`. */
  const promulgation = (name: string, id: string) =>
    metadataById<RisBundesrechtMetadata>(fixture(name)).get(id)?.promulgation;

  it('reads the BgblPdf Fundstelle, the only field telling 1945 StGBl. from BGBl.', () => {
    expect(promulgation('search-bgblpdf-1-1945.json', '1945_1_0')).toBe('StGBl. Nr. 1/1945');
    expect(promulgation('search-bgblpdf-1-1945.json', '1945_0_0')).toBe('BGBl. Nr. 1/1945');
    expect(promulgation('search-bgblpdf-50-1999.json', '1999_50_1')).toBe('BGBl. I Nr. 50/1999');
  });

  it('keeps the BgblAlt Kundmachungsorgan, the gazette title', () => {
    expect(promulgation('search-bgblalt-1-1938.json', 'glo1938_0001_00001')).toBe(
      'Gesetzblatt für das Land Österreich',
    );
    expect(promulgation('search-bgblalt-1-1938.json', 'bgl1938_0001_00001')).toBe(
      'Bundesgesetzblatt für den Bundesstaat Österreich',
    );
  });
});

describe('parseCelexReferences — time on adversarial input (#71)', () => {
  /** Bound on one parse at the largest size of any shape; linear work there takes under 2 ms. */
  const BOUND_MS = 50;

  /** Thread-CPU milliseconds of one parse, the fastest of three samples of ≥ 10 ms each. */
  function cpuMs(text: string): number {
    let best = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 3; sample++) {
      const start = process.threadCpuUsage();
      let runs = 0;
      let ms = 0;
      do {
        parseCelexReferences(text);
        runs++;
        const { user, system } = process.threadCpuUsage(start);
        ms = (user + system) / 1_000;
      } while (ms < 10);
      best = Math.min(best, ms / runs);
    }
    return best;
  }

  /**
   * Each shape leads with one real number, so the parse is checked to keep it at every size: a
   * parse that turned fast by giving up early fails there. The adversarial run follows it, where
   * no later number lets a backtracking pattern end its scan.
   */
  it.each<[string, number, (size: number) => string, string[]]>([
    [
      'a long digit run inside one marker',
      5_000,
      (size) => `[CELEX-Nr.: 32016L0680, ${'3'.repeat(size)}L0001]`,
      ['32016L0680'],
    ],
    [
      'repeated openers with no closer',
      1_250,
      (size) => `[CELEX-Nr.: 32016L0680] ${'[CELEX-Nr.: '.repeat(Math.ceil(size / 12))}`,
      ['32016L0680'],
    ],
    [
      'repeated openers before one closer',
      1_250,
      (size) => `${'[CELEX Nr. 373L0183 '.repeat(Math.ceil(size / 20))}]`,
      ['373L0183'],
    ],
    [
      'one long line ending in a break',
      1_250,
      (size) => `[CELEX-Nr.: 32016L0680 ${'§1 x'.repeat(size / 4)}\ny]`,
      ['32016L0680'],
    ],
    [
      'breaks throughout',
      1_250,
      (size) => `[CELEX-Nr.: 32016L0680${'  \r\n'.repeat(size / 4)}]`,
      ['32016L0680'],
    ],
  ])('stays linear on %s', (_shape, smallest, make, expected) => {
    // Doubling sizes spanning 64×, each checked against the bound before the next runs.
    const times: number[] = [];
    for (let size = smallest; size <= smallest * 64; size *= 2) {
      const text = make(size);
      expect(parseCelexReferences(text), `${size} characters`).toEqual(expected);
      const ms = cpuMs(text);
      expect(ms, `${size} characters`).toBeLessThan(BOUND_MS);
      times.push(ms);
    }
    expect(times).toHaveLength(7);
    expect(times.at(-1)! / times[0]!).toBeLessThan(256);
  });
});
