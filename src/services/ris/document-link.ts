/**
 * @fileoverview Reads the links RIS records carry as `eli` and `document_url` — an ELI
 * (European Legislation Identifier) or a `Dokument.wxe` web view — into the one document each
 * names: its application and document number. Nothing is fetched from the link: `ogd.` answers
 * an `/eli/` path with a redirect to `ris.bka.gv.at`, which serves automated clients a
 * bot-check page, so callers resolve the pair through the API and the configured content host.
 * Grounded in 6,104 links on 4,757 records across all 39 applications (2026-11-09): BrKons,
 * LrKons, BgblAuth, and LgblAuth carry an ELI in both fields, and the other 35 a `Dokument.wxe`
 * `document_url`; every link read back to its record's own application and document number.
 * Also the document-number shape the content-URL builder checks, so a number read from a link
 * and one a caller passes meet the same test.
 * @module services/ris/document-link
 */

import { RIS_APPLICATIONS } from './reference/applications.js';
import { RIS_STATES } from './reference/states.js';
import type { RisStateCode } from './request-builder.js';

type RisApplicationCode = (typeof RIS_APPLICATIONS)[number]['code'];

/** Document numbers observed live use letters (incl. umlauts), digits, `_`, `.`, `~`, `-`. */
const DOCUMENT_NUMBER_PATTERN = /^[\p{L}\p{N}_.~-]+$/u;

/**
 * Whether `value` has the shape of an RIS document number: only the characters observed live,
 * and never a dot segment, since the number is one whole path segment of the content URL.
 */
export function isDocumentNumber(value: string): boolean {
  return DOCUMENT_NUMBER_PATTERN.test(value) && value !== '.' && value !== '..';
}

/** The one document a link names. */
export type DocumentLink =
  | {
      readonly kind: 'consolidated';
      readonly application: 'BrKons' | 'LrKons';
      readonly documentNumber: string;
    }
  | {
      readonly kind: 'gazette';
      readonly application: 'BgblAuth';
      readonly documentNumber: string;
      /** The gazette number as `{n}/{yyyy}`. */
      readonly number: string;
      readonly part: 'part1' | 'part2' | 'part3';
    }
  | {
      readonly kind: 'gazette';
      readonly application: 'LgblAuth';
      readonly documentNumber: string;
      /** The gazette number as `{n}/{yyyy}`. */
      readonly number: string;
      readonly state: RisStateCode;
    }
  | {
      readonly kind: 'web_view';
      readonly application: RisApplicationCode;
      readonly documentNumber: string;
    };

/**
 * Hosts whose `/eli/` and `/Dokument.wxe` links are in the family, read or refused. Records
 * carry `eli` on `www.` or bare `ris.` and `document_url` on `ogd.`, and `ogd.` redirects
 * `Dokument.wxe` to bare `ris.`, where a browser-copied view lands.
 */
const RIS_HOSTNAMES = new Set(['ris.bka.gv.at', 'www.ris.bka.gv.at', 'ogd.ris.bka.gv.at']);

/**
 * Origins a link is read on: each host over https or http, on the scheme's default port (the URL
 * parser drops an explicit `:443` or `:80` from the origin). `http://` reads like `https://`
 * because nothing is fetched from the link, and `ogd.` redirects `http` to `https` itself.
 */
const LINK_ORIGINS = new Set(
  [...RIS_HOSTNAMES].flatMap((host) => [`https://${host}`, `http://${host}`]),
);

/**
 * A consolidated provision's document number, which every consolidated ELI ends in whatever
 * gazette and era the path before it names. State numbers open with `L` and the state's own
 * abbreviation, which is not its ELI code (`LBG…` for Burgenland, whose ELI code is BU).
 */
const FEDERAL_CONSOLIDATED_NUMBER = /^NOR\d+$/;
const STATE_CONSOLIDATED_NUMBER = /^L(?:BG|KT|NO|OO|SB|ST|TI|VB|WI)\d+$/;

/** An authentic gazette's ELI after `/eli/`: series, part or state, year, number, date. */
const FEDERAL_GAZETTE_ELI = /^bgbl\/(i{1,3})\/(\d{4})\/(\d+)\/\d{8}$/i;
const STATE_GAZETTE_ELI = /^lgbl\/([a-z]{2})\/(\d{4})\/(\d+)\/(\d{8})$/i;

const STATES_BY_ELI_CODE = new Map<string, (typeof RIS_STATES)[number]>(
  RIS_STATES.map((state) => [state.eliCode, state]),
);

/** A web view names its application by the History-feed name, which is the code for all but four. */
const APPLICATIONS_BY_WEB_NAME = new Map<string, RisApplicationCode>(
  RIS_APPLICATIONS.map((app) => [app.historyName, app.code]),
);
const RENAMED_APPLICATIONS = new Intl.ListFormat('en').format(
  RIS_APPLICATIONS.filter((app) => app.historyName !== app.code).map(
    (app) => `${app.historyName} for ${app.code}`,
  ),
);

const ORIGIN_ERROR = `RIS links are read only from ${new Intl.ListFormat('en', { type: 'disjunction' }).format(RIS_HOSTNAMES)}, over https or http on the default port.`;
const ELI_LAYOUT_ERROR = `The ELI is not one of the layouts read: a consolidated provision's ELI, which ends in its document number (NOR… federal; LBG…, LKT…, LNO…, LOO…, LSB…, LST…, LTI…, LVB…, or LWI… state), /eli/bgbl/{I|II|III}/{year}/{number}/{yyyymmdd}, and /eli/lgbl/{${RIS_STATES.map((state) => state.eliCode).join('|')}}/{year}/{number}/{yyyymmdd}.`;
const ABFRAGE_COUNT_ERROR =
  'The Dokument.wxe link must carry exactly one Abfrage, the parameter naming its application.';
const ABFRAGE_UNKNOWN_ERROR = `The Dokument.wxe link's Abfrage names no RIS application: a web view names an application by its code, except ${RENAMED_APPLICATIONS}.`;
const DOKUMENTNUMMER_COUNT_ERROR = 'The Dokument.wxe link must carry exactly one Dokumentnummer.';
const DOKUMENTNUMMER_INVALID_ERROR =
  "The Dokument.wxe link's Dokumentnummer is not a valid RIS document number.";

/**
 * Read an RIS link into the document it names, without fetching it.
 *
 * - `null`: not an `/eli/` or `/Dokument.wxe` link on `ris.bka.gv.at`, `www.ris.bka.gv.at`, or
 *   `ogd.ris.bka.gv.at` — another host, a `/Dokumente/` rendition URL, another `.wxe` view, or
 *   no URL at all.
 * - `{ error }`: one of those links in a shape this reader does not read; `error` names the
 *   cause and never echoes the link.
 * - Otherwise the document. A web view's `Dokumentnummer` passes {@link isDocumentNumber}, the
 *   check a `document_number` meets, so it cannot move the content path the caller builds from
 *   it; an ELI's number is built from the path's own digits.
 */
export function readDocumentLink(url: string): DocumentLink | { error: string } | null {
  const link = URL.parse(url);
  if (link === null || !RIS_HOSTNAMES.has(link.hostname)) return null;
  const isEli = link.pathname.startsWith('/eli/');
  if (!isEli && link.pathname !== '/Dokument.wxe') return null;
  if (!LINK_ORIGINS.has(link.origin)) return { error: ORIGIN_ERROR };
  return isEli ? readEli(link.pathname.slice('/eli/'.length)) : readWebView(link.searchParams);
}

/** Read the path after `/eli/`, trying the layouts in order. */
function readEli(path: string): DocumentLink | { error: string } {
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (FEDERAL_CONSOLIDATED_NUMBER.test(last)) {
    return { kind: 'consolidated', application: 'BrKons', documentNumber: last };
  }
  if (STATE_CONSOLIDATED_NUMBER.test(last)) {
    return { kind: 'consolidated', application: 'LrKons', documentNumber: last };
  }

  const [, roman, federalYear, federalNumber] = FEDERAL_GAZETTE_ELI.exec(path) ?? [];
  if (roman !== undefined && federalYear !== undefined && federalNumber !== undefined) {
    return {
      kind: 'gazette',
      application: 'BgblAuth',
      documentNumber: `BGBLA_${federalYear}_${roman.toUpperCase()}_${federalNumber}`,
      number: `${federalNumber}/${federalYear}`,
      part: roman.length === 1 ? 'part1' : roman.length === 2 ? 'part2' : 'part3',
    };
  }

  const [, eliCode, stateYear, stateNumber, date] = STATE_GAZETTE_ELI.exec(path) ?? [];
  const state = eliCode === undefined ? undefined : STATES_BY_ELI_CODE.get(eliCode.toUpperCase());
  if (
    state !== undefined &&
    stateYear !== undefined &&
    stateNumber !== undefined &&
    date !== undefined
  ) {
    return {
      kind: 'gazette',
      application: 'LgblAuth',
      documentNumber: `LGBLA_${state.eliCode}_${date}_${stateNumber}`,
      number: `${stateNumber}/${stateYear}`,
      state: state.code,
    };
  }
  return { error: ELI_LAYOUT_ERROR };
}

/** Read a `Dokument.wxe` query: one `Abfrage` naming the application, one `Dokumentnummer`. */
function readWebView(params: URLSearchParams): DocumentLink | { error: string } {
  const [webName, ...extraWebNames] = params.getAll('Abfrage');
  if (webName === undefined || extraWebNames.length > 0) return { error: ABFRAGE_COUNT_ERROR };
  const application = APPLICATIONS_BY_WEB_NAME.get(webName);
  if (application === undefined) return { error: ABFRAGE_UNKNOWN_ERROR };

  const [documentNumber, ...extraNumbers] = params.getAll('Dokumentnummer');
  if (documentNumber === undefined || extraNumbers.length > 0) {
    return { error: DOKUMENTNUMMER_COUNT_ERROR };
  }
  // URLSearchParams has already decoded every escape, so this judges the value the content
  // path is built from.
  if (!isDocumentNumber(documentNumber)) return { error: DOKUMENTNUMMER_INVALID_ERROR };
  return { kind: 'web_view', application, documentNumber };
}
