/**
 * @fileoverview Bezirksverwaltungsbehörden (district administrative authorities) accepted by
 * the Bvb `Bezirksverwaltungsbehoerde` filter (exact match). Harvested from the complete live
 * Bvb corpus (2,433 documents, 2026-07-05); superset of the OGD Handbook V2.6 list.
 * @module services/ris/reference/district-authorities
 */

/** One district administrative authority as spelled in RIS Bvb documents. */
export interface DistrictAuthority {
  /** Bezirkshauptmannschaft vs. Statutarstadt (statutory city acting as district authority). */
  readonly kind: 'district_commission' | 'statutory_city';
  /** Exact filter value for the Bvb `Bezirksverwaltungsbehoerde` parameter. */
  readonly name: string;
  /** Bundesland the authority belongs to (umlauted spelling, as in Bvb metadata). */
  readonly state: string;
}

/** All district authorities observed in the RIS Bvb corpus. */
export const RIS_DISTRICT_AUTHORITIES = [
  {
    name: 'Bezirkshauptmannschaft Eisenstadt-Umgebung',
    state: 'Burgenland',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Güssing', state: 'Burgenland', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Jennersdorf', state: 'Burgenland', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Mattersburg', state: 'Burgenland', kind: 'district_commission' },
  {
    name: 'Bezirkshauptmannschaft Neusiedl am See',
    state: 'Burgenland',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Oberpullendorf',
    state: 'Burgenland',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Oberwart', state: 'Burgenland', kind: 'district_commission' },
  {
    name: 'Bezirkshauptmannschaft Amstetten',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Baden', state: 'Niederösterreich', kind: 'district_commission' },
  {
    name: 'Bezirkshauptmannschaft Bruck an der Leitha',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Gänserndorf',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Gmünd', state: 'Niederösterreich', kind: 'district_commission' },
  {
    name: 'Bezirkshauptmannschaft Hollabrunn',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Horn', state: 'Niederösterreich', kind: 'district_commission' },
  {
    name: 'Bezirkshauptmannschaft Korneuburg',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Krems an der Donau',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Lilienfeld',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Melk', state: 'Niederösterreich', kind: 'district_commission' },
  {
    name: 'Bezirkshauptmannschaft Mistelbach',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Mödling',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Neunkirchen',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Scheibbs',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft St. Pölten',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Tulln', state: 'Niederösterreich', kind: 'district_commission' },
  {
    name: 'Bezirkshauptmannschaft Waidhofen an der Thaya',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Wiener Neustadt',
    state: 'Niederösterreich',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Zwettl', state: 'Niederösterreich', kind: 'district_commission' },
  { name: 'Statutarstadt Krems an der Donau', state: 'Niederösterreich', kind: 'statutory_city' },
  { name: 'Statutarstadt St. Pölten', state: 'Niederösterreich', kind: 'statutory_city' },
  {
    name: 'Statutarstadt Waidhofen an der Ybbs',
    state: 'Niederösterreich',
    kind: 'statutory_city',
  },
  { name: 'Statutarstadt Wr. Neustadt', state: 'Niederösterreich', kind: 'statutory_city' },
  { name: 'Bezirkshauptmannschaft Braunau', state: 'Oberösterreich', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Eferding', state: 'Oberösterreich', kind: 'district_commission' },
  {
    name: 'Bezirkshauptmannschaft Freistadt',
    state: 'Oberösterreich',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Gmunden', state: 'Oberösterreich', kind: 'district_commission' },
  {
    name: 'Bezirkshauptmannschaft Grieskirchen',
    state: 'Oberösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Kirchdorf',
    state: 'Oberösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Linz-Land',
    state: 'Oberösterreich',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Perg', state: 'Oberösterreich', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Ried', state: 'Oberösterreich', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Rohrbach', state: 'Oberösterreich', kind: 'district_commission' },
  {
    name: 'Bezirkshauptmannschaft Schärding',
    state: 'Oberösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Steyr-Land',
    state: 'Oberösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Urfahr-Umgebung',
    state: 'Oberösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Vöcklabruck',
    state: 'Oberösterreich',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Wels-Land',
    state: 'Oberösterreich',
    kind: 'district_commission',
  },
  { name: 'Statutarstadt Linz', state: 'Oberösterreich', kind: 'statutory_city' },
  { name: 'Statutarstadt Steyr', state: 'Oberösterreich', kind: 'statutory_city' },
  { name: 'Statutarstadt Wels', state: 'Oberösterreich', kind: 'statutory_city' },
  {
    name: 'Bezirkshauptmannschaft Bruck-Mürzzuschlag',
    state: 'Steiermark',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Deutschlandsberg',
    state: 'Steiermark',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Graz-Umgebung',
    state: 'Steiermark',
    kind: 'district_commission',
  },
  {
    name: 'Bezirkshauptmannschaft Hartberg-Fürstenfeld',
    state: 'Steiermark',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Leibnitz', state: 'Steiermark', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Leoben', state: 'Steiermark', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Liezen', state: 'Steiermark', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Murau', state: 'Steiermark', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Murtal', state: 'Steiermark', kind: 'district_commission' },
  {
    name: 'Bezirkshauptmannschaft Südoststeiermark',
    state: 'Steiermark',
    kind: 'district_commission',
  },
  { name: 'Bezirkshauptmannschaft Voitsberg', state: 'Steiermark', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Weiz', state: 'Steiermark', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Imst', state: 'Tirol', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Innsbruck', state: 'Tirol', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Kitzbühel', state: 'Tirol', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Kufstein', state: 'Tirol', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Landeck', state: 'Tirol', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Lienz', state: 'Tirol', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Reutte', state: 'Tirol', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Schwaz', state: 'Tirol', kind: 'district_commission' },
  { name: 'Statutarstadt Innsbruck', state: 'Tirol', kind: 'statutory_city' },
  { name: 'Bezirkshauptmannschaft Bludenz', state: 'Vorarlberg', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Bregenz', state: 'Vorarlberg', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Dornbirn', state: 'Vorarlberg', kind: 'district_commission' },
  { name: 'Bezirkshauptmannschaft Feldkirch', state: 'Vorarlberg', kind: 'district_commission' },
] as const satisfies readonly DistrictAuthority[];
