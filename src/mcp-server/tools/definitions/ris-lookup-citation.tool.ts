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

import { foldStateNames, isoDateString } from './_shared.js';
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

/**
 * Line breaks inside a citation (one copied across a wrapped line), read as a space before any
 * parsing. Several parsers end on `.*$`, and `.` stops at a line break, so a citation carrying
 * one made them rescan the rest of it from every position tried — quadratic in its length.
 */
const LINE_BREAKS = /[\n\r\p{Zl}\p{Zp}]+/gu;

/** Gazette prefixes that signal a promulgation citation (federal, imperial, or state). */
const GAZETTE_PREFIX = /\b(?:BGBl|RGBl|StGBl|LGBl)\b|GBl[ÖO]/i;
/** A letter, optionally after an ordinal — digits and a dot ("1. COVID-19-JuBG", "7.ZPMRK"). */
const ORDINAL_LED_WORD = String.raw`(?:\d+\.\s?)?[A-Za-zÄÖÜäöüß]`;
/**
 * The start of a law abbreviation: a letter, optionally after an ordinal. Only an ordinal may
 * lead, so a bare number or case number never reads as a law, and an ordinal before a whole
 * month name is a date ("12. Mai", "3.Juli 2020"), never a law either. A month that runs on
 * into a longer or hyphenated word is part of a title ("1. Mai-Gesetz").
 */
const ABBREVIATION_START = String.raw`(?!\d+\.\s?(?:Jänner|Januar|Feber|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)(?![A-Za-zÄÖÜäöüß-]))${ORDINAL_LED_WORD}`;
/**
 * A bare law abbreviation or short title (whole-law reference) — words joined by spaces or
 * hyphens, an optional trailing year. A hyphen may end a word before "und", as German suspends
 * it ("Steuer- und Zollkoordination 2004").
 */
const BARE_ABBREVIATION = new RegExp(
  String.raw`^${ABBREVIATION_START}[A-Za-zÄÖÜäöüß.]*(?:(?:-\s(?=und\s)|[-\s])[A-Za-zÄÖÜäöüß0-9]+)*$`,
);
/**
 * A §/Artikel number: digits and a letter suffix, written compact in either case ("3a",
 * "1330A") or after a space in lowercase only ("448 b"). A spaced capital is the next token —
 * "Z" opening "Z 2", or an OGH index letter ("ABGB §1330 A") — never part of the number.
 */
const SECTION_NUMBER = String.raw`\d+(?:[a-zA-Z]|\s[a-z])?`;
/** The Artikel keyword, matched case-insensitively letter by letter so the rest keeps its case. */
const ARTIKEL = String.raw`[Aa][Rr][Tt](?:[Ii][Kk][Ee][Ll])?\.?`;
/** A parenthesized Absatz ("(1)", "(1a)"), as legal writing and EU cites write it. */
const PAREN_ABSATZ = String.raw`\(\d+[a-z]?\)`;
/**
 * A sub-provision token (Absatz, Ziffer, litera, Satz) — never a law abbreviation. Abs and Satz
 * match in any case ("Art6 abs1"); Z and lit only as RIS writes them, so a law named "LitG" or
 * "ZPO" is not caught.
 */
const SUB_PROVISION_TOKEN = String.raw`(?:[Aa][Bb][Ss]\.?\s*\d+[a-z]?|Z\.?\s*\d+[a-z]?|lit\.?\s*[a-z]{1,2}|[Ss][Aa][Tt][Zz]\s*\d+|${PAREN_ABSATZ})`;
/** A sub-provision token on its own. */
const SUB_PROVISION = new RegExp(`^${SUB_PROVISION_TOKEN}$`);
/**
 * A §/Artikel number with no law — nothing after it but sub-provisions and a terminal "." or ","
 * ("Art6 Abs1", "§ 6 Abs 1 Z 3", "Art6(1)", "§ 6"). The sub-provision tokens keep their own case
 * rules. Group 1 is set for a § section.
 */
const SECTION_ONLY = new RegExp(
  String.raw`^(?:(§)§*|${ARTIKEL})\s*(\d+(?:\s?[a-zA-Z])?)(?:\s*${SUB_PROVISION_TOKEN})*[.,]?\s*$`,
);
/** The EU recital marker (Erwägungsgrund, abbreviated ErwGr) as a regex source, matched with `i`. */
const RECITAL_MARKER = String.raw`(?:erwgr|erwägungsgrund|erwaegungsgrund)\.?\s*(\d+)`;
/**
 * An explicit norm citation — a section sign, or an Artikel keyword or EU recital marker
 * (ErwGr / Erwägungsgrund) followed by a number.
 */
const NORM_EXPLICIT = new RegExp(String.raw`§|\bart(?:ikel)?\.?\s*\d|\b${RECITAL_MARKER}`, 'i');
/** A recital cited with no act ("Erwägungsgrund 47"). Group 1 is the recital number. */
const RECITAL_ONLY = new RegExp(`^${RECITAL_MARKER}$`, 'i');
/** A section-first recital cite ("ErwGr 47 DSGVO"): group 1 the number, group 2 the act. */
const RECITAL_FIRST = new RegExp(String.raw`^${RECITAL_MARKER}\s+(\S.*)$`, 'i');
/** An abbreviation-first recital cite ("DSGVO ErwGr47"): group 1 the act, group 2 the number. */
const RECITAL_AFTER = new RegExp(
  String.raw`^(${ABBREVIATION_START}(?:.*?\S)?)\s+${RECITAL_MARKER}(?:\s+\S.*)?$`,
  'i',
);
/**
 * A comma that opens another provision of the same law — VfGH headnotes cite several in one
 * entry ("DSG §1, §24"). Only a comma followed by a §/Artikel number splits, so a comma that is
 * part of a title stays in the abbreviation.
 */
const PROVISION_COMMA = /,\s*(?=§+\s*\d|art(?:ikel)?\.?\s*\d)/i;
/**
 * A ". " that may open another full norm — OGH (Justiz) headnotes join several, each naming its
 * own law ("ZPO §179. ZPO §275 Abs2"). Only before the start of an abbreviation, and never after
 * a sub-provision or Artikel keyword ("Abs. 1", "lit. a", "Art. 7"), whose value follows it. A
 * Satz is written "Satz 2" or "2. Satz", so a ". " ends one ("EO §85 Abs2 2. Satz. EO §86") but
 * never opens one, ordinal or not: the Satz is still part of the norm before it. A number after
 * "idF" (or "idF der" / "idF des") is the ordinal of the amending act it names ("MRG §16 Abs1
 * idF 3. WÄG Art 2"), never the end of a norm. The idF check sits after the "." so it runs only
 * at a ".", scanning back over that one digit run. A date after a ". " still splits off ("ZPO §1.
 * 12. Mai §2"), so the norm before it resolves and the date part is named as written.
 */
const NORM_SEPARATOR = new RegExp(
  String.raw`(?<!\b(?:[Aa][Bb][Ss]|Z|lit|[Aa][Rr][Tt](?:[Ii][Kk][Ee][Ll])?))\.(?<!\bidF\s+(?:de[rs]\s+)?\d+\.)\s+(?=${ORDINAL_LED_WORD})(?!(?:\d+\.\s?)?[Ss][Aa][Tt][Zz](?![A-Za-zÄÖÜäöüß]))`,
  'g',
);
/** A §/Artikel number after a law's name — what makes a part of a ". "-joined entry a norm. */
const PROVISION_AFTER_LAW = new RegExp(String.raw`\s(?:§+|${ARTIKEL})\s*\d`);
/**
 * A leading CELEX number — VwGH prefixes an EU norm with it ("32016R0679 DSGVO Art6 Abs1"):
 * sector digit, year, act-type letters, then the number or the "/TXT" a treaty text carries.
 */
const LEADING_CELEX = /^([1-9]\d{4}[A-Z]{1,2}(?:\d+[A-Z]?|\/TXT))\s+(\S.*)$/;
/**
 * A sector-1 TFEU (E) or TEU (M) CELEX, of one article ("12010E267") or the whole treaty
 * ("12012E/TXT") — RIS consolidates both treaties. Only from 2008, the first post-Lisbon
 * consolidation: an earlier E or M CELEX ("11997E175") names the EC Treaty or a pre-Lisbon TEU,
 * whose articles RIS does not hold.
 */
const TREATY_CELEX = /^120(?:0[89]|[1-9]\d)[EM](?:\d|\/TXT$)/;
/** The CELEX sector of EU case law ("62014CJ0362") — a court decision, never an act. */
const CASE_LAW_SECTOR = '6';
/**
 * The EU court a case-law CELEX names, by the first letter of its document type ("CJ", "TJ") —
 * `norms_cited` carries judgments of both courts this way.
 */
const EU_COURT_BY_LETTER = new Map([
  ['C', 'the Court of Justice of the European Union'],
  ['T', 'the General Court of the European Union'],
]);

/** An EU act RIS does not consolidate. */
interface EuAct {
  /** The act as named in guidance. */
  readonly act: string;
  /** Absent when the abbreviation names more than one act. */
  readonly celex?: string;
}

const CHARTER: EuAct = {
  act: 'the Charter of Fundamental Rights of the European Union',
  celex: '12016P/TXT',
};
/** Renumbered at Amsterdam and consolidated several times, so no one CELEX names it. */
const EC_TREATY: EuAct = { act: 'the Treaty establishing the European Community (EC Treaty)' };

/**
 * EU acts cited by an abbreviation RIS consolidated law does not hold, keyed by the abbreviation
 * as compared (`comparableAbbreviation`: case-insensitive, whitespace collapsed) — matched exactly,
 * so an Austrian abbreviation that only starts with "EU" ("EU-JZG") is never caught. Derived
 * 2026-10-24 from `norms_cited` across dsk, bvwg, vwgh, vfgh, and justiz (OGH headnotes): each
 * abbreviation returned found: false when looked up live with an Artikel, and each CELEX resolves
 * on EUR-Lex. AEUV, EUV, and EMRK are absent on purpose — RIS consolidates all three. EG and
 * EGV (the EC Treaty) hold no RIS law of that abbreviation: a title search for "EG" matched EC
 * agreements with third countries instead (2026-10-24).
 */
const EU_ACTS: ReadonlyMap<string, EuAct> = new Map([
  ['dsgvo', { act: 'Regulation (EU) 2016/679', celex: '32016R0679' }],
  ['eg', EC_TREATY],
  ['egv', EC_TREATY],
  ['grc', CHARTER],
  ['eu-grc', CHARTER],
  ['eu-grundrechte-charta', CHARTER],
  ['eugvvo 2012', { act: 'Regulation (EU) No 1215/2012', celex: '32012R1215' }],
  [
    'eugvvo',
    {
      act: 'Regulation (EC) No 44/2001 or Regulation (EU) No 1215/2012, which courts both cite as EuGVVO',
    },
  ],
  ['euinsvo 2015', { act: 'Regulation (EU) 2015/848', celex: '32015R0848' }],
  ['euuvo', { act: 'Regulation (EC) No 4/2009', celex: '32009R0004' }],
]);

/** The EU act an abbreviation names, if it is one RIS does not consolidate. */
function euActOf(abbreviation: string): EuAct | undefined {
  return EU_ACTS.get(comparableAbbreviation(abbreviation));
}

/** A citation split from the CELEX number it leads with, when it leads with one. */
function splitLeadingCelex(citation: string): { celex: string; rest: string } | null {
  const match = LEADING_CELEX.exec(citation);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { celex: match[1], rest: match[2] };
}

/**
 * A citation without its trailing "allg" (allgemein — a reference to the act as a whole), when it
 * follows a bare abbreviation: Justiz (OGH) headnotes cite "DSGVO allg", "KO allg", "AHVB 1986
 * allg". Lowercase only: a law's own "Allg" is capitalized ("Allg GAG", "GdO Allg Krnt 1998") and
 * no abbreviation ends in it. A cite with a section ("StGB §28 allg") is left to its own parse.
 */
function dropGeneralReference(citation: string): string {
  if (!citation.endsWith('allg') || !/\s/.test(citation.charAt(citation.length - 5))) {
    return citation;
  }
  const head = citation.slice(0, -4).trimEnd();
  return BARE_ABBREVIATION.test(head) && !head.includes('/') && !NORM_EXPLICIT.test(head)
    ? head
    : citation;
}

/** Parsed norm citation. */
interface NormParse {
  readonly abbreviation: string;
  /**
   * The other provisions of a comma-joined entry, each as its own cite ("DSG §24" from
   * "DSG §1, §24"), and the other norms of a ". "-joined one as written ("ZPO §275 Abs2" from
   * "ZPO §179. ZPO §275 Abs2"). Absent for a single provision.
   */
  readonly others?: readonly string[];
  /** The recital number of an EU recital cite ("47" from "DSGVO ErwGr47"); no section then. */
  readonly recital?: string;
  readonly section?: string;
  readonly sectionType?: 'Artikel' | 'Paragraph';
}

/** The marker RIS cites a section with — "Art" for an Artikel, "§" otherwise. */
function sectionMarker(sectionType: NormParse['sectionType']): string {
  return sectionType === 'Artikel' ? 'Art' : '§';
}

/**
 * A citation without the ";" ending it — every VwGH `norms_cited` entry of the 1990s and 2000s
 * ends in one ("AbgEO §53;"). Only the last character: a ";" elsewhere is left to the parse.
 */
function dropTerminalSemicolon(citation: string): string {
  return citation.endsWith(';') ? citation.slice(0, -1).trimEnd() : citation;
}

/**
 * What may follow an abbreviation-first section number: attached sub-provisions ("§6(1)",
 * "§7Abs2", "§4Abs.1"), then the end, a terminal "." or "," ("DSG §1.", "B-VG Art7,"), or
 * whitespace and sub-provisions, which are discarded. A compact capital still joins the number
 * ("§1330A") unless it opens an attached sub-provision ("§4Abs1", "§4Z2"), which the number then
 * ends before. A "." with more after it is no terminal one, so "ZPO §179. ZPO §275" (two norms)
 * is left to `parseChain`.
 */
const SECTION_TAIL = String.raw`(?:${SUB_PROVISION_TOKEN})*(?:[.,]|\s+\S.*)?$`;
const ABBREV_PARAGRAPH = new RegExp(
  String.raw`^(${ABBREVIATION_START}(?:[^§]*?[^§\s])?)\s+§+\s*(${SECTION_NUMBER})${SECTION_TAIL}`,
);
const ABBREV_ARTIKEL = new RegExp(
  String.raw`^(${ABBREVIATION_START}(?:.*?\S)?)\s+${ARTIKEL}\s*(${SECTION_NUMBER})${SECTION_TAIL}`,
);

/**
 * Parse the abbreviation-first shape — the abbreviation precedes the §/Artikel marker ("DSG §1",
 * "EMRK Art8"), optionally with a trailing sub-provision that is discarded ("DSG §22 Abs1",
 * "DSGVO Art6 Abs1 litc", "DSGVO Art4 Z2", "DSG §6(1)", "IPRG §4Abs.1"). Anchored on the marker,
 * not on whitespace, so a multi-token abbreviation stays whole ("B-VG", "TKG 2021"); the leading
 * letter or ordinal (and, for the §-branch, the §-free abbreviation body) keeps a section-first
 * string out of this branch. `parseNorm` runs it BEFORE the section-first branches — whose
 * un-anchored regexes would otherwise read "§22 Abs1" as "§ <section> <abbreviation>" and
 * mis-parse the abbreviation to "Abs1" — and BEFORE the BARE_ABBREVIATION fallback, which would
 * otherwise swallow "EMRK Art8" as a literal abbreviation and resolve nothing.
 *
 * The abbreviation ends on a non-space and the section-first `§` run is matched from its head,
 * so a whitespace run or a run of `§` is scanned once rather than from every position in it.
 * The captures are the ones the plain lazy forms take.
 */
function parseAbbreviationFirst(s: string): NormParse | null {
  const abbrevParagraph = ABBREV_PARAGRAPH.exec(s);
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
  const abbrevArtikel = ABBREV_ARTIKEL.exec(s);
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
  return null;
}

/**
 * Parse a norm citation into an abbreviation and optional §/Artikel number. Handles both
 * orders: section-first ("§ 6 DSG", "Art 10 B-VG") and abbreviation-first ("DSG §1",
 * "EMRK Art8", "DSG §22 Abs1") — the latter is the shape ris_search_case_law emits in its
 * `norms_cited` output, so a cited norm round-trips straight back into this lookup. Sub-provision
 * refs (Abs / Z / lit / Satz / "(1)") are dropped either way — RIS filters on the §/Artikel number only,
 * and the document carries every Absatz — and a parse whose abbreviation is itself a lone
 * sub-provision is no parse. The norm route reads a section with no law ("Art6 Abs1") through
 * `parseSectionOnly` before this runs.
 *
 * A comma-joined entry ("DSG §1, §24", as VfGH headnotes cite several provisions of one law)
 * parses its first provision, carrying the rest in `others` as their own cites; an entry joining
 * full norms with ". " ("ZPO §179. ZPO §275 Abs2", as OGH headnotes do) parses its first norm the
 * same way. An EU recital cite, in either order ("DSGVO ErwGr47", "ErwGr 47 DSGVO"), parses to its
 * act and recital number, so the route can name the act.
 */
function parseNorm(input: string): NormParse | null {
  const s = input.trim();
  const parsed = parseChain(s) ?? parseJoined(s) ?? parseSingle(s);
  return parsed !== null && !SUB_PROVISION.test(parsed.abbreviation) ? parsed : null;
}

/** A §/Artikel number, or an EU recital, cited without a law. */
interface SectionOnly {
  readonly marker: '§' | 'Art' | 'ErwGr';
  readonly number: string;
}

/**
 * The provision a cite names when it names no law ("Art6 Abs1" → Art 6, "Erwägungsgrund 47" →
 * ErwGr 47), else `null`.
 */
function parseSectionOnly(s: string): SectionOnly | null {
  const section = SECTION_ONLY.exec(s);
  if (section?.[2] !== undefined) {
    return {
      marker: section[1] === undefined ? 'Art' : '§',
      number: section[2].replace(/\s+/g, ''),
    };
  }
  const recital = RECITAL_ONLY.exec(s);
  if (recital?.[1] !== undefined) return { marker: 'ErwGr', number: recital[1] };
  return null;
}

/** The first provision of an abbreviation-first comma-joined entry, the rest as `others`. */
function parseJoined(s: string): NormParse | null {
  const comma = PROVISION_COMMA.exec(s);
  if (comma === null) return null;
  const head = parseAbbreviationFirst(s.slice(0, comma.index));
  if (head === null) return null;
  const others = s
    .slice(comma.index)
    .split(PROVISION_COMMA)
    .map((provision) => provision.trim())
    .filter((provision) => provision !== '')
    .map((provision) => `${head.abbreviation} ${provision}`);
  return { ...head, others };
}

/**
 * The first norm of an entry joining full norms with ". ", the rest as `others` — each later
 * norm as written, or each of its comma-joined provisions as its own cite. A part ends at a
 * separator once it names a §/Artikel number after a law, so a "." inside a law's name stays in
 * it ("Bgld. Kinder- und JugendhilfeG 2013 §5"); an entry whose last part names none is no
 * chain ("EO §85 Abs2 2. Satz"). Each stretch between separators is tested once.
 */
function parseChain(s: string): NormParse | null {
  let first: string | undefined;
  const rest: string[] = [];
  let start = 0;
  let stretch = 0;
  let named = false;
  for (const separator of s.matchAll(NORM_SEPARATOR)) {
    named ||= PROVISION_AFTER_LAW.test(s.slice(stretch, separator.index));
    stretch = separator.index + separator[0].length;
    if (!named) continue;
    const part = s.slice(start, separator.index).trimEnd();
    if (first === undefined) first = part;
    else rest.push(part);
    start = stretch;
    named = false;
  }
  if (first === undefined || !PROVISION_AFTER_LAW.test(s.slice(stretch))) return null;
  rest.push(s.slice(start));
  const head = parseJoined(first) ?? parseAbbreviationFirst(first);
  if (head === null) return null;
  return { ...head, others: [...(head.others ?? []), ...rest.flatMap(partCites)] };
}

/** The cites one later part of a ". "-joined entry names: each comma-joined provision, or itself. */
function partCites(part: string): string[] {
  const comma = PROVISION_COMMA.exec(part);
  if (comma === null) return [part];
  const joined = parseJoined(part);
  return joined === null
    ? [part]
    : [part.slice(0, comma.index).trimEnd(), ...(joined.others ?? [])];
}

/**
 * The sub-provisions leading a section-first rest ("Abs. 1 Z. 2 DSG", "(1) lit. a B-VG"), so
 * the law after them is the abbreviation. Each token needs whitespace after it, a parenthesized
 * Absatz another one ("(1)(2)") — never punctuation, which is no law.
 */
const LEADING_SUB_REFS = new RegExp(
  String.raw`^(?:Abs\.?\s*\d+\w?\s+|Z\.?\s*\d+\s+|lit\.?\s*\w+\s+|Satz\s*\d+\s+|${PAREN_ABSATZ}(?:\s+|(?=\()))+`,
  'i',
);
/**
 * What follows a section-first number before the rest (sub-provisions and the law): whitespace,
 * or attached parenthesized Absätze and then whitespace ("Art 6(1) B-VG"). "§179(1). ZPO §275"
 * is no section-first cite of a law named ". ZPO".
 */
const SECTION_FIRST_GAP = String.raw`(?:\s+|(?=(?:${PAREN_ABSATZ})+\s))`;
/** A section-first § or Artikel cite: the number, then the rest. */
const SECTION_FIRST_PARAGRAPH = new RegExp(
  String.raw`(?<!§)§+\s*(${SECTION_NUMBER})${SECTION_FIRST_GAP}(\S.*)$`,
);
const SECTION_FIRST_ARTIKEL = new RegExp(
  String.raw`\b${ARTIKEL}\s*(${SECTION_NUMBER})${SECTION_FIRST_GAP}(\S.*)$`,
);

/** One norm citation, in either order, or a bare abbreviation. */
function parseSingle(s: string): NormParse | null {
  const stripSubRefs = (rest: string): string => rest.replace(LEADING_SUB_REFS, '').trim();

  const abbreviationFirst = parseAbbreviationFirst(s);
  if (abbreviationFirst !== null) return abbreviationFirst;

  const paragraph = SECTION_FIRST_PARAGRAPH.exec(s);
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
  const artikel = SECTION_FIRST_ARTIKEL.exec(s);
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
  const recitalAfter = RECITAL_AFTER.exec(s);
  if (recitalAfter?.[1] !== undefined && recitalAfter[2] !== undefined) {
    return { abbreviation: recitalAfter[1], recital: recitalAfter[2] };
  }
  const recitalFirst = RECITAL_FIRST.exec(s);
  if (recitalFirst?.[1] !== undefined && recitalFirst[2] !== undefined) {
    return { abbreviation: recitalFirst[2].trim(), recital: recitalFirst[1] };
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

/** A federal or imperial gazette as cited — RIS files several of them in one application. */
type GazetteSeries = 'BGBl' | 'GBlÖ' | 'RGBl' | 'StGBl';

/** How each series is written in a citation. */
const SERIES_LABEL: Readonly<Record<GazetteSeries, string>> = {
  BGBl: 'BGBl.',
  GBlÖ: 'GBlÖ',
  RGBl: 'RGBl.',
  StGBl: 'StGBl.',
};

/**
 * How a hit's promulgation opens, per series: BgblPdf's Fundstelle with the cite prefix
 * ("StGBl. Nr. 1/1945"), BgblAlt's Kundmachungsorgan with the gazette title
 * ("Staatsgesetzblatt für die Republik Österreich").
 */
const SERIES_BY_PREFIX: readonly (readonly [string, GazetteSeries])[] = [
  ['StGBl.', 'StGBl'],
  ['Staatsgesetzblatt', 'StGBl'],
  ['BGBl.', 'BGBl'],
  ['Bundesgesetzblatt', 'BGBl'],
  ['RGBl.', 'RGBl'],
  ['Reichsgesetzblatt', 'RGBl'],
  ['Gesetzblatt für das Land Österreich', 'GBlÖ'],
];

/** The series a federal gazette hit belongs to, or `undefined` when it records none. */
function hitSeries({ metadata }: RisHit): GazetteSeries | undefined {
  if (metadata.controller !== 'Bundesrecht') return;
  const { promulgation } = metadata;
  if (promulgation === undefined) return;
  return SERIES_BY_PREFIX.find(([prefix]) => promulgation.startsWith(prefix))?.[1];
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
  /** The cited federal or imperial gazette; absent on a state (LGBl.) citation. */
  readonly series?: GazetteSeries;
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

/** True for a four-digit year from 1848 on — the start of the oldest gazette RIS holds. */
function isGazetteYear(digits: string): boolean {
  return digits.length === 4 && Number.parseInt(digits, 10) >= 1848;
}

/**
 * Read the number and year from the first "A/B" pair, number-first ("Nr. 24/2018") or
 * year-first ("BGBl I 2018/24", the order commentaries cite in). B stays the year when it is a
 * four-digit year from 1848 on; otherwise a four-digit A in that range is the year. B is checked
 * first because pre-1997 numbers ran past 999 — "BGBl. Nr. 1005/1994" is number 1005, not a
 * year. The lookbehind starts the match only at the head of a digit run, which keeps the scan
 * linear over a long run of digits.
 */
function readGazetteNumber(s: string): { number: string; year: number } | null {
  const pair = /(?<!\d)(\d+)\s*\/\s*(\d+)/.exec(s);
  const [, a, b] = pair ?? [];
  if (a === undefined || b === undefined) return null;
  if (isGazetteYear(b)) return { number: `${a}/${b}`, year: Number.parseInt(b, 10) };
  if (isGazetteYear(a)) return { number: `${b}/${a}`, year: Number.parseInt(a, 10) };
  return null;
}

/** The federal or imperial gazette a citation names by its prefix, or `undefined` for none. */
function citedSeries(s: string): GazetteSeries | undefined {
  if (/\bStGBl\b/i.test(s)) return 'StGBl';
  if (/\bRGBl\b/i.test(s)) return 'RGBl';
  if (/GBl[ÖO]/i.test(s)) return 'GBlÖ';
  return /\bBGBl\b/i.test(s) ? 'BGBl' : undefined;
}

/**
 * Parse a gazette citation and route it to the owning application: federal BGBl. by year
 * (BgblAuth 2004+, BgblPdf 1945–2003, BgblAlt before 1945), the StGBl. by year too — RIS files
 * the 1918–1920 Staatsgesetzblatt in BgblAlt and the 1945 one in BgblPdf, beside the BGBl. —
 * RGBl./GBlÖ to BgblAlt, and LGBl. to the state Landesgesetzblatt (LgblAuth) when a state hint
 * is present — carrying that state's legacy series alongside, since a pre-switch citation
 * lives there.
 */
function parseGazette(input: string, stateHint: RisStateCode | undefined): GazetteParse | null {
  const s = input.trim();
  const isState = /\bLGBl\b/i.test(s);
  const series = isState ? undefined : citedSeries(s);
  if (!isState && series === undefined) return null;

  const numYear = readGazetteNumber(s);
  if (!numYear) return null;
  const { number, year } = numYear;

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
  if (series === 'RGBl' || series === 'GBlÖ' || (series === 'StGBl' && year < 1945)) {
    return { application: 'BgblAlt', needsState: false, number, series };
  }
  if (series === 'StGBl') {
    return { application: 'BgblPdf', needsState: false, number, series };
  }
  const application: GazetteApplication =
    year >= 2004 ? 'BgblAuth' : year >= 1945 ? 'BgblPdf' : 'BgblAlt';
  // Parts exist only from 1997 and never on the metadata-only imperial tier.
  return {
    application,
    needsState: false,
    number,
    series: 'BGBl',
    ...(part !== undefined && application !== 'BgblAlt' && { part }),
  };
}

/**
 * Geschäftszahl formats per court, first match wins. Order is load-bearing where shapes nest:
 * the LVwG rows run before VfGH because Burgenland's "E 301/18/2026.019/006" opens like a VfGH
 * number, BVwG's "G13 2337298-1" needs its register number to keep VfGH's "G13/2025" out, and
 * VwGH's "Fr 2026/04/0013" runs before VfGH, whose row would claim its "Fr 2026/04" head. VfGH
 * stores its numbers without a space ("G13/2025", "WIII1/2026") and is cited with one. BVwG is
 * also cited with a hyphen after the chamber ("W213-2337298-1"), and older VwGH numbers carry
 * a two-digit year ("83/16/0049").
 */
const CASE_COURT_PATTERNS: readonly [RegExp, readonly RisCourtCode[]][] = [
  [/\bUPTS\b/i, ['upts']],
  [/^(?:K?LVwG[-\s]|VGW-|405-)/i, ['lvwg']],
  [/^[A-Z] [A-Z0-9]{3}\/\d{2}\/\d{4}\./, ['lvwg']],
  [/^B-GBK\b/i, ['gbk']],
  [/\bPVA[BK]\b/i, ['pvak']],
  [/^VKS-/i, ['verg']],
  [/^[WGLI]\d{2,4}(?:\s+|-)\d+-\d+/i, ['bvwg']],
  [/^[A-Za-z]{0,3}\s?(?:\d{2}){1,2}\/\d{2}\/\d{4}\b/, ['vwgh']],
  [/^\d{4}-\d\.\d{3}\.\d{3}\b/, ['dsk', 'dok']],
  [/^[A-Za-z]{1,4}\s?\d+\/\d{2,4}\b/, ['vfgh']],
  [/^\d{1,2}\s?[A-Za-zÄÖÜ]{1,4}\s?\d+\/\d{2}[a-z]?\b/, ['justiz']],
];

/**
 * Match a Geschäftszahl to its owning court(s) by format. Returns up to two candidate courts
 * (probed in order); the shared DSB/Dok "YYYY-0.NNN.NNN" shape yields both. An empty result
 * means the format wasn't recognized — the caller falls back to `found: false`. Historical
 * courts' formats are not detected; they need the court hint.
 */
function matchCaseCourts(input: string): RisCourtCode[] {
  const s = input.trim();
  for (const [re, courts] of CASE_COURT_PATTERNS) {
    if (re.test(s)) return [...courts];
  }
  return [];
}

/**
 * A leading court name as practitioners cite it ("VfGH G 13/2025", "OGH 6 Ob 236/23h"). LVwG is
 * deliberately absent: Steiermark's own numbers begin "LVwG " ("LVwG 47.14-2930/2026-8"), so
 * stripping it would destroy the number — format detection finds those instead.
 */
const COURT_PREFIX = /^(vfgh|vwgh|ogh|bvwg|dsb)\s+/i;
const COURT_BY_PREFIX: Readonly<Record<string, RisCourtCode>> = {
  bvwg: 'bvwg',
  dsb: 'dsk',
  ogh: 'justiz',
  vfgh: 'vfgh',
  vwgh: 'vwgh',
};

/**
 * Digits joined by "/" or "-", which every Geschäftszahl a court prefix can name carries — and
 * a law named after a court ("VwGH Gesetz", "VfGH Art 140 B-VG") does not.
 */
const CASE_NUMBER_SHAPE = /\d\s*[/-]\s*\d/;

/** Split a court-prefixed case number into its court and the number RIS stores. */
function stripCourtPrefix(input: string): { caseNumber: string; court: RisCourtCode } | null {
  const m = COURT_PREFIX.exec(input);
  const court = m?.[1] === undefined ? undefined : COURT_BY_PREFIX[m[1].toLowerCase()];
  if (m === null || court === undefined) return null;
  return { caseNumber: input.slice(m[0].length), court };
}

/**
 * The Geschäftszahl as `court` stores it. BVwG stores a space after the chamber
 * ("W213 2337298-1"), and its search matches nothing for the hyphenated cite form.
 */
function storedCaseNumber(court: RisCourtCode, caseNumber: string): string {
  return court === 'bvwg' ? caseNumber.replace(/^([WGLI]\d{2,4})-(?=\d+-\d)/i, '$1 ') : caseNumber;
}

/**
 * ECLI court segments RIS carries, mapped to the application holding that court's decisions.
 * Justiz segments are a court type plus its number (OGH0002, OLG0009, LG00003, BG00320); LVwG
 * segments append the state (LVWGNI). The historical bodies carry no ECLI in RIS.
 */
const ECLI_COURTS: readonly [RegExp, RisCourtCode][] = [
  [/^VFGH$/, 'vfgh'],
  [/^VWGH$/, 'vwgh'],
  [/^(?:OGH|OLG|LG|BG)\d{4,5}$/, 'justiz'],
  [/^BVWG$/, 'bvwg'],
  [/^LVWG[A-Z]{2}$/, 'lvwg'],
  [/^DSB$/, 'dsk'],
  // The Parlamentarisches Datenschutzkomitee, whose decisions RIS files in Dsk.
  [/^PDK$/, 'dsk'],
  [/^PVAB$/, 'pvak'],
];

/** An ECLI as read: malformed, foreign, or Austrian with its court segment mapped or not. */
type EcliParse =
  | { readonly status: 'malformed' }
  | { readonly status: 'foreign' }
  | { readonly court?: RisCourtCode; readonly segment: string; readonly status: 'austrian' };

/**
 * Read an ECLI — `ECLI:<country>:<court>:<year>:<identifier>` — or return `null` when the
 * citation is not one. Split on colons rather than matched with one pattern, so no shape of
 * caller text can make it backtrack.
 */
function parseEcli(input: string): EcliParse | null {
  if (!/^ECLI:/i.test(input)) return null;
  const parts = input.split(':');
  const [, country, segment, year, identifier] = parts;
  if (
    parts.length !== 5 ||
    country === undefined ||
    segment === undefined ||
    identifier === undefined ||
    country === '' ||
    segment === '' ||
    identifier === '' ||
    !/^\d{4}$/.test(year ?? '')
  ) {
    return { status: 'malformed' };
  }
  if (country.toUpperCase() !== 'AT') return { status: 'foreign' };
  const upper = segment.toUpperCase();
  const court = ECLI_COURTS.find(([re]) => re.test(upper))?.[1];
  return { segment, status: 'austrian', ...(court !== undefined && { court }) };
}

/* ------------------------------------------------------------------------------------ */
/* Candidate ranking — which hit on the page the citation names                          */
/* ------------------------------------------------------------------------------------ */

/**
 * Hits requested per routed norm or case-number search. The ranking can only pick from the
 * page RIS returns, and RIS sorts neither route by relevance to the cite: a bare abbreviation
 * lists titles alphabetically (the Unternehmensgesetzbuch sits behind 12 "UGB-…" Verordnung
 * sections), and a Geschäftszahl lists newest first, so Rechtssätze that later decisions
 * extended outrank the decision text (2Ob1/09z: 78 matches, the text at 57 — measured
 * 2026-10-17). A filtered search costs the same at 20 or 100 when it matches few documents
 * (6Ob236/23h, 6 matches: 0.82 s either way); the 78-match page took 3.0 s against 1.9 s.
 */
const RANKED_PAGE_SIZE = 100;

/** Pick the lowest-ranked hit; RIS order breaks ties, so an all-equal page keeps its first. */
function pickRanked(hits: readonly RisHit[], rank: (hit: RisHit) => number): RisHit | undefined {
  let best: RisHit | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const hit of hits) {
    const value = rank(hit);
    if (value < bestRank) {
      best = hit;
      bestRank = value;
    }
  }
  return best;
}

/** An abbreviation as compared: case-insensitive, whitespace collapsed. */
function comparableAbbreviation(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** An abbreviation split from a trailing year ("alvg" and "1977" from "alvg 1977"). */
function splitTrailingYear(abbreviation: string): { base: string; year: string } | undefined {
  const year = abbreviation.slice(-4);
  return abbreviation.length > 5 &&
    abbreviation.charAt(abbreviation.length - 5) === ' ' &&
    /^\d{4}$/.test(year)
    ? { base: abbreviation.slice(0, -5), year }
    : undefined;
}

/**
 * True when the label is the cited section with nothing in front ("§ 1", not "Art. 2 § 1").
 * A citation without a section has no label to prefer.
 */
function isExactSectionLabel(label: string | undefined, parsed: NormParse): boolean {
  if (parsed.section === undefined) return true;
  if (label === undefined) return false;
  const compact = label.replace(/\s+/g, '').toLowerCase();
  const section = parsed.section.toLowerCase();
  const markers = parsed.sectionType === 'Artikel' ? ['art.', 'art', 'artikel'] : ['§'];
  return markers.some((marker) => compact === `${marker}${section}`);
}

/**
 * Rank a consolidated-law hit against a norm citation: the cited abbreviation (0–1), then the
 * cited abbreviation plus a year — "EStG 1988" for "EStG" (2–3), then, for a cite ending in a
 * year, the cited abbreviation without it, when the hit's short title carries that year —
 * "AlVG" for "AlVG 1977", filed under "Arbeitslosenversicherungsgesetz 1977" (4–5). Each tier
 * puts the exact section label ahead of a prefixed one. The short-title check keeps a cite of a
 * newer law ("TKG 2021") off an older one RIS files under the bare abbreviation, since `Titel`
 * also matches a year outside the law's name; the year is any whitespace-separated word of the
 * short title, since RIS often writes a non-breaking space before it. A hit whose abbreviation
 * is none of these keeps its RIS position behind them (6): `Titel` matches anywhere in the
 * title, so the first hits for "UGB" are the UGB-Formblatt-V and the
 * UGB-Schwellenwerte-Verordnung, and a state law's abbreviation can carry a prefix the cite
 * omits ("Stmk. BauG").
 */
function normRank(parsed: NormParse): (hit: RisHit) => number {
  const cited = comparableAbbreviation(parsed.abbreviation);
  const dated = splitTrailingYear(cited);
  const unranked = 6;
  return ({ metadata }) => {
    if (metadata.controller !== 'Bundesrecht' && metadata.controller !== 'Landesrecht') {
      return unranked;
    }
    if (metadata.abbreviation === undefined) return unranked;
    const abbreviation = comparableAbbreviation(metadata.abbreviation);
    const tier =
      abbreviation === cited
        ? 0
        : splitTrailingYear(abbreviation)?.base === cited
          ? 1
          : abbreviation === dated?.base && metadata.shortTitle?.split(/\s+/).includes(dated.year)
            ? 2
            : undefined;
    if (tier === undefined) return unranked;
    return tier * 2 + (isExactSectionLabel(metadata.sectionLabel, parsed) ? 0 : 1);
  };
}

/**
 * A Geschäftszahl as compared: no whitespace, lowercase, and without the parenthesized suffix
 * or trailing "ua" (und andere) RIS attaches to a stored number — "G8/2026 (G8/2026-15)" and
 * "E3811/2025 ua" compare as "g8/2026" and "e3811/2025". The "ua" is stripped only after a
 * digit: a Justiz number ends in one check letter ("23h"), never two.
 */
function comparableCaseNumber(value: string): string {
  let compact = value.replace(/\s+/g, '').toLowerCase();
  if (compact.endsWith(')')) {
    const open = compact.lastIndexOf('(');
    if (open > 0) compact = compact.slice(0, open);
  }
  if (compact.endsWith('ua') && /\d/.test(compact.charAt(compact.length - 3))) {
    compact = compact.slice(0, -2);
  }
  return compact;
}

/**
 * Rank a case-law hit against a cited decision: its decision text (0), then a Rechtssatz the
 * decision leads — `case_numbers[0]` is the decision a headnote was first written for (1) —
 * then RIS order (2). A Rechtssatz merely listing the cite among later decisions is the last
 * kind: the 1952 headnote that later decisions extended through 6Ob236/23h is not that
 * decision.
 *
 * Without a cited case number (a collection number names the decision through its
 * Sammlungsnummer instead) every decision text ranks first.
 */
function caseLawRank(citedCaseNumber: string | undefined): (hit: RisHit) => number {
  const cited = citedCaseNumber === undefined ? undefined : comparableCaseNumber(citedCaseNumber);
  return ({ metadata }) => {
    if (metadata.controller !== 'Judikatur') return 2;
    const { caseNumbers, decisionDocumentType } = metadata;
    if (decisionDocumentType === 'Text') {
      if (cited === undefined) return 0;
      if (caseNumbers.some((caseNumber) => comparableCaseNumber(caseNumber) === cited)) return 0;
    }
    const lead = caseNumbers[0];
    if (
      cited !== undefined &&
      decisionDocumentType === 'Rechtssatz' &&
      lead !== undefined &&
      comparableCaseNumber(lead) === cited
    ) {
      return 1;
    }
    return 2;
  };
}

/**
 * Rank a case-law hit against a cited ECLI: the decision text carrying it (0), then a Rechtssatz
 * carrying it (1) — VfGH and LVwG Rechtssätze carry their decision's ECLI. A hit whose own ECLI
 * differs is never picked: a full-text search also matches a decision that quotes the cite.
 */
function ecliRank(cited: string): (hit: RisHit) => number {
  const upper = cited.toUpperCase();
  return ({ metadata }) => {
    if (metadata.controller !== 'Judikatur' || metadata.ecli?.toUpperCase() !== upper) {
      return Number.POSITIVE_INFINITY;
    }
    return metadata.decisionDocumentType === 'Text' ? 0 : 1;
  };
}

/** Classify a citation by shape (auto mode). Returns `null` when it doesn't classify. */
function classify(input: string, courtHint: RisCourtCode | undefined): CitationKind | null {
  if (parseCollection(input)) return 'collection_number';
  if (parseEcli(input) !== null) return 'case_number';
  if (COURT_PREFIX.test(input) && CASE_NUMBER_SHAPE.test(input)) return 'case_number';
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
  return `Could not classify '${input}'. Expected forms — norm: '§ 6 DSG' / 'Art 10 B-VG'; gazette: 'BGBl. I Nr. 165/1999' or year-first 'BGBl I 2018/24' (also pre-2004 and RGBl/StGBl forms, and LGBl with a state hint); case number: 'Ro 2026/03/0016', court-prefixed 'VfGH G 13/2025', or an ECLI 'ECLI:AT:VFGH:2026:G13.2025'; collection: 'VfSlg 19.632/2012'. Formats: ris_list_reference topic citation_formats. Or set kind explicitly; for keyword search use ris_search_legislation / ris_search_case_law.`;
}

/** The ECLI court segments this lookup maps, as listed in guidance. */
const MAPPED_ECLI_SEGMENTS =
  'VFGH, VWGH, OGH/OLG/LG/BG with a court number (Justiz), BVWG, LVWG with a state code (LVWGNI), DSB, PDK, PVAB';

/** Guidance for an ECLI that names no searchable court — nothing was searched. */
function ecliParseGuidance(citation: string, parsed: EcliParse): string {
  if (parsed.status === 'foreign') {
    return `'${citation}' is not an Austrian ECLI — RIS carries Austrian decisions only, so an ECLI resolves here when it starts 'ECLI:AT:'.`;
  }
  if (parsed.status === 'austrian') {
    return `No court this lookup knows uses the ECLI court segment '${parsed.segment}' in '${citation}'. Mapped segments: ${MAPPED_ECLI_SEGMENTS}. Pass court to search that court for the ECLI.`;
  }
  return `Could not read an ECLI from '${citation}'. An Austrian ECLI has five colon-separated parts — 'ECLI:AT:VFGH:2026:G13.2025': country, court, decision year, and the court's own identifier. Formats: ris_list_reference topic citation_formats.`;
}

/** Guidance for an ECLI whose court was searched without a hit carrying it. */
function ecliGuidance(citation: string, court: RisCourtCode): string {
  return `No decision in ${courtApplication(court)} carries ECLI '${citation}' — a full-text search for it found no document with that identifier. Verify the ECLI against the cite, or resolve the decision by its Geschäftszahl with court: ${court}. Keyword fallback: ris_search_case_law court: ${court} with query.`;
}

/**
 * Guidance for an unresolved norm citation. Takes the whole parse so the section type reaches
 * both the label and the retry recipe: `section_type` defaults to Paragraph once a section range
 * is set, so an Artikel recipe that omits it searches § N and returns zero even when the Artikel
 * exists. It is emitted for both types — the recipe is meant to be run verbatim, so it states the
 * filter rather than leaning on the default. A state-law miss carries its state into both
 * retries as `scope`, which otherwise defaults to federal law.
 */
function normGuidance(parsed: NormParse, date: string, state: RisStateCode | undefined): string {
  const { abbreviation, section, sectionType } = parsed;
  const head =
    section !== undefined
      ? `No document for ${abbreviation} ${sectionMarker(sectionType)} ${section} in force on ${date}.`
      : `No document for ${abbreviation} in force on ${date}.`;
  const scope = state !== undefined ? `, scope: '${state}'` : '';
  const retry =
    section !== undefined
      ? `retry ris_search_legislation with title: '${abbreviation}', section_from/to: '${section}', section_type: '${sectionType ?? 'Paragraph'}'${scope}, include_all_versions: true.`
      : `retry ris_search_legislation with title: '${abbreviation}'${scope}, include_all_versions: true.`;
  const stateNote =
    state === undefined ? ' State law resolves only with an explicit state hint.' : '';
  return `${head} If the provision existed at another time, ${retry} If the abbreviation is uncertain, search ris_search_legislation title: '${abbreviation}*'${scope}.${stateNote}`;
}

/**
 * Guidance for a norm-routed citation no norm shape reads ("DSG §1, Artenschutz", a case number
 * forced to kind: norm) — nothing was searched, and a title search on the unread string is no
 * retry, so the fix is the citation's shape.
 */
function unreadableNormGuidance(citation: string): string {
  return `Could not read a norm citation from '${citation}'. A norm citation names a law by its abbreviation, with or without a §/Artikel number: '§ 6 DSG', 'Art 10 B-VG', 'DSG §1', or 'ABGB'. Formats: ris_list_reference topic citation_formats. For keyword search use ris_search_legislation with query.`;
}

/**
 * Guidance for a cite naming a §/Artikel number but no law ("Art6 Abs1") — nothing to search,
 * and a title search on the provision itself cannot succeed, so the fix is the missing law.
 */
function provisionWithoutLawGuidance(citation: string, provision: SectionOnly): string {
  if (provision.marker === 'ErwGr') return recitalGuidance(citation, provision.number);
  const label = `${provision.marker} ${provision.number}`;
  return `'${citation}' names a provision, ${label}, but no law, so nothing was searched. Add the law's abbreviation: '<abbr> ${label}'. Formats: ris_list_reference topic citation_formats.`;
}

/**
 * Guidance for a recital cite whose act is outside the EU-act set, or names no act — decided
 * offline: only EU acts carry recitals, and none that RIS consolidates (AEUV, EUV, EMRK) does.
 */
function recitalGuidance(citation: string, recital: string, act?: string): string {
  const cited =
    act !== undefined ? `recital ${recital} of ${act}` : `recital ${recital} but no act`;
  return `'${citation}' cites ${cited}. Only EU acts carry recitals, and RIS does not consolidate EU law, so nothing was searched. Find the act on EUR-Lex: https://eur-lex.europa.eu.`;
}

/**
 * Guidance for a norm citation naming an EU act RIS does not consolidate — decided offline, so
 * nothing was searched and no RIS retry can succeed. Names the act on EUR-Lex by CELEX (the cited
 * one, when the citation led with one), and the case-law `norm` filter that finds Austrian
 * decisions citing the provision, written the way `norms_cited` writes it. A `SectionOnly` cite
 * reaches it only behind a leading CELEX, which then labels it.
 */
function euGuidance(
  cite: NormParse | SectionOnly | string,
  act: EuAct | undefined,
  citedCelex: string | undefined,
): string {
  const celex = citedCelex ?? act?.celex;
  /*
   * The cite as labelled: its abbreviation and section; a bare section after a CELEX, by that
   * CELEX ("Art 6 of CELEX 32016R0679"); a rest that did not parse, as written.
   */
  let label: string;
  let identityCelex = celex;
  let caseLawNorm: string | undefined;
  if (typeof cite === 'string') {
    label = cite;
  } else if ('abbreviation' in cite) {
    const marker = sectionMarker(cite.sectionType);
    label =
      cite.section !== undefined
        ? `${cite.abbreviation} ${marker} ${cite.section}`
        : cite.abbreviation;
    if (cite.section !== undefined) caseLawNorm = `${cite.abbreviation} ${marker}${cite.section}`;
  } else {
    label = `${cite.marker} ${cite.number} of CELEX ${celex}`;
    identityCelex = undefined;
  }
  // A cited CELEX the set files under another act names only itself — the act is not guessed.
  const actName =
    act !== undefined && (citedCelex === undefined || citedCelex === act.celex)
      ? act.act
      : undefined;
  const identity = [actName, identityCelex !== undefined ? `CELEX ${identityCelex}` : undefined]
    .filter((part) => part !== undefined)
    .join(', ');
  const eurLex =
    celex !== undefined
      ? `Read it on EUR-Lex: https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:${celex}.`
      : 'Find the act on EUR-Lex: https://eur-lex.europa.eu.';
  const caseLaw =
    caseLawNorm !== undefined
      ? ` Austrian decisions citing it: ris_search_case_law with a court (vfgh, vwgh, bvwg, dsk, or justiz) and norm: '${caseLawNorm}'.`
      : '';
  return `${label} is EU law${identity !== '' ? `: ${identity}` : ''}. RIS does not consolidate EU law, so nothing was searched. ${eurLex}${caseLaw}`;
}

/**
 * Guidance for a cite led by an EU case-law CELEX ("62014CJ0362 Schrems", as VwGH and OGH cite a
 * CJEU judgment) — decided offline: it names a court decision, which no RIS application holds.
 */
function euCaseLawGuidance(citation: string, celex: string): string {
  const court = EU_COURT_BY_LETTER.get(celex.charAt(5)) ?? 'the EU courts';
  return `'${citation}' cites EU case law: a decision of ${court}, CELEX ${celex}. RIS holds Austrian law and decisions only, so nothing was searched. Read it on EUR-Lex: https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX:${celex}.`;
}

/** The sentence naming a comma-joined entry's other provisions; empty for a single provision. */
function othersPhrase(others: readonly string[] | undefined): string {
  if (others === undefined || others.length === 0) return '';
  return ` The entry also cites ${joinCites(others)} — look ${others.length === 1 ? 'it' : 'each'} up as its own citation.`;
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

  if (parsed.series === 'StGBl') {
    return `No gazette entry for ${number} in ${application}. RIS carries the Staatsgesetzblatt for 1918–1920 (BgblAlt) and 1945 (BgblPdf); from 1946 the federal gazette is the BGBl. Verify the number and year against the cite; browse the surrounding range with ris_search_gazette published_from/published_to to find the actual number.`;
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

/** Join cites as "A and B" or "A, B and C". */
function joinCites(cites: readonly string[]): string {
  return cites.length > 1 ? `${cites.slice(0, -1).join(', ')} and ${cites.at(-1)}` : cites.join('');
}

/**
 * Split a gazette page by the cited series. RIS files several gazettes in one application
 * under one number space — the 1945 Staatsgesetzblatt beside the BGBl. in BgblPdf ("1/1945" is
 * both a proclamation and a currency ordinance), and in BgblAlt the gazettes that overlap in a
 * changeover year (RGBl./StGBl. 1918, StGBl./BGBl. 1920, BGBl./GBlÖ 1938) — so a number search
 * returns entries from gazettes the citation did not name. Those are `others`, cited by their
 * own series; a hit recording no gazette stays eligible, behind the ones confirmed to match.
 * `otherHits` counts those hits, which `others` (one cite per series) can undercount.
 */
function splitBySeries(
  hits: readonly RisHit[],
  cited: GazetteSeries | undefined,
  number: string,
): { eligible: RisHit[]; otherHits: number; others: string[] } {
  if (cited === undefined) return { eligible: [...hits], otherHits: 0, others: [] };
  const eligible: RisHit[] = [];
  const others = new Set<string>();
  for (const hit of hits) {
    const series = hitSeries(hit);
    if (series === undefined || series === cited) eligible.push(hit);
    else others.add(`${SERIES_LABEL[series]} Nr. ${number}`);
  }
  return { eligible, otherHits: hits.length - eligible.length, others: [...others] };
}

/** "an entry in another gazette series" or its plural, closing on what that makes it. */
function otherSeriesPhrase(others: readonly string[]): string {
  return others.length === 1
    ? 'an entry in another gazette series that shares its numbering'
    : 'entries in other gazette series that share its numbering';
}

/**
 * Guidance for a gazette number that matched only entries of gazettes other than the cited
 * one. The miss is the series, not the number, so the retry names the entry that did match.
 */
function gazetteSeriesGuidance(
  parsed: GazetteParse,
  application: GazetteApplication,
  others: readonly string[],
): string {
  const { number, part, series } = parsed;
  const label = series === undefined ? 'gazette' : SERIES_LABEL[series];
  const recipe = `number: ${JSON.stringify(number)}${part !== undefined ? `, part: ${part}` : ''}`;
  return `No ${label} entry for ${number} in ${application} — number "${number}" matched only ${joinCites(others)}, ${otherSeriesPhrase(others)}. Verify the series against the cite; if ${others[0]} is the entry meant, retry with that citation. All matches: ris_search_gazette ${recipe}.`;
}

/**
 * Distinct federal gazette parts across one result page, in part order, as Roman numerals —
 * RIS carries the part as `Teil1`/`Teil2`/`Teil3`, and no part at all before 1997.
 */
function distinctGazetteParts(hits: readonly RisHit[]): string[] {
  const parts = new Set<string>();
  for (const { metadata } of hits) {
    if (metadata.controller === 'Bundesrecht' && metadata.part !== undefined) {
      parts.add(metadata.part);
    }
  }
  return [...parts].sort().map((part) => {
    const digit = Number(part.slice(-1));
    return digit >= 1 && digit <= 3 ? 'I'.repeat(digit) : part;
  });
}

/**
 * Guidance for a partless federal BGBl. number that matched more than one part. From 1997 the
 * three parts number independently, so "BGBl. Nr. 50/2025" is three documents — a law, an
 * ordinance, and a treaty notice — and returning the first would answer a cite the caller may
 * not have meant. Mirrors the VwSlg collision: each candidate named, the retry stated.
 */
function gazetteAmbiguityGuidance(number: string, parts: readonly string[]): string {
  const cites = parts.map((part) => `BGBl. ${part} Nr. ${number}`);
  return `BGBl. Nr. ${number} names more than one gazette entry — number "${number}" matched ${joinCites(cites)}. From 1997 the federal gazette runs three parts that reuse numbers (I laws, II ordinances, III treaties), so the part is what picks one — retry with it, e.g. '${cites[0]}'. All matches: ris_search_gazette number: "${number}".`;
}

function caseGuidance(gz: string, candidates: readonly RisCourtCode[]): string {
  return `No decision for '${gz}' in ${candidates.map(courtApplication).join(', ')}. Pass court explicitly if known — Geschäftszahl format examples per court: ris_list_reference topic courts. Note Justiz carries selected decisions only. Keyword fallback: ris_search_case_law with query.`;
}

/** Guidance for a case number whose format names no court, under a forced kind — nothing ran. */
function undetectedCourtGuidance(gz: string): string {
  return `Could not tell which court '${gz}' belongs to from its format, so no court was searched. Pass court — Geschäftszahl format examples per court: ris_list_reference topic courts. Keyword fallback: ris_search_case_law with query.`;
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
  return `${parsed.label} ${parsed.number} names more than one decision — Sammlungsnummer "${parsed.filter}" matched ${matched.join(' and ')}. VwGH runs two collection series that reuse numbers (A administrative, F finance), so the part letter is what picks one — retry with the full cite. All matches: ris_search_case_law court: vwgh, collection_number: ${JSON.stringify(parsed.filter)}.`;
}

/**
 * The "N more matched" tail of a resolution note: the search-tool call that lists every match,
 * written as that tool's own inputs (`key: value`, free text JSON-quoted, codes bare) carrying
 * the filter the lookup searched with. Without the filter the call lists the whole court,
 * collection, or gazette rather than the alternatives counted. Empty when nothing else matched.
 */
function alternativesRecipe(
  alternatives: number | undefined,
  searchTool: string,
  inputs: readonly string[],
): string {
  if (alternatives === undefined) return '';
  return ` ${alternatives} more matched — list them with ${searchTool} ${inputs.join(', ')}.`;
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

export const risLookupCitation = tool('ris_lookup_citation', {
  title: 'Resolve Austrian Legal Citation',
  description:
    'Resolve a single Austrian legal citation to its canonical RIS document deterministically — no keyword search. Four routes are auto-detected from the citation shape (or forced with kind): a norm citation — section-first ("§ 6 DSG", "Art 10 B-VG"), abbreviation-first ("DSG §1", "EMRK Art8", the shape ris_search_case_law returns in norms_cited; a comma-joined entry like "DSG §1, §24", or one joining full norms with ". " like "ZPO §179. ZPO §275 Abs2", resolves its first provision and names the rest), or a bare abbreviation like "ABGB" or "1. COVID-19-JuBG", with sub-provisions (Abs, Z, lit, "(1)") and a terminal ";" dropped — resolves through consolidated federal law, or a Bundesland with a state hint, as in force today or on in_force_as_of, while an EU act RIS does not consolidate (DSGVO, the Charter, EuGVVO, the EC Treaty as EG) returns found: false pointing to EUR-Lex without a search; a gazette citation ("BGBl. I Nr. 165/1999", year-first "BGBl I 2018/24", pre-2004 "BGBl. Nr. 194/1961", imperial "RGBl. Nr. 189/1902", "StGBl. Nr. 1/1945", or "LGBl. Nr. 61/2026" with a state hint) routes to the right federal era tier by year — the 1945 Staatsgesetzblatt sits in the 1945–2003 tier beside the BGBl. — or to a state Landesgesetzblatt — falling back to that Bundesland’s pre-e-Recht series when the citation predates its switch; a case number ("Ro 2026/03/0016", "G 287/2022", "14Os49/26a", "2025-0.934.677", "W256 …") is matched to its court — a leading VfGH, VwGH, OGH, BVwG, or DSB names it ("VfGH G 13/2025"), court skips detection, and ambiguous formats probe up to two courts; an ECLI ("ECLI:AT:VFGH:2026:G13.2025") resolves to the decision that carries it; a collection number ("VfSlg 19.632/2012", "VwSlg 18.000 A/2010") resolves through the VfGH/VwGH collection — a VwSlg cite given without its part letter can name one decision in each of the two VwGH series, and comes back as ambiguous with both cites named rather than resolved to one of them. Matches are ranked before one is picked: a norm resolves to the hit whose abbreviation is the cited one, then the cited one plus a year ("EStG" → EStG 1988), then the cited one without a year RIS’s abbreviation omits, when the law’s short title carries it ("AlVG 1977" → AlVG), the exact §/Artikel label ahead of a prefixed one ("§ 1" before "Art. 2 § 1"); a case number resolves to the decision text, then to a Rechtssatz that decision leads; a gazette cite resolves only to an entry of the gazette it names (StGBl. and BGBl. share numbers in 1945, as the older gazettes do in their changeover years); and a "BGBl. Nr." cite without its part that matches more than one of parts I/II/III (from 1997 they reuse numbers) comes back as ambiguous with each part named. Returns the single best-matching document in the same shape as the corresponding search tool, with alternatives_count when more than one matched. A citation that cannot be classified or resolved returns found: false with next-step guidance — it never throws for a miss; only an upstream RIS outage is an error. For keyword rather than citation lookup, use ris_search_legislation or ris_search_case_law.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    citation: z
      .string()
      .describe(
        'The legal citation to resolve, e.g. "§ 6 DSG" or "DSG §1", "Art 10 B-VG", "BGBl. I Nr. 165/1999" or "BGBl I 2018/24", "Ro 2026/03/0016" or "VfGH G 13/2025", "ECLI:AT:VFGH:2026:G13.2025", or "VfSlg 19.632/2012".',
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
        'Court hint for a case number — short-circuits court detection, and a leading court name, to this court. An ECLI’s own court segment takes precedence; the hint is searched only for a segment this lookup does not map. Codes: ris_list_reference topic courts, minus normenliste (a norm index, which carries no case numbers).',
      ),
    state: foldStateNames(z.enum(STATE_CODES).optional()).describe(
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
    /*
     * Under kind auto or norm, a terminal ";" is dropped and a leading CELEX is stripped before
     * classification and kept; a forced case-number, gazette, or collection route takes the
     * citation as given. An EU case-law CELEX names a court decision, not an act, and is
     * answered here. A post-Lisbon TFEU/TEU CELEX leaves the rest to resolve as usual, since RIS
     * consolidates both treaties; any other names an EU act RIS does not hold, so the cite is an
     * EU miss carrying that CELEX.
     */
    const readsNorm = input.kind === 'auto' || input.kind === 'norm';
    const given = input.citation.replace(LINE_BREAKS, ' ').trim();
    const raw = readsNorm ? dropTerminalSemicolon(given) : given;
    const lead = readsNorm ? splitLeadingCelex(raw) : null;
    if (lead?.celex.startsWith(CASE_LAW_SECTOR)) {
      return {
        found: false,
        kind: input.kind === 'norm' ? 'norm' : 'unknown',
        guidance: euCaseLawGuidance(raw, lead.celex),
      };
    }
    const rest = lead?.rest ?? raw;
    const citation = readsNorm ? dropGeneralReference(rest) : rest;
    const euCelex = lead !== null && !TREATY_CELEX.test(lead.celex) ? lead.celex : undefined;
    const courtHint = input.court;
    const stateHint = input.state;
    const asOf = input.in_force_as_of ?? todayInAustria();

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
          throw ctx.fail('upstream_error', err.message);
        }
        if (err.code === JsonRpcErrorCode.Timeout) {
          throw ctx.fail('upstream_timeout', err.message);
        }
        if (err.code === JsonRpcErrorCode.ValidationError) {
          return null;
        }
        throw err;
      }
    };

    const route =
      input.kind !== 'auto'
        ? input.kind
        : euCelex !== undefined
          ? 'norm'
          : classify(citation, courtHint);

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
      const hit = result ? pickRanked(result.hits, caseLawRank(undefined)) : undefined;
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
        resolution_note: `Resolved via ris_search_case_law (${application}) — Sammlungsnummer "${parsed.filter}".${alternativesRecipe(
          alternatives,
          'ris_search_case_law',
          [`court: ${parsed.court}`, `collection_number: ${JSON.stringify(parsed.filter)}`],
        )}`,
        ...(alternatives !== undefined && { alternatives_count: alternatives }),
      };
    }

    if (route === 'norm') {
      // Read first: a bare abbreviation fallback would otherwise take "Art 6" for a title.
      const sectionOnly = parseSectionOnly(citation);
      const parsed = sectionOnly === null ? parseNorm(citation) : null;
      /*
       * An EU act RIS does not consolidate is decided here, before any request: every retry the
       * miss guidance would offer (other versions, a wildcard title, a state hint) searches a
       * corpus that cannot hold it, and a bare abbreviation would match a title that merely
       * mentions the act. A state hint does not bypass it.
       */
      const euAct = parsed !== null ? euActOf(parsed.abbreviation) : undefined;
      if (euAct !== undefined || euCelex !== undefined) {
        return {
          found: false,
          kind: 'norm',
          guidance: `${euGuidance(parsed ?? sectionOnly ?? citation, euAct, euCelex)}${othersPhrase(parsed?.others)}`,
        };
      }
      if (sectionOnly !== null) {
        return {
          found: false,
          kind: 'norm',
          guidance: provisionWithoutLawGuidance(citation, sectionOnly),
        };
      }
      if (parsed?.recital !== undefined) {
        return {
          found: false,
          kind: 'norm',
          guidance: recitalGuidance(citation, parsed.recital, parsed.abbreviation),
        };
      }
      if (!parsed) {
        return { found: false, kind: 'norm', guidance: unreadableNormGuidance(citation) };
      }
      const application: LegislationApplication = stateHint !== undefined ? 'LrKons' : 'BrKons';
      const params: LegislationSearchParams = {
        application,
        inForceAsOf: asOf,
        pageSize: RANKED_PAGE_SIZE,
        title: parsed.abbreviation,
        ...(parsed.section !== undefined && {
          sectionFrom: parsed.section,
          sectionTo: parsed.section,
          sectionType: parsed.sectionType,
        }),
        ...(stateHint !== undefined && { state: stateHint }),
      };
      const result = await runSearch(() => getRisService().searchLegislation(params, ctx));
      const hit = result ? pickRanked(result.hits, normRank(parsed)) : undefined;
      if (!result || hit === undefined) {
        return {
          found: false,
          kind: 'norm',
          guidance: `${normGuidance(parsed, asOf, stateHint)}${othersPhrase(parsed.others)}`,
        };
      }
      const alternatives = result.total > 1 ? result.total - 1 : undefined;
      const sectionPhrase =
        parsed.section !== undefined
          ? `, ${sectionMarker(parsed.sectionType)} ${parsed.section}`
          : '';
      const recipe = [
        `title: ${JSON.stringify(parsed.abbreviation)}`,
        ...(parsed.section !== undefined
          ? [
              `section_from: ${JSON.stringify(parsed.section)}`,
              `section_to: ${JSON.stringify(parsed.section)}`,
              `section_type: ${parsed.sectionType ?? 'Paragraph'}`,
            ]
          : []),
        `in_force_as_of: ${JSON.stringify(asOf)}`,
        ...(stateHint !== undefined ? [`scope: ${stateHint}`] : []),
      ];
      ctx.log.info('Citation resolved', { kind: route, application, total: result.total });
      return {
        found: true,
        kind: 'norm',
        record: toLegislationRecord(hit, application),
        resolution_note: `Resolved via ris_search_legislation (${application}) — title "${parsed.abbreviation}"${sectionPhrase}, in force ${asOf}.${othersPhrase(parsed.others)}${alternativesRecipe(alternatives, 'ris_search_legislation', recipe)}`,
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
      let resolved:
        | { application: GazetteApplication; hits: readonly RisHit[]; total: number }
        | undefined;
      for (const application of applications) {
        const params: GazetteSearchParams = {
          application,
          number: parsed.number,
          ...(parsed.part !== undefined && { part: parsed.part }),
          ...(stateHint !== undefined &&
            (application === 'LgblAuth' || application === 'Lgbl') && { state: stateHint }),
        };
        const result = await runSearch(() => getRisService().searchGazette(params, ctx));
        if (result && result.hits.length > 0) {
          resolved = { application, hits: result.hits, total: result.total };
          break;
        }
      }
      if (resolved === undefined) {
        return { found: false, kind: 'gazette', guidance: gazetteGuidance(parsed, stateHint) };
      }
      const { eligible, otherHits, others } = splitBySeries(
        resolved.hits,
        parsed.series,
        parsed.number,
      );
      const hit = pickRanked(eligible, (candidate) =>
        hitSeries(candidate) === parsed.series ? 0 : 1,
      );
      if (hit === undefined) {
        return {
          found: false,
          kind: 'gazette',
          guidance: gazetteSeriesGuidance(parsed, resolved.application, others),
        };
      }
      if (
        parsed.part === undefined &&
        (resolved.application === 'BgblAuth' || resolved.application === 'BgblPdf')
      ) {
        const parts = distinctGazetteParts(eligible);
        if (parts.length > 1) {
          return {
            found: false,
            kind: 'gazette',
            guidance: gazetteAmbiguityGuidance(parsed.number, parts),
          };
        }
      }
      // An entry of another gazette is a different document that shares the number, not an
      // alternative reading of this cite — it is named, and kept out of the count.
      const sameSeries = resolved.total - otherHits;
      const alternatives = sameSeries > 1 ? sameSeries - 1 : undefined;
      const othersPhrase =
        others.length > 0
          ? ` Number "${parsed.number}" also names ${joinCites(others)}, ${otherSeriesPhrase(others)} — ${others.length === 1 ? 'not an alternative' : 'not alternatives'}.`
          : '';
      const partPhrase = parsed.part !== undefined ? `, part ${parsed.part.slice(-1)}` : '';
      /*
       * Both halves of the state recipe — a number alone reproduces nothing without the scope.
       * Only the two state series took the hint, so a stray state on a federal citation must
       * not be reported as a filter that was applied.
       */
      const stateScope =
        stateHint !== undefined &&
        (resolved.application === 'LgblAuth' || resolved.application === 'Lgbl')
          ? `scope: ${stateHint}`
          : undefined;
      const scopePhrase = stateScope !== undefined ? `, ${stateScope}` : '';
      const eraPhrase = resolved.application === 'Lgbl' ? ', state_era: legacy' : '';
      // A federal number routes ris_search_gazette to the same era tier by its year.
      const recipe = [
        `number: ${JSON.stringify(parsed.number)}`,
        ...(parsed.part !== undefined ? [`part: ${parsed.part}`] : []),
        ...(stateScope !== undefined ? [stateScope] : []),
        ...(resolved.application === 'Lgbl' ? ['state_era: legacy'] : []),
      ];
      ctx.log.info('Citation resolved', {
        application: resolved.application,
        kind: route,
        total: resolved.total,
      });
      return {
        found: true,
        kind: 'gazette',
        record: toGazetteRecord(hit, resolved.application),
        resolution_note: `Resolved via ris_search_gazette (${resolved.application}) — number "${parsed.number}"${partPhrase}${scopePhrase}${eraPhrase}.${othersPhrase}${alternativesRecipe(alternatives, 'ris_search_gazette', recipe)}`,
        ...(alternatives !== undefined && { alternatives_count: alternatives }),
      };
    }

    // route === 'case_number'
    const ecli = parseEcli(citation);
    if (ecli !== null) {
      /*
       * RIS has no ECLI filter, so the quoted ECLI is searched as full text across both
       * document types. A mapped court segment is authoritative; the hint only stands in for
       * a segment this lookup does not map.
       */
      const court = ecli.status === 'austrian' ? (ecli.court ?? courtHint) : undefined;
      if (court === undefined) {
        return {
          found: false,
          kind: 'case_number',
          guidance: ecliParseGuidance(citation, ecli),
        };
      }
      const query = `"${citation}"`;
      const result = await runSearch(() =>
        getRisService().searchCaseLaw({ court, pageSize: RANKED_PAGE_SIZE, query }, ctx),
      );
      const hit = result ? pickRanked(result.hits, ecliRank(citation)) : undefined;
      if (!result || hit === undefined) {
        return { found: false, kind: 'case_number', guidance: ecliGuidance(citation, court) };
      }
      const application = courtApplication(court);
      const alternatives = result.total > 1 ? result.total - 1 : undefined;
      ctx.log.info('Citation resolved', { application, kind: route, total: result.total });
      return {
        found: true,
        kind: 'case_number',
        record: toCaseLawRecord(hit, application),
        resolution_note: `Resolved via ris_search_case_law (${application}) — ECLI "${citation}".${alternativesRecipe(
          alternatives,
          'ris_search_case_law',
          [`court: ${court}`, `query: ${JSON.stringify(query)}`],
        )}`,
        ...(alternatives !== undefined && { alternatives_count: alternatives }),
      };
    }

    const prefixed = stripCourtPrefix(citation);
    const caseNumber = prefixed?.caseNumber ?? citation;
    const candidates =
      courtHint !== undefined
        ? [courtHint]
        : prefixed !== null
          ? [prefixed.court]
          : matchCaseCourts(caseNumber);
    if (candidates.length === 0) {
      return { found: false, kind: 'case_number', guidance: undetectedCourtGuidance(caseNumber) };
    }
    let resolved:
      | { caseNumber: string; court: RisCourtCode; hit: RisHit; total: number }
      | undefined;
    for (const court of candidates) {
      const stored = storedCaseNumber(court, caseNumber);
      const result = await runSearch(() =>
        getRisService().searchCaseLaw(
          { caseNumber: stored, court, pageSize: RANKED_PAGE_SIZE },
          ctx,
        ),
      );
      const hit = result ? pickRanked(result.hits, caseLawRank(stored)) : undefined;
      if (result && hit !== undefined) {
        resolved = { caseNumber: stored, court, hit, total: result.total };
        break;
      }
    }
    if (resolved === undefined) {
      return { found: false, kind: 'case_number', guidance: caseGuidance(caseNumber, candidates) };
    }
    const application = courtApplication(resolved.court);
    const alternatives = resolved.total > 1 ? resolved.total - 1 : undefined;
    ctx.log.info('Citation resolved', { application, kind: route, total: resolved.total });
    return {
      found: true,
      kind: 'case_number',
      record: toCaseLawRecord(resolved.hit, application),
      resolution_note: `Resolved via ris_search_case_law (${application}) — Geschäftszahl "${resolved.caseNumber}".${alternativesRecipe(
        alternatives,
        'ris_search_case_law',
        [`court: ${resolved.court}`, `case_number: ${JSON.stringify(resolved.caseNumber)}`],
      )}`,
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
