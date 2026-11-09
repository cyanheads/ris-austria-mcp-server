/**
 * @fileoverview The grammar of `readDocumentLink`, tabled once at its own seam: every ELI and
 * `Dokument.wxe` layout RIS records carry, the links it leaves to callers (`null`), the in-family
 * shapes it refuses (`{ error }`), the document-number check that keeps a link from moving the
 * content path, and its time on caller-sized links. The real links are records' own `eli` and
 * `document_url` values (sampled 2026-11-09 across all 39 applications), each paired with that
 * record's application and document number. Fully offline.
 * @module tests/services/ris/document-link.test
 */

import { describe, expect, it } from 'vitest';

import { readDocumentLink } from '@/services/ris/document-link.js';
import { RIS_STATES } from '@/services/ris/reference/states.js';

const ORIGIN_ERROR =
  'RIS links are read only from ris.bka.gv.at, www.ris.bka.gv.at, or ogd.ris.bka.gv.at, over https or http on the default port.';
const ELI_LAYOUT_ERROR =
  "The ELI is not one of the layouts read: a consolidated provision's ELI, which ends in its document number (NOR… federal; LBG…, LKT…, LNO…, LOO…, LSB…, LST…, LTI…, LVB…, or LWI… state), /eli/bgbl/{I|II|III}/{year}/{number}/{yyyymmdd}, and /eli/lgbl/{BU|KA|NI|OB|SA|ST|TI|VO|WI}/{year}/{number}/{yyyymmdd}.";
const ABFRAGE_COUNT_ERROR =
  'The Dokument.wxe link must carry exactly one Abfrage, the parameter naming its application.';
const ABFRAGE_UNKNOWN_ERROR =
  "The Dokument.wxe link's Abfrage names no RIS application: a web view names an application by its code, except Bundesnormen for BrKons, Landesnormen for LrKons, Gemeinderecht for Gr, and GemeinderechtAuth for GrA.";
const DOKUMENTNUMMER_COUNT_ERROR = 'The Dokument.wxe link must carry exactly one Dokumentnummer.';
const DOKUMENTNUMMER_INVALID_ERROR =
  "The Dokument.wxe link's Dokumentnummer is not a valid RIS document number.";

const WEB_VIEW = 'https://ogd.ris.bka.gv.at/Dokument.wxe';
const OGD_ELI = 'https://ogd.ris.bka.gv.at/eli';

describe('readDocumentLink — the links #110 and #111 name', () => {
  it.each([
    [
      'https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=Vfgh&Dokumentnummer=JFR_20261007_26G00167_01',
      { kind: 'web_view', application: 'Vfgh', documentNumber: 'JFR_20261007_26G00167_01' },
    ],
    [
      'https://ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=Gemeinderecht&Dokumentnummer=GEMRE_KA_20701_000__902__2020_me_',
      { kind: 'web_view', application: 'Gr', documentNumber: 'GEMRE_KA_20701_000__902__2020_me_' },
    ],
    [
      'https://ris.bka.gv.at/eli/bgbl/i/1999/165/A2P4/NOR40212006',
      { kind: 'consolidated', application: 'BrKons', documentNumber: 'NOR40212006' },
    ],
    [
      'https://www.ris.bka.gv.at/eli/bgbl/1974/60/P75/NOR12029618',
      { kind: 'consolidated', application: 'BrKons', documentNumber: 'NOR12029618' },
    ],
    [
      'https://www.ris.bka.gv.at/eli/jgs/1811/946/P1/NOR12017691',
      { kind: 'consolidated', application: 'BrKons', documentNumber: 'NOR12017691' },
    ],
    [
      'https://ris.bka.gv.at/eli/bgbl/1978/565/A2P4/NOR12009176',
      { kind: 'consolidated', application: 'BrKons', documentNumber: 'NOR12009176' },
    ],
    // The reader reads the number; whether it exists is the search's question (#110).
    [
      'https://www.ris.bka.gv.at/eli/bgbl/1974/60/P75/NOR99999999',
      { kind: 'consolidated', application: 'BrKons', documentNumber: 'NOR99999999' },
    ],
    [
      'https://ogd.ris.bka.gv.at/eli/lgbl/NI/2018/13/P0/LNO40026933',
      { kind: 'consolidated', application: 'LrKons', documentNumber: 'LNO40026933' },
    ],
    // Niederösterreich's Gliederungszahl layout: five segments, like a gazette ELI.
    [
      'https://ris.bka.gv.at/eli/lgbl/NI/0824/A13/LNO40086080',
      { kind: 'consolidated', application: 'LrKons', documentNumber: 'LNO40086080' },
    ],
    [
      'https://ogd.ris.bka.gv.at/eli/lgbl/NI/0824/A13/LNO40086080',
      { kind: 'consolidated', application: 'LrKons', documentNumber: 'LNO40086080' },
    ],
    [
      'https://ogd.ris.bka.gv.at/eli/bgbl/II/2026/317/20261103',
      {
        kind: 'gazette',
        application: 'BgblAuth',
        documentNumber: 'BGBLA_2026_II_317',
        number: '317/2026',
        part: 'part2',
      },
    ],
    [
      'https://www.ris.bka.gv.at/eli/bgbl/II/2026/317/20261103',
      {
        kind: 'gazette',
        application: 'BgblAuth',
        documentNumber: 'BGBLA_2026_II_317',
        number: '317/2026',
        part: 'part2',
      },
    ],
    [
      'https://ogd.ris.bka.gv.at/eli/lgbl/SA/2026/103/20261104',
      {
        kind: 'gazette',
        application: 'LgblAuth',
        documentNumber: 'LGBLA_SA_20261104_103',
        number: '103/2026',
        state: 'salzburg',
      },
    ],
    [
      'https://ogd.ris.bka.gv.at/eli/lgbl/ka/2014/10/20140228',
      {
        kind: 'gazette',
        application: 'LgblAuth',
        documentNumber: 'LGBLA_KA_20140228_10',
        number: '10/2014',
        state: 'kaernten',
      },
    ],
  ])('reads %s', (link, expected) => {
    expect(readDocumentLink(link)).toStrictEqual(expected);
  });
});

describe('readDocumentLink — consolidated ELIs, read by their last segment', () => {
  // One record's ELI per gazette and era a consolidated path names, both levels of section.
  it.each([
    ['https://ogd.ris.bka.gv.at/eli/bgbl/1963/239/ANL1/NOR12044389', 'NOR12044389'],
    ['https://ogd.ris.bka.gv.at/eli/bgbl/1988/99/P19a/NOR12036595', 'NOR12036595'],
    ['https://ogd.ris.bka.gv.at/eli/bgbl/i/2004/58/A4P2/NOR40052795', 'NOR40052795'],
    ['https://ogd.ris.bka.gv.at/eli/bgbl/i/1999/165/A2P35j/NOR40262706', 'NOR40262706'],
    ['https://ogd.ris.bka.gv.at/eli/bgbl/ii/2020/390/ANL1/NOR40226325', 'NOR40226325'],
    ['https://ogd.ris.bka.gv.at/eli/bgbl/iii/2013/62/A1/NOR40148587', 'NOR40148587'],
    ['https://ogd.ris.bka.gv.at/eli/drgbl/i/1938/807/P0/NOR11001894', 'NOR11001894'],
    ['https://ogd.ris.bka.gv.at/eli/gbloe/1939/718/P0/NOR11009403', 'NOR11009403'],
    ['https://ogd.ris.bka.gv.at/eli/gvbltirvbg/1898/9/P0/NOR11001731', 'NOR11001731'],
    ['https://ogd.ris.bka.gv.at/eli/jmvbl/1885/5/P0/NOR11001711', 'NOR11001711'],
    ['https://ogd.ris.bka.gv.at/eli/lgvbltir/1922/77/P0/NOR11010407', 'NOR11010407'],
    ['https://ogd.ris.bka.gv.at/eli/rgbl/1895/113/P2a/NOR40205009', 'NOR40205009'],
    ['https://ogd.ris.bka.gv.at/eli/stgbl/1945/13/A1P3k/NOR40258114', 'NOR40258114'],
  ])('reads %s as BrKons', (link, documentNumber) => {
    expect(readDocumentLink(link)).toStrictEqual({
      kind: 'consolidated',
      application: 'BrKons',
      documentNumber,
    });
  });

  // Every state prefix, the federal and Staatsgesetzblatt layouts states use, and the Graz one.
  it.each([
    ['https://ogd.ris.bka.gv.at/eli/lgbl/BU/1999/42/ANL1/LBG40007012', 'LBG40007012'],
    ['https://ogd.ris.bka.gv.at/eli/lgbl/KA/1962/157/P19a/LKT40004008', 'LKT40004008'],
    ['https://ogd.ris.bka.gv.at/eli/lgbl/NI/7800/P24/LNO40010807', 'LNO40010807'],
    ['https://ogd.ris.bka.gv.at/eli/lgbl/OB/1956/37/P0/LOO11000032', 'LOO11000032'],
    ['https://ogd.ris.bka.gv.at/eli/lgbl/SA/1920/34/P0/LSB11000002', 'LSB11000002'],
    ['https://ogd.ris.bka.gv.at/eli/lgbl/ST/2013/9/P5a/LST40004965', 'LST40004965'],
    ['https://ogd.ris.bka.gv.at/eli/lgbl/TI/2011/133/ANL1/LTI40032643', 'LTI40032643'],
    ['https://ogd.ris.bka.gv.at/eli/lgbl/VO/2012/28/P0/LVB40006754', 'LVB40006754'],
    ['https://ogd.ris.bka.gv.at/eli/lgbl/WI/1995/50/ANL2/LWI40017528', 'LWI40017528'],
    ['https://ogd.ris.bka.gv.at/eli/bgbl/SA/1982/164/P0/LSB11000424', 'LSB11000424'],
    ['https://ogd.ris.bka.gv.at/eli/stgbl/SA/1919/388/P0/LSB11000001', 'LSB11000001'],
    ['https://ogd.ris.bka.gv.at/eli/gz_s/ST/2017/310/P0/LST40020988', 'LST40020988'],
  ])('reads %s as LrKons', (link, documentNumber) => {
    expect(readDocumentLink(link)).toStrictEqual({
      kind: 'consolidated',
      application: 'LrKons',
      documentNumber,
    });
  });

  it('tries the consolidated rows first, so a document number ends a gazette-shaped path', () => {
    expect(readDocumentLink('https://ris.bka.gv.at/eli/bgbl/II/2026/317/NOR40212006')).toEqual({
      kind: 'consolidated',
      application: 'BrKons',
      documentNumber: 'NOR40212006',
    });
  });

  it('reads the path alone, so a query or fragment on an ELI changes nothing', () => {
    expect(
      readDocumentLink(
        'https://ris.bka.gv.at/eli/bgbl/i/1999/165/A2P4/NOR40212006?Dokumentnummer=..%2Fx#P4',
      ),
    ).toEqual({ kind: 'consolidated', application: 'BrKons', documentNumber: 'NOR40212006' });
  });
});

describe('readDocumentLink — authentic gazette ELIs', () => {
  // Records' own ELIs; the last row writes the part in lowercase.
  it.each([
    ['bgbl/I/2026/102/20261105', 'BGBLA_2026_I_102', '102/2026', 'part1'],
    ['bgbl/II/2026/324/20261106', 'BGBLA_2026_II_324', '324/2026', 'part2'],
    ['bgbl/III/2026/141/20261013', 'BGBLA_2026_III_141', '141/2026', 'part3'],
    ['bgbl/iii/2026/141/20261013', 'BGBLA_2026_III_141', '141/2026', 'part3'],
  ])('reads /eli/%s as BgblAuth', (path, documentNumber, number, part) => {
    expect(readDocumentLink(`${OGD_ELI}/${path}`)).toStrictEqual({
      kind: 'gazette',
      application: 'BgblAuth',
      documentNumber,
      number,
      part,
    });
  });

  // Uppercase state codes on current records, lowercase on the first 2014–2015 ones.
  it.each([
    ['lgbl/BU/2026/76/20261109', 'LGBLA_BU_20261109_76', '76/2026', 'burgenland'],
    ['lgbl/KA/2026/71/20261105', 'LGBLA_KA_20261105_71', '71/2026', 'kaernten'],
    ['lgbl/NI/2026/52/20261109', 'LGBLA_NI_20261109_52', '52/2026', 'niederoesterreich'],
    ['lgbl/OB/2026/82/20261029', 'LGBLA_OB_20261029_82', '82/2026', 'oberoesterreich'],
    ['lgbl/SA/2026/106/20261106', 'LGBLA_SA_20261106_106', '106/2026', 'salzburg'],
    ['lgbl/ST/2026/97/20261106', 'LGBLA_ST_20261106_97', '97/2026', 'steiermark'],
    ['lgbl/TI/2026/88/20261105', 'LGBLA_TI_20261105_88', '88/2026', 'tirol'],
    ['lgbl/VO/2026/45/20261102', 'LGBLA_VO_20261102_45', '45/2026', 'vorarlberg'],
    ['lgbl/WI/2026/44/20261109', 'LGBLA_WI_20261109_44', '44/2026', 'wien'],
    ['lgbl/bu/2015/2/20150120', 'LGBLA_BU_20150120_2', '2/2015', 'burgenland'],
    ['lgbl/ni/2015/16/20150129', 'LGBLA_NI_20150129_16', '16/2015', 'niederoesterreich'],
    ['lgbl/ob/2015/9/20150130', 'LGBLA_OB_20150130_9', '9/2015', 'oberoesterreich'],
    ['lgbl/sa/2015/7/20150126', 'LGBLA_SA_20150126_7', '7/2015', 'salzburg'],
    ['lgbl/st/2014/21/20140224', 'LGBLA_ST_20140224_21', '21/2014', 'steiermark'],
    ['lgbl/ti/2014/10/20140226', 'LGBLA_TI_20140226_10', '10/2014', 'tirol'],
    ['lgbl/vo/2015/1/20150129', 'LGBLA_VO_20150129_1', '1/2015', 'vorarlberg'],
    ['lgbl/wi/2014/11/20140225', 'LGBLA_WI_20140225_11', '11/2014', 'wien'],
  ])('reads /eli/%s as LgblAuth', (path, documentNumber, number, state) => {
    expect(readDocumentLink(`${OGD_ELI}/${path}`)).toStrictEqual({
      kind: 'gazette',
      application: 'LgblAuth',
      documentNumber,
      number,
      state,
    });
  });

  it('pins the ELI code of each state — the codes LgblAuth records carry for that Bundesland', () => {
    expect(Object.fromEntries(RIS_STATES.map((state) => [state.eliCode, state.code]))).toEqual({
      BU: 'burgenland',
      KA: 'kaernten',
      NI: 'niederoesterreich',
      OB: 'oberoesterreich',
      SA: 'salzburg',
      ST: 'steiermark',
      TI: 'tirol',
      VO: 'vorarlberg',
      WI: 'wien',
    });
  });
});

describe('readDocumentLink — Dokument.wxe web views', () => {
  // Every application whose records carry a web view, its Abfrage as RIS writes it.
  it.each([
    ['AsylGH', 'AsylGH', 'ASYLGHT_20131211_B5_420_141_2_2012_00'],
    ['Avn', 'Avn', 'AVN_20261104_AVN_2026_25'],
    ['Avsv', 'Avsv', 'AVSV_2026_0068'],
    ['Begut', 'Begut', 'BEGUT_D62AC884_5254_42E5_A08C_C055CFAB6E1D'],
    ['BgblAlt', 'BgblAlt', 'glo1940_0049_00357'],
    ['BgblPdf', 'BgblPdf', '2003_146_1'],
    ['Bks', 'Bks', 'BKST_20131211_611001_0009_BKS_2013_00'],
    ['Bvb', 'Bvb', 'BVB_NI_MD_20261109_6'],
    ['Bvwg', 'Bvwg', 'BVWGT_20261104_W213_2295953_1_00'],
    ['Dok', 'Dok', 'DKT_BDB_20260929_2026_0_817_010_00'],
    ['Dsk', 'Dsk', 'DSBT_20260916_2026_0_690_562_00'],
    ['Erlaesse', 'Erlaesse', 'ERL_BMJ_20261030_2026_0_903_507_'],
    ['Erv', 'Erv', 'ERV_1962_235'],
    ['Gbk', 'Gbk', 'GBK_II_20260318_B_GBK_II_307_26'],
    ['Gemeinderecht', 'Gr', 'GEMRE_KA_20701_000__902__2020_me_'],
    ['GemeinderechtAuth', 'GrA', 'GEMREA_OB_41203_20261109_5'],
    ['Justiz', 'Justiz', 'JJR_20260325_OGH0002_0030OB00031_26V0000_000'],
    ['KmGer', 'KmGer', 'KMGER_LVWGTI_20260807_LVwG_102_123_2026'],
    ['Lgbl', 'Lgbl', 'LGBL_OB_20141231_126'],
    ['LgblNO', 'LgblNO', 'LRNI_2007006'],
    ['Lvwg', 'Lvwg', 'LVWGT_WI_20270702_VGW_101_070_875_2026_00'],
    ['Mrp', 'Mrp', 'MRP_20261109_69a'],
    ['Normenliste', 'Normenliste', 'NL00010020'],
    ['PruefGewO', 'PruefGewO', 'PRUEF_20260928_2026_0_688_713_BMWET_Gewerberecht_'],
    ['Pvak', 'Pvak', 'PVABT_20260521_B5_PVAB_26_00'],
    ['RegV', 'RegV', 'REGV_B2EE7D38_64A5_41E4_ACE4_398DC9E0A0DA'],
    ['Spg', 'Spg', 'SPG_AT_OSG_V_20261031_9_2026'],
    ['Ubas', 'Ubas', 'UBAST_20071126_227_475__0_21E_VIII_23_02_00'],
    ['Umse', 'Umse', 'UMSET_20131218_US_8B_2013_14_4_00'],
    ['Uvs', 'Uvs', 'JUT_VO_20010425_03202_00_00'],
    ['Vbl', 'Vbl', 'VBL_TI_LR_20261105_101'],
    ['Verg', 'Verg', 'VERGT_20131230_961040_13_00'],
    ['Vfgh', 'Vfgh', 'JFR_20261007_26E00850_01'],
    ['Vwgh', 'Vwgh', 'JWR_2024030029_20261014L01'],
  ])('reads Abfrage=%s as %s', (abfrage, application, documentNumber) => {
    expect(
      readDocumentLink(`${WEB_VIEW}?Abfrage=${abfrage}&Dokumentnummer=${documentNumber}`),
    ).toStrictEqual({ kind: 'web_view', application, documentNumber });
  });

  it('decodes the Dokumentnummer, as the Upts record writes its umlaut', () => {
    expect(
      readDocumentLink(
        `${WEB_VIEW}?Abfrage=Upts&Dokumentnummer=UPTS_20260427_2026_0_074_605_UPTS_Gr%c3%bcne`,
      ),
    ).toStrictEqual({
      kind: 'web_view',
      application: 'Upts',
      documentNumber: 'UPTS_20260427_2026_0_074_605_UPTS_Grüne',
    });
  });

  it('maps Bundesnormen and Landesnormen through the same History-feed names', () => {
    expect(readDocumentLink(`${WEB_VIEW}?Abfrage=Bundesnormen&Dokumentnummer=NOR40212006`)).toEqual(
      { kind: 'web_view', application: 'BrKons', documentNumber: 'NOR40212006' },
    );
    expect(readDocumentLink(`${WEB_VIEW}?Abfrage=Landesnormen&Dokumentnummer=LNO40026933`)).toEqual(
      { kind: 'web_view', application: 'LrKons', documentNumber: 'LNO40026933' },
    );
  });

  // ogd. answers Dokument.wxe with a 301 to the bare host, so a browser-copied view carries it.
  it('reads the #111 web views on ris.bka.gv.at, where a browser lands', () => {
    expect(
      readDocumentLink(
        'https://ris.bka.gv.at/Dokument.wxe?Abfrage=Vfgh&Dokumentnummer=JFR_20261007_26G00167_01',
      ),
    ).toStrictEqual({
      kind: 'web_view',
      application: 'Vfgh',
      documentNumber: 'JFR_20261007_26G00167_01',
    });
    expect(
      readDocumentLink(
        'https://ris.bka.gv.at/Dokument.wxe?Abfrage=Gemeinderecht&Dokumentnummer=GEMRE_KA_20701_000__902__2020_me_',
      ),
    ).toStrictEqual({
      kind: 'web_view',
      application: 'Gr',
      documentNumber: 'GEMRE_KA_20701_000__902__2020_me_',
    });
  });

  it('reads www., any parameter order, extra parameters, and a link in any host case', () => {
    const expected = {
      kind: 'web_view',
      application: 'Vfgh',
      documentNumber: 'JFR_20261007_26G00167_01',
    };
    for (const link of [
      'https://www.ris.bka.gv.at/Dokument.wxe?Abfrage=Vfgh&Dokumentnummer=JFR_20261007_26G00167_01',
      `${WEB_VIEW}?Dokumentnummer=JFR_20261007_26G00167_01&Abfrage=Vfgh`,
      `${WEB_VIEW}?Abfrage=Vfgh&Dokumentnummer=JFR_20261007_26G00167_01&Suchworte=Datenschutz`,
      'HTTPS://OGD.RIS.BKA.GV.AT/Dokument.wxe?Abfrage=Vfgh&Dokumentnummer=JFR_20261007_26G00167_01',
      ` ${WEB_VIEW}?Abfrage=Vfgh&Dokumentnummer=JFR_20261007_26G00167_01 `,
    ]) {
      expect(readDocumentLink(link), link).toStrictEqual(expected);
    }
  });
});

describe('readDocumentLink — http:// reads like https://, on the default port', () => {
  // Nothing is fetched from a link, and ogd. answers http with a redirect to https.
  it.each([
    'ris.bka.gv.at/eli/bgbl/1974/60/P75/NOR12029618',
    'www.ris.bka.gv.at/eli/bgbl/II/2026/317/20261103',
    'ogd.ris.bka.gv.at/eli/lgbl/SA/2026/103/20261104',
    'ogd.ris.bka.gv.at/eli/lgbl/NI/0824/A13/LNO40086080',
    'ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=Vfgh&Dokumentnummer=JFR_20261007_26G00167_01',
    'ris.bka.gv.at/Dokument.wxe?Abfrage=Gemeinderecht&Dokumentnummer=GEMRE_KA_20701_000__902__2020_me_',
    'www.ris.bka.gv.at/Dokument.wxe?Abfrage=Bundesnormen&Dokumentnummer=NOR40212006',
  ])('reads http://%s as its https form', (link) => {
    const https = readDocumentLink(`https://${link}`);
    expect(https).not.toBeNull();
    expect(https).not.toHaveProperty('error');
    expect(readDocumentLink(`http://${link}`)).toStrictEqual(https);
  });

  it('reads an explicit default port as no port', () => {
    const expected = {
      kind: 'gazette',
      application: 'BgblAuth',
      documentNumber: 'BGBLA_2026_II_317',
      number: '317/2026',
      part: 'part2',
    };
    expect(readDocumentLink('http://ogd.ris.bka.gv.at:80/eli/bgbl/II/2026/317/20261103')).toEqual(
      expected,
    );
    expect(readDocumentLink('https://ogd.ris.bka.gv.at:443/eli/bgbl/II/2026/317/20261103')).toEqual(
      expected,
    );
  });
});

describe('readDocumentLink — null: not an RIS ELI or web-view link', () => {
  it.each([
    'https://evil.example/eli/bgbl/1974/60/P75/NOR12029618',
    'https://ris.bka.gv.at.evil.example/eli/bgbl/1974/60/P75/NOR12029618',
    // A host that merely ends in an RIS hostname is another host.
    'https://evilris.bka.gv.at/eli/bgbl/1974/60/P75/NOR12029618',
    'https://www2.ris.bka.gv.at/Dokument.wxe?Abfrage=Vfgh&Dokumentnummer=JFR_20261007_26G00167_01',
    'https://data.bka.gv.at/eli/bgbl/1974/60/P75/NOR12029618',
    'https://evil.example/Dokument.wxe?Abfrage=Vfgh&Dokumentnummer=JFR_20261007_26G00167_01',
    'https://data.europa.eu/eli/reg/2016/679/oj',
    'https://ogd.ris.bka.gv.at/Dokumente/Bundesnormen/NOR40212006/NOR40212006.html',
    'https://ogd.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10001597',
    'https://ogd.ris.bka.gv.at/JudikaturEntscheidung.wxe?Abfrage=Vwgh&Dokumentnummer=JWR_2024030029_20261014L01',
    'https://ris.bka.gv.at/eli',
    'ris.bka.gv.at/eli/bgbl/i/1999/165/A2P4/NOR40212006',
    'NOR40212006',
    'BGBl. I Nr. 165/1999',
    '§ 6 DSG',
    '',
  ])('returns null for %j', (link) => {
    expect(readDocumentLink(link)).toBeNull();
  });
});

describe('readDocumentLink — { error }: an RIS link in a shape it does not read', () => {
  it.each([
    // #111's unsupported_url list
    [
      `${WEB_VIEW}?Abfrage=Gr&Dokumentnummer=GEMRE_KA_20701_000__902__2020_me_`,
      ABFRAGE_UNKNOWN_ERROR,
    ],
    [`${WEB_VIEW}?Abfrage=Foo&Dokumentnummer=X`, ABFRAGE_UNKNOWN_ERROR],
    [`${WEB_VIEW}?Abfrage=BrKons&Dokumentnummer=NOR40212006`, ABFRAGE_UNKNOWN_ERROR],
    [`${WEB_VIEW}?Abfrage=Vfgh`, DOKUMENTNUMMER_COUNT_ERROR],
    ['https://www.ris.bka.gv.at/eli/bgbl/i/1999/165', ELI_LAYOUT_ERROR],
    // the rest of the family: a port other than the scheme's default, or another scheme
    ['https://ris.bka.gv.at:8443/eli/bgbl/1974/60/P75/NOR12029618', ORIGIN_ERROR],
    [
      'https://ogd.ris.bka.gv.at:8443/Dokument.wxe?Abfrage=Vfgh&Dokumentnummer=JFR_20261007_26G00167_01',
      ORIGIN_ERROR,
    ],
    ['http://ris.bka.gv.at:443/eli/bgbl/1974/60/P75/NOR12029618', ORIGIN_ERROR],
    [
      'http://ris.bka.gv.at:8080/Dokument.wxe?Abfrage=Vfgh&Dokumentnummer=JFR_20261007_26G00167_01',
      ORIGIN_ERROR,
    ],
    ['ftp://ogd.ris.bka.gv.at/eli/bgbl/II/2026/317/20261103', ORIGIN_ERROR],
    [`${WEB_VIEW}?Dokumentnummer=JFR_20261007_26G00167_01`, ABFRAGE_COUNT_ERROR],
    [`${WEB_VIEW}?Abfrage=Vfgh&Abfrage=Vwgh&Dokumentnummer=X`, ABFRAGE_COUNT_ERROR],
    [`${WEB_VIEW}?Abfrage=Vfgh&Dokumentnummer=X&Dokumentnummer=Y`, DOKUMENTNUMMER_COUNT_ERROR],
    ['https://www.ris.bka.gv.at/eli/bgbl/i/1999/165/A2P4', ELI_LAYOUT_ERROR],
    ['https://www.ris.bka.gv.at/eli/bgbl/IV/2026/1/20260101', ELI_LAYOUT_ERROR],
    ['https://www.ris.bka.gv.at/eli/lgbl/XX/2026/1/20260101', ELI_LAYOUT_ERROR],
    ['https://www.ris.bka.gv.at/eli/bgbl/II/2026/317/2026110', ELI_LAYOUT_ERROR],
    ['https://www.ris.bka.gv.at/eli/bgbl/II/26/317/20261103', ELI_LAYOUT_ERROR],
    ['https://www.ris.bka.gv.at/eli/bgbl/II/2026/317/20261103/', ELI_LAYOUT_ERROR],
    ['https://www.ris.bka.gv.at/eli/bgbl/i/1999/165/A2P4/NOR40212006/', ELI_LAYOUT_ERROR],
    ['https://www.ris.bka.gv.at/eli/lgbl/NI/2018/13/P0/LXX40026933', ELI_LAYOUT_ERROR],
    ['https://www.ris.bka.gv.at/eli/', ELI_LAYOUT_ERROR],
  ])('refuses %s', (link, error) => {
    expect(readDocumentLink(link)).toStrictEqual({ error });
  });

  it('never echoes the link, so its userinfo and values stay out of the message', () => {
    const outcome = readDocumentLink(
      'https://user:hunter2@ogd.ris.bka.gv.at/Dokument.wxe?Abfrage=Vfgh&Dokumentnummer=..%2Fhunter2',
    );
    expect(outcome).toStrictEqual({ error: DOKUMENTNUMMER_INVALID_ERROR });
    expect(JSON.stringify(outcome)).not.toContain('hunter2');
  });
});

describe('readDocumentLink — a link cannot move the content path its number is built into', () => {
  // Each value is the decoded Dokumentnummer's raw form in the link.
  it.each([
    ['..', 'a parent segment'],
    ['.', 'a current segment'],
    ['%2e%2e', 'a percent-encoded parent segment'],
    ['%2E%2E', 'an uppercase percent-encoded parent segment'],
    ['.%2e', 'a half-encoded parent segment'],
    ['..%2FBundesnormen', 'a parent segment and a slash'],
    ['JFR%2F..%2FX', 'an encoded slash inside the number'],
    ['JFR_1%5C..', 'an encoded backslash'],
    ['JFR_1%3Fx%3D1', 'an encoded query'],
    ['JFR_1%23x', 'an encoded fragment'],
    ['JFR_1%26Abfrage%3DVwgh', 'an encoded parameter'],
    ['JFR%25%32%65', 'a double-encoded dot'],
    ['JFR_1+2', 'a space written as plus'],
    ['JFR_1%00', 'a NUL'],
    ['', 'an empty number'],
  ])('refuses Dokumentnummer=%s (%s)', (raw) => {
    expect(readDocumentLink(`${WEB_VIEW}?Abfrage=Vfgh&Dokumentnummer=${raw}`)).toStrictEqual({
      error: DOKUMENTNUMMER_INVALID_ERROR,
    });
  });

  it.each([
    'https://ris.bka.gv.at/eli/bgbl/1974/60/P75/NOR%31%32',
    'https://ris.bka.gv.at/eli/bgbl/1974/60/P75/NOR12029618%2F..',
    'https://ris.bka.gv.at/eli/bgbl/II/2026/%33%31%37/20261103',
    'https://ris.bka.gv.at/eli/lgbl/S%41/2026/103/20261104',
  ])('refuses the percent-encoded ELI segments of %s', (link) => {
    expect(readDocumentLink(link)).toStrictEqual({ error: ELI_LAYOUT_ERROR });
  });

  it('reads an ELI whose dot segments the URL resolves, still only to the digits it ends in', () => {
    expect(readDocumentLink('https://ris.bka.gv.at/eli/bgbl/%2e%2e/NOR40212006')).toEqual({
      kind: 'consolidated',
      application: 'BrKons',
      documentNumber: 'NOR40212006',
    });
  });
});

describe('readDocumentLink — time on adversarial links', () => {
  const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000];
  /** Bound on one call at 320,000 characters; linear work there takes about a millisecond. */
  const BOUND_MS = 50;

  /** Thread-CPU milliseconds of one call, the fastest of three samples of ≥ 10 ms each. */
  function cpuMs(run: () => void): number {
    let best = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 3; sample++) {
      const start = process.threadCpuUsage();
      let runs = 0;
      let ms = 0;
      do {
        run();
        runs++;
        const { user, system } = process.threadCpuUsage(start);
        ms = (user + system) / 1_000;
      } while (ms < 10);
      best = Math.min(best, ms / runs);
    }
    return best;
  }

  /** Where a link ended: its error, or the arm and application it read as. */
  function route(link: string): string {
    const outcome = readDocumentLink(link);
    if (outcome === null) return 'null';
    return 'error' in outcome ? outcome.error : `${outcome.kind} ${outcome.application}`;
  }

  // Every size must end on the stated route, so a size that turned fast by taking another
  // one fails rather than passing.
  it.each<[string, (size: number) => string, string]>([
    [
      'a long digit run in an ELI’s last segment',
      (size) => `https://ris.bka.gv.at/eli/bgbl/NOR${'1'.repeat(size)}x`,
      ELI_LAYOUT_ERROR,
    ],
    [
      'a long gazette number before a short date',
      (size) => `https://ris.bka.gv.at/eli/bgbl/II/2026/${'1'.repeat(size)}/2026110`,
      ELI_LAYOUT_ERROR,
    ],
    [
      'a long run of ELI segments',
      (size) => `https://ris.bka.gv.at/eli/${'1/'.repeat(size / 2)}x`,
      ELI_LAYOUT_ERROR,
    ],
    [
      'a long valid Dokumentnummer',
      (size) => `${WEB_VIEW}?Abfrage=Vfgh&Dokumentnummer=${'Aä_1'.repeat(size / 4)}`,
      'web_view Vfgh',
    ],
    [
      'a long Dokumentnummer ending in a slash',
      (size) => `${WEB_VIEW}?Abfrage=Vfgh&Dokumentnummer=${'A'.repeat(size)}%2F`,
      DOKUMENTNUMMER_INVALID_ERROR,
    ],
    [
      'a long run of Dokumentnummer parameters',
      (size) => `${WEB_VIEW}?Abfrage=Vfgh${'&Dokumentnummer=A'.repeat(size / 16)}`,
      DOKUMENTNUMMER_COUNT_ERROR,
    ],
    [
      'one long line ending in a break',
      (size) =>
        `${WEB_VIEW}?Abfrage=Vfgh&Dokumentnummer=${encodeURIComponent(`${'§1 x'.repeat(size / 4)}\ny`)}`,
      DOKUMENTNUMMER_INVALID_ERROR,
    ],
    [
      'line breaks throughout',
      (size) => `https://ris.bka.gv.at/eli/${'  \r\n'.repeat(size / 4)}NOR1`,
      ELI_LAYOUT_ERROR,
    ],
  ])('stays linear on %s', (_shape, make, expected) => {
    const times: number[] = [];
    for (const size of SIZES) {
      const link = make(size);
      expect(route(link), `${size} characters`).toBe(expected);
      const ms = cpuMs(() => readDocumentLink(link));
      expect(ms, `${size} characters`).toBeLessThan(BOUND_MS);
      times.push(ms);
    }
    expect((times.at(-1) ?? 0) / (times[0] ?? 1)).toBeLessThan(256);
  });
});
