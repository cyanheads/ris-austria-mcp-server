/**
 * @fileoverview Domain types for the RIS OGD service layer: the raw JSON-serialized-XML
 * envelope RIS returns (`@attr`/`#text` nodes, object-or-array lists, `{ item: … }`
 * wrapped lists) and the normalized shapes the tool handlers consume. Raw types cover
 * exactly the fields the normalizer reads and default to optional — live payloads are
 * sparse and omit fields entirely. Grounded in per-application payloads harvested from
 * the production API 2026-07-05.
 * @module services/ris/types
 */

import type { RisController } from './reference/index.js';

/* ------------------------------------------------------------------------------------ */
/* Raw envelope (JSON-serialized XML)                                                    */
/* ------------------------------------------------------------------------------------ */

/** A value RIS renders as a single node or an array (single-element XML lists collapse). */
export type OneOrMany<T> = T | T[];

/** RIS wrapped list node: `{ item: T | T[] }`; empty elements arrive as `''`. */
export interface RawWrappedList<T> {
  readonly item?: OneOrMany<T>;
}

/** Top-level response shape of every RIS OGD endpoint. */
export interface RawOgdResponse {
  readonly OgdSearchResult?: RawOgdSearchResult;
}

/** Search-result envelope: either document results or an in-band error. */
export interface RawOgdSearchResult {
  readonly Error?: RawRisError;
  readonly OgdDocumentResults?: RawDocumentResults;
  readonly Version?: string;
}

/**
 * In-band error node. The handbook documents `@type` (`"Client"` | `"Server"`), but live
 * responses omit the attribute and prefix `Message` with `soap:Client.` / `soap:Server.`
 * instead (observed 2026-07-05) — classification must check both.
 */
export interface RawRisError {
  readonly '@type'?: string;
  readonly Applikation?: string;
  readonly Message?: string;
}

/** Paged document results. `OgdDocumentReference` is absent when `Hits` is zero. */
export interface RawDocumentResults {
  readonly Hits?: RawHits;
  readonly OgdDocumentReference?: OneOrMany<RawDocumentReference>;
}

/** Hit counter: attributes + text node, all serialized as strings. */
export interface RawHits {
  readonly '@pageNumber'?: string;
  readonly '@pageSize'?: string;
  readonly '#text'?: string;
}

/**
 * One search hit. Regular hits carry `Data`; History responses with
 * `IncludeDeletedDocuments=True` interleave deletion records that carry `Deleted`
 * instead (observed live 2026-07-05) — never both.
 */
export interface RawDocumentReference {
  readonly Data?: RawDocumentData;
  readonly Deleted?: RawDeletedNode;
}

/** Deletion record from the History feed. `Applikation` uses the History name. */
export interface RawDeletedNode {
  readonly Applikation?: string;
  readonly ID?: string;
  readonly ImportTimestamp?: string;
  readonly Organ?: string;
}

/** Hit payload: metadata plus the content-URL list (BgblAlt renders it as `''`). */
export interface RawDocumentData {
  readonly Dokumentliste?: RawDokumentliste | '';
  readonly Metadaten?: RawMetadaten;
}

/** Content-reference list wrapper. */
export interface RawDokumentliste {
  readonly ContentReference?: OneOrMany<RawContentReference>;
}

/** One content reference (main document, attachment, …). */
export interface RawContentReference {
  readonly ContentType?: string;
  readonly Name?: string;
  readonly Urls?: { readonly ContentUrl?: OneOrMany<RawContentUrl> };
}

/** One rendition URL. `DataType` ∈ Xml/Html/Pdf/Rtf/Authentisch/Gif/…. */
export interface RawContentUrl {
  readonly DataType?: string;
  readonly Url?: string;
}

/** Shared metadata: technical identity, general dates, one controller-class node. */
export interface RawMetadaten {
  readonly Allgemein?: RawAllgemein;
  readonly Bezirke?: RawBezirkeMeta;
  readonly Bundesrecht?: RawBundesrechtMeta;
  readonly Gemeinden?: RawGemeindenMeta;
  readonly Judikatur?: RawJudikaturMeta;
  readonly Landesrecht?: RawLandesrechtMeta;
  readonly Sonstige?: RawSonstigeMeta;
  readonly Technisch?: RawTechnisch;
}

/** Technical identity node. */
export interface RawTechnisch {
  readonly Applikation?: string;
  readonly Einbringer?: string;
  readonly ID?: string;
  readonly Organ?: string;
}

/** General dates and the RIS web-view URL. */
export interface RawAllgemein {
  readonly DokumentUrl?: string;
  readonly Geaendert?: string;
  readonly Veroeffentlicht?: string;
}

/** Consolidated-law fields shared by the BrKons and LrKons application nodes. */
export interface RawKonsNode {
  readonly Aenderung?: string;
  readonly ArtikelParagraphAnlage?: string;
  readonly Ausserkrafttretensdatum?: string;
  readonly Eli?: string;
  readonly GesamteRechtsvorschriftUrl?: string;
  readonly Gesetzesnummer?: string;
  readonly Indizes?: RawWrappedList<string>;
  readonly Inkrafttretensdatum?: string;
  readonly Kundmachungsorgan?: string;
  readonly Schlagworte?: string;
  readonly Typ?: string;
}

/** `Metadaten.Bundesrecht` — class fields plus one per-application node. */
export interface RawBundesrechtMeta {
  readonly Begut?: {
    readonly Abkuerzung?: string;
    readonly BeginnBegutachtungsfrist?: string;
    readonly EinbringendeStelle?: string;
    readonly EndeBegutachtungsfrist?: string;
    readonly Schlagworte?: string;
  };
  readonly BgblAlt?: {
    readonly AlexUrl?: string;
    readonly Anfangsseite?: string;
    readonly Fundstelle?: string;
    readonly Kundmachungsdatum?: string;
    readonly Kundmachungsorgan?: string;
    readonly Stueck?: string;
    readonly Typ?: string;
  };
  readonly BgblAuth?: {
    readonly Ausgabedatum?: string;
    readonly Bgblnummer?: string;
    readonly Teil?: string;
    readonly Typ?: string;
  };
  readonly BgblPdf?: {
    readonly Bgblnummer?: string;
    readonly CelexNummer?: string;
    readonly Fundstelle?: string;
    readonly Jahrgang?: string;
    readonly Kundmachungsdatum?: string;
    readonly Teil?: string;
    readonly Typ?: string;
  };
  readonly BrKons?: RawKonsNode;
  readonly Eli?: string;
  readonly Erv?: { readonly Author?: string; readonly Source?: string };
  readonly Kurztitel?: string;
  readonly RegV?: {
    readonly Abkuerzung?: string;
    readonly Beschlussdatum?: string;
    readonly EinbringendeStelle?: string;
    readonly Schlagworte?: string;
  };
  readonly Titel?: string;
}

/** `Metadaten.Landesrecht` — class fields plus one per-application node. */
export interface RawLandesrechtMeta {
  readonly Bundesland?: string;
  readonly Kundmachungsdatum?: string;
  readonly Kurztitel?: string;
  readonly Lgbl?: { readonly Fundstelle?: string; readonly Typ?: string };
  readonly LgblAuth?: {
    readonly CelexNummer?: RawWrappedList<string>;
    readonly EuropeanLegislationIdentifier?: string;
    readonly Lgblnummer?: string;
    readonly Typ?: string;
  };
  readonly LgblNO?: {
    readonly Ausgabedatum?: string;
    readonly Gliederungszahl?: string;
    readonly Indizes?: RawWrappedList<string>;
    readonly StueckNummer?: string;
    readonly Typ?: string;
  };
  readonly LrKons?: RawKonsNode;
  readonly Titel?: string;
  readonly Vbl?: {
    readonly Kundmachungsnummer?: string;
    readonly Kundmachungsorgan?: string;
    readonly Typ?: string;
  };
}

/** Judikatur application keys observed as per-court metadata nodes. */
export type RawJudikaturAppKey =
  | 'AsylGH'
  | 'Bks'
  | 'Bvwg'
  | 'Dok'
  | 'Dsk'
  | 'Gbk'
  | 'Justiz'
  | 'Lvwg'
  | 'Normenliste'
  | 'Pvak'
  | 'Ubas'
  | 'Umse'
  | 'Uvs'
  | 'Verg'
  | 'Vfgh'
  | 'Vwgh';

/** Per-court node fields the normalizer consumes (union across courts, all sparse). */
export interface RawJudikaturAppNode {
  readonly Abkuerzung?: string;
  readonly Anfechtung?: string;
  readonly Anmerkung?: string;
  readonly Bundesland?: string;
  readonly Diskriminierungsgrund?: string;
  readonly EntscheidendeBehoerde?: string;
  readonly Entscheidungsart?: string;
  readonly Fundstelle?: string;
  readonly Gericht?: string;
  readonly Indizes?: RawWrappedList<string>;
  readonly Kommission?: string;
  readonly Kurzinformation?: string;
  readonly Leitsatz?: string;
  readonly Rechtsgebiete?: RawWrappedList<string>;
  readonly Sammlungsnummer?: string;
  readonly Senat?: string;
  readonly Titel?: string;
  readonly Typ?: string;
}

/** `Metadaten.Judikatur` — class fields plus one per-court node. */
export interface RawJudikaturMeta extends Partial<Record<RawJudikaturAppKey, RawJudikaturAppNode>> {
  readonly Dokumenttyp?: string;
  readonly Entscheidungsdatum?: string;
  readonly EntscheidungstextUrl?: string;
  readonly EuropeanCaseLawIdentifier?: string;
  readonly GesamteEntscheidungUrl?: string;
  readonly Geschaeftszahl?: RawWrappedList<string>;
  readonly Normen?: RawWrappedList<string>;
  readonly RechtssaetzeUrl?: string;
  readonly Schlagworte?: string;
}

/** `Metadaten.Bezirke` — class fields plus the Bvb node. */
export interface RawBezirkeMeta {
  readonly Bundesland?: string;
  readonly Bvb?: {
    readonly Bezirksverwaltungsbehoerde?: string;
    readonly Kundmachungsdatum?: string;
    readonly Kundmachungsnummer?: string;
    readonly Kundmachungsorgan?: string;
    readonly Schlagworte?: string;
    readonly Typ?: string;
  };
  readonly Kurztitel?: string;
  readonly Titel?: string;
}

/** `Metadaten.Gemeinden` — class fields plus the Gr / GrA node. */
export interface RawGemeindenMeta {
  readonly Anmerkung?: string;
  readonly Bundesland?: string;
  readonly Gemeinde?: string;
  readonly Geschaeftszahl?: RawWrappedList<string>;
  readonly Gr?: {
    readonly Indizes?: RawWrappedList<string>;
    readonly Inkrafttretensdatum?: string;
  };
  readonly GrA?: {
    readonly Abkuerzung?: string;
    readonly Bezirk?: string;
    readonly Kundmachungsdatum?: string;
    readonly KundmachungsorganNr?: string;
    readonly Schlagworte?: string;
  };
  readonly Kurztitel?: string;
  readonly Titel?: string;
  readonly Typ?: string;
}

/** `Metadaten.Sonstige` — class fields plus one per-collection node. */
export interface RawSonstigeMeta {
  readonly Avn?: {
    readonly Anmerkung?: string;
    readonly Ausserkrafttretensdatum?: string;
    readonly Avnnummer?: string;
    readonly Geschaeftszahl?: string;
    readonly Inkrafttretensdatum?: string;
    readonly Kurzinformation?: string;
    readonly Normen?: RawWrappedList<string>;
    readonly Typ?: string;
  };
  readonly Avsv?: {
    readonly Avsvnummer?: string;
    readonly Dokumentart?: string;
    readonly Kurzinformation?: string;
    readonly Urheber?: string;
  };
  readonly Erlaesse?: {
    readonly Abteilung?: string;
    readonly Ausserkrafttretensdatum?: string;
    readonly Bundesministerium?: string;
    readonly Fundstelle?: string;
    readonly Geschaeftszahl?: RawWrappedList<string>;
    readonly Inkrafttretensdatum?: string;
    readonly Kurzinformation?: string;
    readonly Typ?: string;
  };
  readonly KmGer?: {
    readonly Ausserkrafttretensdatum?: string;
    readonly Gericht?: string;
    readonly GZ?: string;
    readonly Inkrafttretensdatum?: string;
    readonly Kurzinformation?: string;
    readonly Typ?: string;
  };
  readonly Kundmachungsdatum?: string;
  readonly Kurztitel?: string;
  readonly Mrp?: {
    readonly Einbringer?: RawWrappedList<string>;
    readonly Gesetzgebungsperiode?: string;
    readonly Sitzungsdatum?: string;
    readonly Sitzungsnummer?: string;
  };
  readonly PruefGewO?: {
    readonly Anmerkung?: string;
    readonly GZ?: string;
    readonly Inkrafttretensdatum?: string;
    readonly Kurzinformation?: string;
    readonly Typ?: string;
  };
  readonly Schlagworte?: string;
  readonly Spg?: {
    readonly Inkrafttretensdatum?: string;
    readonly Kurzinformation?: string;
    readonly Land?: string;
    readonly Spgnummer?: string;
    readonly Typ?: string;
  };
  readonly Titel?: string;
  readonly Upts?: {
    readonly Entscheidungsdatum?: string;
    readonly GZ?: string;
    readonly Norm?: string;
    readonly Partei?: string;
  };
}

/* ------------------------------------------------------------------------------------ */
/* Normalized shapes                                                                     */
/* ------------------------------------------------------------------------------------ */

/** Rendition URLs keyed by DataType; non-core DataTypes (Gif, Docx, …) land in `other`. */
export interface RisKeyedUrls {
  readonly authentic?: string;
  readonly html?: string;
  readonly other?: readonly { readonly dataType: string; readonly url: string }[];
  readonly pdf?: string;
  readonly rtf?: string;
  readonly xml?: string;
}

/** One normalized content reference (main document, attachment, material, …). */
export interface RisContentReference {
  readonly name?: string;
  readonly type?: string;
  readonly urls: RisKeyedUrls;
}

/** Consolidated-law fields shared by federal (BrKons) and state (LrKons) records. */
export interface RisConsolidatedFields {
  /** Amendment note (Aenderung), CELEX markers preserved in `celexReferences`. */
  readonly amendment?: string;
  /** Systematik index entries (Indizes). */
  readonly indexes: readonly string[];
  /** Entry-into-force date (Inkrafttretensdatum). */
  readonly inForceFrom?: string;
  /** Repeal date (Ausserkrafttretensdatum). */
  readonly inForceUntil?: string;
  /** Keywords (Schlagworte), HTML remnants stripped. */
  readonly keywords?: string;
  /** Law-level grouping key (Gesetzesnummer). */
  readonly lawId?: string;
  /** RIS web view of the whole law (GesamteRechtsvorschriftUrl). */
  readonly lawUrl?: string;
  /** Norm type code (Typ — BG, V, K, …). */
  readonly normType?: string;
  /** Promulgation reference (Kundmachungsorgan). */
  readonly promulgation?: string;
  /** §/Artikel/Anlage label (ArtikelParagraphAnlage). */
  readonly sectionLabel?: string;
}

/** Normalized `Metadaten.Bundesrecht` (BrKons, BgblAuth, BgblPdf, BgblAlt, Begut, RegV, Erv). */
export interface RisBundesrechtMetadata extends RisConsolidatedFields {
  /** Official abbreviation (Begut/RegV Abkuerzung). */
  readonly abbreviation?: string;
  /** ÖNB scan link for BgblAlt issues (AlexUrl). */
  readonly alexUrl?: string;
  /** Translation author (Erv). */
  readonly author?: string;
  readonly celexReferences: readonly string[];
  readonly controller: 'Bundesrecht';
  /** Council-of-ministers adoption date (RegV Beschlussdatum). */
  readonly decided?: string;
  readonly eli?: string;
  /** Gazette number (Bgblnummer / BgblAlt Fundstelle). */
  readonly gazetteNumber?: string;
  /** Gazette issue number (BgblAlt Stueck). */
  readonly issue?: string;
  /** Submitting ministry (Begut/RegV EinbringendeStelle). */
  readonly ministry?: string;
  /** Gazette part (Teil — 1/2/3). */
  readonly part?: string;
  /** Gazette publication date (Ausgabedatum / Kundmachungsdatum). */
  readonly publishedDate?: string;
  /** Review window end (Begut EndeBegutachtungsfrist). */
  readonly reviewDeadline?: string;
  /** Review window start (Begut BeginnBegutachtungsfrist). */
  readonly reviewStart?: string;
  readonly shortTitle?: string;
  /** Translation source (Erv). */
  readonly source?: string;
  /** BgblAlt first page in the issue (Anfangsseite). */
  readonly startPage?: string;
  readonly title?: string;
  /** Gazette volume year (BgblPdf Jahrgang). */
  readonly year?: string;
}

/** Normalized `Metadaten.Landesrecht` (LrKons, LgblAuth, Lgbl, LgblNO, Vbl). */
export interface RisLandesrechtMetadata extends RisConsolidatedFields {
  readonly celexReferences: readonly string[];
  readonly controller: 'Landesrecht';
  readonly eli?: string;
  /** Gazette number (Lgblnummer / Lgbl Fundstelle / Vbl Kundmachungsnummer). */
  readonly gazetteNumber?: string;
  /** Gazette issue number (LgblNO StueckNummer). */
  readonly issue?: string;
  /** Gazette publication date (Kundmachungsdatum / LgblNO Ausgabedatum). */
  readonly publishedDate?: string;
  readonly shortTitle?: string;
  /** Bundesland the record belongs to. */
  readonly state?: string;
  /** LgblNO systematic classification number (Gliederungszahl). */
  readonly systematicNumber?: string;
  readonly title?: string;
}

/** Normalized `Metadaten.Judikatur` (all 16 Judikatur applications). */
export interface RisJudikaturMetadata {
  /** Abbreviation (Normenliste). */
  readonly abbreviation?: string;
  /** Geschäftszahlen — upstream object-or-array coerced. */
  readonly caseNumbers: readonly string[];
  /** Official collection number (Sammlungsnummer — VfSlg/VwSlg/UVS), where present. */
  readonly collectionNumber?: string;
  readonly controller: 'Judikatur';
  /** Deciding court name (Gericht), where the court node carries it. */
  readonly courtName?: string;
  /** Decision date (Entscheidungsdatum). */
  readonly decisionDate?: string;
  /** Rechtssatz vs Text (Dokumenttyp). */
  readonly decisionDocumentType?: string;
  /** Per-court decision kind (Entscheidungsart), where present. */
  readonly decisionKind?: string;
  /** Full-decision web view (GesamteEntscheidungUrl). */
  readonly decisionUrl?: string;
  /** ECLI (EuropeanCaseLawIdentifier). */
  readonly ecli?: string;
  /** Vfgh guiding principle (Leitsatz). */
  readonly guidingPrinciple?: string;
  /** Headnotes web view (RechtssaetzeUrl). */
  readonly headnotesUrl?: string;
  readonly indexes: readonly string[];
  /** Deciding body (EntscheidendeBehoerde — Dsk/Dok/Pvak/Uvs/…). */
  readonly issuingBody?: string;
  /** Keywords (Schlagworte), HTML remnants stripped. */
  readonly keywords?: string;
  /** Justiz legal areas (Rechtsgebiete). */
  readonly legalAreas: readonly string[];
  /** Challenge/legal-force note (Dsk Anfechtung). */
  readonly legalForceNote?: string;
  /** Cited norms (Normen) — coerced to array. */
  readonly normsCited: readonly string[];
  /** Norm type (Normenliste Typ). */
  readonly normType?: string;
  /** Annotation (Anmerkung), HTML remnants stripped. */
  readonly note?: string;
  /** Norm reference (Normenliste Fundstelle). */
  readonly reference?: string;
  /** Bundesland (Lvwg/Uvs). */
  readonly state?: string;
  /** Short summary (Kurzinformation). */
  readonly summary?: string;
  /** Decision-text web view (EntscheidungstextUrl). */
  readonly textUrl?: string;
  /** Title (Normenliste Titel). */
  readonly title?: string;
}

/** Normalized `Metadaten.Bezirke` (Bvb). */
export interface RisBezirkeMetadata {
  readonly controller: 'Bezirke';
  /** District administrative authority (Bezirksverwaltungsbehoerde). */
  readonly districtAuthority?: string;
  /** Promulgation number (Kundmachungsnummer). */
  readonly gazetteNumber?: string;
  readonly keywords?: string;
  /** Norm type (Typ). */
  readonly normType?: string;
  /** Promulgation organ (Kundmachungsorgan). */
  readonly promulgation?: string;
  /** Promulgation date (Kundmachungsdatum). */
  readonly publishedDate?: string;
  readonly shortTitle?: string;
  readonly state?: string;
  readonly title?: string;
}

/** Normalized `Metadaten.Gemeinden` (Gr, GrA). */
export interface RisGemeindenMetadata {
  /** Abbreviation (GrA Abkuerzung). */
  readonly abbreviation?: string;
  readonly caseNumbers: readonly string[];
  readonly controller: 'Gemeinden';
  /** District (GrA Bezirk). */
  readonly district?: string;
  /** Promulgation number (GrA KundmachungsorganNr). */
  readonly gazetteNumber?: string;
  readonly indexes: readonly string[];
  /** Entry-into-force date (Gr Inkrafttretensdatum). */
  readonly inForceFrom?: string;
  readonly keywords?: string;
  /** Municipality name (Gemeinde). */
  readonly municipality?: string;
  /** Norm type (Typ). */
  readonly normType?: string;
  /** Annotation (Anmerkung), HTML remnants stripped. */
  readonly note?: string;
  /** Promulgation date (GrA Kundmachungsdatum). */
  readonly publishedDate?: string;
  readonly shortTitle?: string;
  readonly state?: string;
  readonly title?: string;
}

/** Normalized `Metadaten.Sonstige` (Avsv, Avn, KmGer, PruefGewO, Spg, Erlaesse, Mrp, Upts). */
export interface RisSonstigeMetadata {
  readonly caseNumbers: readonly string[];
  readonly controller: 'Sonstige';
  /** Court whose rules the document carries (KmGer Gericht). */
  readonly courtName?: string;
  /** Upts decision date (Entscheidungsdatum). */
  readonly decisionDate?: string;
  /** Ministry department (Erlaesse Abteilung). */
  readonly department?: string;
  /** Entry-into-force date (Inkrafttretensdatum). */
  readonly inForceFrom?: string;
  /** Repeal date (Ausserkrafttretensdatum). */
  readonly inForceUntil?: string;
  /** Issuing bodies (Urheber / Bundesministerium / Mrp Einbringer list). */
  readonly issuers: readonly string[];
  readonly keywords?: string;
  /** Mrp legislature period (Gesetzgebungsperiode). */
  readonly legislature?: string;
  /** Cited norms (Avn Normen / Upts Norm). */
  readonly normsCited: readonly string[];
  /** Norm type / document type (Typ). */
  readonly normType?: string;
  /** Annotation (Anmerkung), HTML remnants stripped. */
  readonly note?: string;
  /** Serial number (Avsvnummer / Avnnummer / Spgnummer). */
  readonly number?: string;
  /** Upts party the decision concerns (Partei). */
  readonly party?: string;
  /** Spg regional-plan Bundesland (Land). */
  readonly planState?: string;
  /** Publication date (Kundmachungsdatum). */
  readonly publishedDate?: string;
  /** Mrp session date (Sitzungsdatum). */
  readonly sessionDate?: string;
  /** Mrp session number (Sitzungsnummer). */
  readonly sessionNumber?: string;
  readonly shortTitle?: string;
  /** Short summary (Kurzinformation). */
  readonly summary?: string;
  readonly title?: string;
}

/** Controller-class-discriminated normalized metadata. */
export type RisHitMetadata =
  | RisBezirkeMetadata
  | RisBundesrechtMetadata
  | RisGemeindenMetadata
  | RisJudikaturMetadata
  | RisLandesrechtMetadata
  | RisSonstigeMetadata;

/** One normalized search hit. */
export interface RisHit {
  /** Exact `Applikation` code the record belongs to (Technisch.Applikation). */
  readonly application?: string;
  /** Last-changed date in RIS (Allgemein.Geaendert). */
  readonly changed?: string;
  /** All content references (main document first as delivered); empty for BgblAlt. */
  readonly contentReferences: readonly RisContentReference[];
  /** Main document's rendition URLs; `{}` when the application publishes none. */
  readonly contentUrls: RisKeyedUrls;
  /** Technical document number (Technisch.ID) — the key for content-URL construction. */
  readonly documentNumber: string;
  /** RIS web view of the document (Allgemein.DokumentUrl). */
  readonly documentUrl?: string;
  /** Normalized controller-class metadata. */
  readonly metadata: RisHitMetadata;
  /** Issuing organ (Technisch.Organ). */
  readonly organ?: string;
  /** First-published date in RIS (Allgemein.Veroeffentlicht). */
  readonly published?: string;
  /** Submitting body (Technisch.Einbringer). */
  readonly submitter?: string;
}

/** One normalized search-result page. */
export interface RisSearchResult {
  readonly hits: readonly RisHit[];
  /** 1-based page number RIS served. */
  readonly page: number;
  /** Page size RIS applied. */
  readonly pageSize: number;
  /** Total matching documents across all pages. */
  readonly total: number;
}

/**
 * One entry of a History change feed: a changed document in its standard record shape,
 * or a deletion record (only with `includeDeleted`) carrying identity fields alone.
 */
export type RisChange =
  | { readonly kind: 'deleted'; readonly record: RisDeletedRecord }
  | { readonly kind: 'document'; readonly hit: RisHit };

/** A document removed from RIS, as reported by the History feed. */
export interface RisDeletedRecord {
  /** Application the document belonged to — History naming (e.g. `Bundesnormen`). */
  readonly application?: string;
  /** Deletion import timestamp. */
  readonly deletedAt?: string;
  /** Technical document number of the removed document. */
  readonly documentNumber: string;
  /** Issuing organ. */
  readonly organ?: string;
}

/** One normalized History change-feed page. */
export interface RisChangeSet {
  readonly changes: readonly RisChange[];
  /** 1-based page number RIS served. */
  readonly page: number;
  /** Page size RIS applied. */
  readonly pageSize: number;
  /** Total entries across all pages. */
  readonly total: number;
}

/** Result of a document-content fetch from the RIS content host. */
export interface RisDocumentContent {
  /** Body size in bytes (UTF-8). */
  readonly byteSize: number;
  /** Content-Type header reported by the content host, when present. */
  readonly contentType?: string;
  /** Raw response body (HTML or XML rendition). */
  readonly text: string;
  /** Final URL fetched. */
  readonly url: string;
}

/** Re-exported for consumers that route by controller. */
export type { RisController };
