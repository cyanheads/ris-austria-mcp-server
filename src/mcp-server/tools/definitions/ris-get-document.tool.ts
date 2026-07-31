/**
 * @fileoverview ris_get_document — read one RIS document's full text (markdown/html/xml)
 * or its rendition URLs, with explicit binding status and the amtssigniert Authentisch PDF
 * surfaced wherever it exists. Two addressing modes route to the same fetch path:
 * `document_number` + `application`, or a `document_url` from a result's content_urls — the
 * latter also carrying the one route to a draft's companion documents, whose per-record
 * opaque filenames no document number reaches (see {@link COMPANION_STEMS} for the shapes
 * RIS files them under).
 * Format availability varies by application (full text · authentic-PDF-only · PDF-only ·
 * metadata-only) — a text-format request against a non-text application degrades to a
 * `format_unavailable` notice on a success result, never an error. Markdown conversion drops
 * the `.sr-only` screen-reader twin RIS ships beside every abbreviated citation, keeping the
 * visible form; `html` and `xml` pass through untouched. Oversized markdown carrying
 * §/Artikel/Anlage structure overflows to a retrievable section outline (never a silent
 * truncation, and never for a rendition with no such headings); a follow-up call
 * with `sections:[…]` returns just the chosen sections, and a selector matching nothing gets
 * the outline back with a notice rather than the whole document. The shared
 * {@link renderDocument} helper backs both this tool and the `ris://document/…` resource.
 * @module mcp-server/tools/definitions/ris-get-document
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  OUTLINE_VARIANT,
  type OutlineResult,
  outlineOnOverflow,
  type SectionMeta,
} from '@cyanheads/mcp-ts-core/utils';
import { NodeHtmlMarkdown, type TranslatorConfigFactory } from 'node-html-markdown';

import { getServerConfig } from '@/config/server-config.js';
import type { RisApplication, RisBindingStatus } from '@/services/ris/reference/index.js';
import { RIS_APPLICATIONS } from '@/services/ris/reference/index.js';
import {
  getRisService,
  RIS_CONTENT_FORMATS,
  type RisContentFormat,
} from '@/services/ris/ris-service.js';

/** The seven canonical binding labels (Design Decisions › Binding status). */
const BINDING_STATUSES = [
  'authentic',
  'consolidated_informational',
  'historical_record',
  'decision',
  'preparatory',
  'administrative_directive',
  'translation',
] as const satisfies readonly RisBindingStatus[];

/** Requested output format. `markdown` and `html` both read the HTML rendition. */
type DocumentFormat = 'markdown' | 'html' | 'xml' | 'urls_only';

/**
 * Serialized-length budget for inlining document text. Above it, markdown overflows to a
 * §/Artikel/Anlage section outline instead of returning whole — but only when the rendition
 * segments into at least two of those sections. A rendition carrying none of them has nothing
 * to outline and returns whole however large: court decisions, gazette and announcement
 * bodies, and consolidated `§ 0` promulgation records all do, measured live to 399,972 bytes
 * on a Bvwg decision.
 *
 * Sized against what one tool result can carry into a working context (≈10K tokens of legal
 * prose), not against what counts as a pathological document: across live samples the
 * documents callers routinely read land well under it — consolidated-law sections at 2–3 KB,
 * drafts and bills at 6–36 KB — while the multi-act bills and long translations that motivated
 * the outline (71 KB–199 KB) route through it.
 *
 * Handed to `outlineOnOverflow`, which measures `JSON.stringify` length (≈ UTF-8 bytes for
 * the mostly-Latin legal text); the exact `byte_size` is reported separately.
 */
export const OUTLINE_BUDGET_BYTES = 40_000;

const APPLICATION_CODES = RIS_APPLICATIONS.map((app) => app.code) as [string, ...string[]];

const APPLICATION_BY_CODE = new Map<string, RisApplication>(
  RIS_APPLICATIONS.map((app) => [app.code, app]),
);

/** Content-path segment → application, for reverse-mapping a passed document_url. */
const APPLICATION_BY_SEGMENT = new Map<string, RisApplication>(
  RIS_APPLICATIONS.flatMap((app) =>
    app.contentPathSegment !== null ? [[app.contentPathSegment, app] as const] : [],
  ),
);

/**
 * Lowercase file extensions a rendition URL may end in — the constructible
 * `RisContentFormat` set plus the derived `.pdfsig` authentic variant (see
 * {@link authenticPdfFrom}). A `document_url`'s trailing filename must carry one of these;
 * an unknown extension addresses something this tool cannot render.
 */
const RENDITION_EXTENSIONS = new Set<string>([...RIS_CONTENT_FORMATS, 'pdfsig']);

/**
 * Filename stems of a companion document — the `Erläuterungen`, `Textgegenüberstellung`,
 * `Vorblatt und WFA`, cover letter, and annex texts a `Begut` draft or `RegV` bill ships
 * beside its main text, surfaced on a `ris_search_drafts` record's `materials`. The stem is
 * opaque and per-record — the URL is the only handle, so nothing about a companion is
 * reconstructible from a document number, and this list is what decides whether a passed
 * `document_url` may address a file other than the main rendition. Three shapes, every one
 * of the 23,483 companion URLs across the full live Begut + RegV corpus (7,185 records,
 * every page of both applications, drafts from 2003 through 2026):
 *
 * - `{Materialien|Schreiben|Anlagen}_{NNNN}_{UUID}` — 4,763, all on records from 2026.
 * - `COO_{n}_{n}_{n}_{n}` — 18,719, the Fabasoft object address, on every record before
 *   2026. Not a date: the leading group is a constant store id, so nothing here is a year.
 *   Refusing it refused four companion URLs in five (#35).
 * - `{NNNN}_{UUID}` — 1, the ordinal + UUID tail with no prefix, on one RegV record.
 *
 * Each alternative is anchored end to end over hex digits, `_`, and its own literal prefix,
 * so an accepted stem can carry no `/`, `.`, `%`, backslash, or null byte. Widening happens
 * by adding a whole alternative, never by relaxing one into a prefix or substring test — RIS
 * names the per-record inline formula images `Material-COO_…` and `Anlage-COO_…`, ~55 on
 * every draft record, and a passed filename matching none of these shapes is content this
 * tool would otherwise fetch blind inside the document's folder.
 */
const COMPANION_STEMS: readonly RegExp[] = [
  /^(?:Materialien|Schreiben|Anlagen)_\d{4}_[0-9A-F]{8}(?:_[0-9A-F]{4}){3}_[0-9A-F]{12}$/iu,
  /^COO(?:_\d{1,10}){4}$/u,
  /^\d{4}_[0-9A-F]{8}(?:_[0-9A-F]{4}){3}_[0-9A-F]{12}$/iu,
];

/** Whether a `document_url`'s filename stem addresses a companion document. */
function isCompanionStem(stem: string): boolean {
  return COMPANION_STEMS.some((pattern) => pattern.test(stem));
}

/**
 * Drop RIS's screen-reader twin, pass every other span through untouched. RIS renditions
 * carry each abbreviated legal reference twice — the visible citation in
 * `<span aria-hidden="true">` and its spelled-out expansion in `<span class="sr-only">` —
 * which a plain translation concatenates with no separator (`§ 0Paragraph 0`) and which
 * inflates every byte figure derived from the rendered text. The visible form is the twin
 * that survives: it is the canonical citation a caller copies back into `norm`, `title`, or
 * `ris_lookup_citation`.
 */
const dropScreenReaderTwin: TranslatorConfigFactory = ({ node }) =>
  node.classList.contains('sr-only') ? { ignore: true } : {};

/**
 * HTML→markdown converter for the `markdown` format. Markdown only — `html` and `xml` return
 * the authentic rendition byte-for-byte and never route through here.
 *
 * node-html-markdown keeps a separate translator collection per nesting context, and a
 * constructor-supplied custom translator only reaches the top-level one. RIS renders its
 * Inhaltsverzeichnis and Anmerkungen as tables, whose cells carry screen-reader twins of
 * their own, so the strip has to be registered on every collection to reach them.
 */
const MARKDOWN_CONVERTER = ((): NodeHtmlMarkdown => {
  const converter = new NodeHtmlMarkdown();
  for (const collection of [
    converter.translators,
    converter.aTagTranslators,
    converter.codeBlockTranslators,
    converter.tableTranslators,
    converter.tableRowTranslators,
    converter.tableCellTranslators,
  ]) {
    collection.set('span', dropScreenReaderTwin);
  }
  return converter;
})();

/** Map an empty string from a form-based client to `undefined`. */
function meaningful(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined;
}

/** Constructed rendition URLs for a document, keyed by DataType. */
interface RenditionContentUrls {
  html?: string;
  pdf?: string;
  rtf?: string;
  xml?: string;
}

/**
 * A resolved document rendition — the shared unit behind the tool and the resource. A
 * companion document resolves to the same shape, addressed by `contentName` inside the
 * parent document's folder.
 */
export interface DocumentRendition {
  /** Application code the document belongs to (echoed). */
  readonly application: string;
  /** The amtssigniert authentic PDF (.pdfsig), where the application publishes one. */
  readonly authenticPdfUrl?: string;
  /** Legal binding status of the application's documents. */
  readonly bindingStatus: RisBindingStatus;
  /** Full byte size (UTF-8) of the text; present when text was fetched. */
  readonly byteSize?: number;
  /** Constructed rendition URLs (empty for authentic-PDF-only and metadata-only apps). */
  readonly contentUrls: RenditionContentUrls;
  /** Technical document number (echoed). */
  readonly documentNumber: string;
  /** The format served (echoes the request). */
  readonly format: DocumentFormat;
  /** Document text in the requested format; absent for urls_only and unavailable formats. */
  readonly text?: string;
  /** Present when the requested text format is unavailable for this application. */
  readonly unavailableNotice?: string;
}

/** Result of parsing a caller-supplied document_url into an application + document number. */
type ParsedDocumentUrl =
  | {
      readonly application: string;
      /** Companion-document filename stem; absent for a main-document rendition. */
      readonly contentName?: string;
      readonly documentNumber: string;
    }
  | { readonly error: string };

/**
 * Percent-decode one path segment, or `undefined` when it carries a malformed escape
 * (`%ZZ`, a truncated `%A`). `decodeURIComponent` throws `URIError` on those, and a native
 * throw here would escape {@link parseDocumentUrl}'s errors-as-values contract and reach the
 * caller as a bare validation error instead of the tool's declared `unsupported_url`.
 */
function decodePathSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return;
  }
}

/**
 * Parse a caller-supplied `document_url` into `(application, documentNumber)` — errors as
 * values (no throw). Enforces the same host + `/Dokumente/` allowlist as the service's
 * fetch guard, then reverse-maps the content-path segment to its application.
 */
export function parseDocumentUrl(url: string, contentBaseUrl: string): ParsedDocumentUrl {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `"${url}" is not a valid URL` };
  }
  if (parsed.origin !== new URL(contentBaseUrl).origin) {
    return { error: `only ${new URL(contentBaseUrl).origin} URLs are fetchable` };
  }
  if (!parsed.pathname.startsWith('/Dokumente/')) {
    return { error: 'the path is outside the /Dokumente/ tree' };
  }
  const [, segment, rawDocumentNumber, filename, ...rest] = parsed.pathname
    .split('/')
    .filter((part) => part !== '');
  if (segment === undefined || rawDocumentNumber === undefined) {
    return { error: 'the path is not /Dokumente/{segment}/{documentNumber}/…' };
  }
  const app = APPLICATION_BY_SEGMENT.get(segment);
  if (!app) {
    return { error: `path segment "${segment}" is not a recognized RIS application` };
  }
  const documentNumber = decodePathSegment(rawDocumentNumber);
  if (documentNumber === undefined) {
    return { error: `"${rawDocumentNumber}" is not a decodable path segment (malformed % escape)` };
  }
  // A folder URL (…/{segment}/{documentNumber}[/]) carries no trailing filename and resolves
  // fine. A trailing filename addresses one of exactly two things: the main-document
  // rendition, named {documentNumber}.{ext}, or a companion document, named in one of the
  // {@link COMPANION_STEMS} shapes. Anything else — an unknown stem, an unknown extension,
  // deeper nesting — is content this tool would otherwise fetch blind or silently swap for
  // the main document, so it is rejected here. Each of the three causes reports itself: they
  // ask different things of the caller, and a caller who passed a URL a search result handed
  // them learns nothing from being told to pass a URL a search result handed them.
  if (filename !== undefined) {
    const decodedFilename = decodePathSegment(filename);
    if (decodedFilename === undefined) {
      return { error: `"${filename}" is not a decodable filename (malformed % escape)` };
    }
    if (rest.length > 0) {
      return {
        error: `"${decodedFilename}/${rest.join('/')}" nests below the document folder — RIS files every rendition directly in /Dokumente/${segment}/${documentNumber}/, so drop the trailing path`,
      };
    }
    const dot = decodedFilename.lastIndexOf('.');
    const stem = dot === -1 ? decodedFilename : decodedFilename.slice(0, dot);
    const extension = dot === -1 ? '' : decodedFilename.slice(dot + 1).toLowerCase();
    if (!RENDITION_EXTENSIONS.has(extension)) {
      return {
        error: `"${decodedFilename}" does not end in a RIS rendition extension (${[...RENDITION_EXTENSIONS].join(', ')}) — the extension is only checked and then discarded, so pass any rendition URL of the document you want and select the rendition with format`,
      };
    }
    const isMainDocument = stem === documentNumber;
    if (!isMainDocument && !isCompanionStem(stem)) {
      return {
        error: `"${decodedFilename}" is neither ${documentNumber}'s own rendition (${documentNumber}.${extension}) nor one of its companion documents — RIS assigns companion filenames opaquely, so one cannot be composed by hand. Copy a materials[].url from a ris_search_drafts record verbatim, or drop the filename to read ${documentNumber} itself`,
      };
    }
    if (!isMainDocument) {
      return { application: app.code, contentName: stem, documentNumber };
    }
  }
  return { application: app.code, documentNumber };
}

/** Derive the `.pdfsig` (Authentisch) URL from a constructed `.pdf` rendition URL. */
function authenticPdfFrom(pdfUrl: string): string {
  return pdfUrl.replace(/\.pdf$/u, '.pdfsig');
}

/**
 * Construct the rendition URLs for a document from its application's format availability.
 * `buildDocumentContentUrl` throws `ValidationError` for an unsafe document number.
 *
 * A companion document (`contentName`) is published as XML, HTML and PDF on 20,654 of the
 * 23,483 companions in the live Begut + RegV corpus — RTF on 61% of those, the signed
 * `.pdfsig` on none — so those three are what gets constructed. The other 2,829 (12.0%,
 * nearly all Begut covering letters) carry PDF, or PDF and RTF, and nothing else: RIS 404s a
 * rendition it does not list, so the constructed XML and HTML are dead for them and only the
 * PDF resolves. Which case a companion falls in is legible only from the search result that
 * listed it, never from the URL, so the same three are built either way.
 */
function buildRenditionUrls(
  service: ReturnType<typeof getRisService>,
  app: RisApplication,
  documentNumber: string,
  contentName?: string,
): { contentUrls: RenditionContentUrls; authenticPdfUrl?: string } {
  if (app.formats === 'none') return { contentUrls: {} }; // BgblAlt — no content URLs to build
  if (contentName !== undefined) {
    const url = (format: RisContentFormat) =>
      service.buildDocumentContentUrl(app.code, documentNumber, format, contentName);
    return { contentUrls: { xml: url('xml'), html: url('html'), pdf: url('pdf') } };
  }
  const pdf = service.buildDocumentContentUrl(app.code, documentNumber, 'pdf');
  const authenticPdfUrl = app.binding === 'authentic' ? authenticPdfFrom(pdf) : undefined;
  if (app.formats === 'authentic_pdf_only') {
    // The signed PDF is the only rendition; the plain .pdf is not published separately.
    return { contentUrls: {}, ...(authenticPdfUrl !== undefined && { authenticPdfUrl }) };
  }
  if (app.formats === 'pdf_only') return { contentUrls: { pdf } };
  return {
    contentUrls: {
      xml: service.buildDocumentContentUrl(app.code, documentNumber, 'xml'),
      html: service.buildDocumentContentUrl(app.code, documentNumber, 'html'),
      pdf,
      rtf: service.buildDocumentContentUrl(app.code, documentNumber, 'rtf'),
    },
    ...(authenticPdfUrl !== undefined && { authenticPdfUrl }),
  };
}

/** Compose the `format_unavailable` notice for an application with no text rendition. */
function formatUnavailableNotice(
  app: RisApplication,
  format: DocumentFormat,
  urls: { contentUrls: RenditionContentUrls; authenticPdfUrl?: string },
): string {
  if (app.formats === 'authentic_pdf_only') {
    return `${app.code} publishes only the signed authentic PDF (amtssigniert, .pdfsig) — no ${format} rendition exists. Fetch the authentic PDF from authentic_pdf_url${urls.authenticPdfUrl !== undefined ? ` (${urls.authenticPdfUrl})` : ''}.`;
  }
  if (app.formats === 'pdf_only') {
    return `${app.code} publishes a PDF only — no ${format} rendition exists. Fetch the PDF from content_urls.pdf${urls.contentUrls.pdf !== undefined ? ` (${urls.contentUrls.pdf})` : ''}.`;
  }
  return `${app.code} carries no content URLs in RIS — it is metadata-only, with document scans hosted by the Austrian National Library (ÖNB). Retrieve the record and its ÖNB scan link via ris_search_gazette or ris_lookup_citation; RIS serves no fetchable rendition here.`;
}

/**
 * One addressable section of a rendered RIS document — a structural unit sliced from its
 * heading up to the next, plus the leading `Präambel` when the document opens with text
 * before its first heading.
 */
export interface DocumentSection {
  /** UTF-8 byte size of the section text. */
  readonly bytes: number;
  /** Section identifier — a §/Artikel/Anlage marker, article-qualified so names stay unique. */
  readonly name: string;
  /** The section's text, from its heading up to the next heading. */
  readonly text: string;
}

/**
 * Line-leading structural markers of Austrian legal text as the HTML→markdown rendering
 * emits them: ATX headings (`##`/`###`) opening with a paragraph (§ / §§), article
 * (Artikel / Art.), or annex (Anlage) marker. The `#` prefix is required — it is what
 * separates a real heading from the many in-body `§ n` cross-references, which the
 * converter leaves as plain (indented) text.
 */
const SECTION_HEADING =
  /^#{1,6}[ \t]+(§§?[ \t]*\d+[ \t]*[a-z]?|Art(?:ikel|\.)[ \t]*[\dIVXLC]+[ \t]*[a-z]?|Anlage(?:[ \t]+[\dA-Za-z]+)?)/gim;

/**
 * Segment rendered document text into its §/Artikel/Anlage sections. Each heading starts a
 * section running to the next heading; text before the first heading becomes `Präambel`.
 * Paragraph (§) sections are qualified by their containing article (`Artikel 25 § 39`) so
 * names stay unique across a bill that amends many laws; any residual collision gets a
 * ` (n)` suffix. Returns `[]` when the text carries no structural headings (e.g. a raw
 * html/xml rendition) — the caller reads that as "nothing to outline".
 */
export function segmentDocument(text: string): DocumentSection[] {
  const marks = [...text.matchAll(SECTION_HEADING)].map((match) => ({
    index: match.index,
    marker: (match[1] ?? '').replace(/[ \t]+/gu, ' ').trim(),
  }));
  const firstMark = marks[0];
  if (firstMark === undefined) return [];

  const encoder = new TextEncoder();
  const sections: DocumentSection[] = [];
  const counts = new Map<string, number>();
  const push = (name: string, slice: string): void => {
    const seen = (counts.get(name) ?? 0) + 1;
    counts.set(name, seen);
    sections.push({
      name: seen > 1 ? `${name} (${seen})` : name,
      text: slice,
      bytes: encoder.encode(slice).length,
    });
  };

  if (firstMark.index > 0) {
    const preamble = text.slice(0, firstMark.index);
    if (preamble.trim() !== '') push('Präambel', preamble);
  }

  let container = '';
  marks.forEach((mark, i) => {
    const end = marks[i + 1]?.index ?? text.length;
    const isContainer = /^(?:Art|Anlage)/iu.test(mark.marker);
    if (isContainer) container = mark.marker;
    const name = !isContainer && container !== '' ? `${container} ${mark.marker}` : mark.marker;
    push(name, text.slice(mark.index, end));
  });
  return sections;
}

/** Outcome of resolving a `sections:[…]` selector against a rendered document. */
export interface SectionSelection {
  /** The document's whole section roster, largest first — what the caller can re-pick from. */
  readonly available: SectionMeta[];
  /** Concatenated text of the matched sections, in document order; `''` when none matched. */
  readonly text: string;
  /** Requested names that matched no section, in the order requested. */
  readonly unmatched: string[];
}

/**
 * Resolve a `sections:[…]` selector against rendered document text — the selective-retrieval
 * counterpart to the outline. The handler re-fetches the document (the upstream query is
 * deterministic, so it reproduces the same text) and slices it to the requested sections.
 * Reports the unmatched names and the full roster alongside the matched text so the handler
 * can disclose a mismatch instead of silently returning something the caller didn't ask for.
 */
export function selectDocumentSections(text: string, want: readonly string[]): SectionSelection {
  const sections = segmentDocument(text);
  const names = new Set(sections.map((section) => section.name));
  const wanted = new Set(want);
  const matched = sections.filter((section) => wanted.has(section.name));
  return {
    available: sections
      .map(({ name, bytes }) => ({ name, bytes }))
      .sort((a, b) => b.bytes - a.bytes),
    text: matched.map((section) => section.text).join('\n\n'),
    unmatched: [...new Set(want)].filter((name) => !names.has(name)),
  };
}

/** Quote a caller-supplied section-name list for a notice. */
function quoteNames(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(', ');
}

/**
 * Apply the outline-on-overflow contract to rendered document text: whole under the byte
 * budget (or with fewer than two structural sections), else a section outline. Shares
 * {@link segmentDocument} as the section extractor so the tool and the resource segment
 * identically; the `notice` builder is caller-specific (each points at its own re-call).
 */
export function outlineDocument(
  text: string,
  notice: (sections: SectionMeta[]) => string,
): OutlineResult<{ text: string }> {
  return outlineOnOverflow(
    { text },
    {
      budget: OUTLINE_BUDGET_BYTES,
      extract: (doc) => segmentDocument(doc.text).map(({ name, bytes }) => ({ name, bytes })),
      notice,
    },
  );
}

/** Name the three largest sections, quoted, as examples for a re-call notice. */
export function exampleSectionNames(sections: readonly SectionMeta[]): string {
  return sections
    .slice(0, 3)
    .map((section) => `"${section.name}"`)
    .join(', ');
}

/**
 * Render an outline — the section roster the agent picks from — to markdown. Shared by the
 * tool's `format()` (as a content block) and the resource (as its body), so both client
 * surfaces list identical sections. Deliberately says nothing about *why* the outline was
 * returned: the tool emits one both on a byte overflow and on an unmatched `sections`
 * selector, and the accompanying notice is what separates the two.
 */
export function renderOutlineSections(sections: readonly SectionMeta[]): string {
  return [
    `**${sections.length} sections** (retrieve by name):`,
    ...sections.map((section) => `- \`${section.name}\` — ${section.bytes} bytes`),
  ].join('\n');
}

/**
 * Resolve, construct URLs for, and (for text formats on text-bearing applications) fetch
 * and convert one RIS document. Throws framework errors (`validationError` for an unknown
 * application or unsafe document number; `notFound`/`serviceUnavailable`/`timeout` from the
 * content fetch) — callers map these onto their own typed contract.
 *
 * `contentName` addresses a companion document inside the same folder instead of the main
 * rendition; the requested `format` still selects the rendition, exactly as it does for a
 * main document.
 */
export async function renderDocument(
  applicationCode: string,
  documentNumber: string,
  format: DocumentFormat,
  ctx: Context,
  contentName?: string,
): Promise<DocumentRendition> {
  const app = APPLICATION_BY_CODE.get(applicationCode);
  if (!app) {
    throw validationError(`Unknown RIS application "${applicationCode}".`, {
      application: applicationCode,
      valid: [...APPLICATION_BY_CODE.keys()],
    });
  }
  const service = getRisService();
  const urls = buildRenditionUrls(service, app, documentNumber, contentName);
  const base = {
    application: app.code,
    bindingStatus: app.binding,
    contentUrls: urls.contentUrls,
    documentNumber,
    format,
    ...(urls.authenticPdfUrl !== undefined && { authenticPdfUrl: urls.authenticPdfUrl }),
  } satisfies DocumentRendition;

  // No usable payload for the request: a metadata-only application (no URLs at all, any
  // format), or a text format against an application with no text rendition.
  if (app.formats === 'none' || (format !== 'urls_only' && app.formats !== 'full')) {
    return { ...base, unavailableNotice: formatUnavailableNotice(app, format, urls) };
  }
  // urls_only on a full / authentic-PDF-only / PDF-only application — URLs already in base.
  if (format === 'urls_only') return base;

  const fetchFormat: RisContentFormat = format === 'xml' ? 'xml' : 'html';
  const url = service.buildDocumentContentUrl(app.code, documentNumber, fetchFormat, contentName);
  const fetched = await service.fetchDocumentContent(url, ctx);
  const rendered =
    format === 'markdown' ? MARKDOWN_CONVERTER.translate(fetched.text) : fetched.text;
  const encoded = new TextEncoder().encode(rendered);
  ctx.log.info('Document rendered', {
    application: app.code,
    byteSize: encoded.length,
    format,
  });
  return { ...base, byteSize: encoded.length, text: rendered };
}

const ContentUrlsSchema = z
  .object({
    xml: z.string().optional().describe('XML rendition URL (RIS Nutzdaten schema).'),
    html: z.string().optional().describe('HTML rendition URL.'),
    pdf: z.string().optional().describe('PDF rendition URL.'),
    rtf: z.string().optional().describe('RTF rendition URL.'),
  })
  .describe(
    'Constructed rendition URLs. Empty for authentic-PDF-only (Bvb/GrA/KmGer) and metadata-only (BgblAlt) applications — see authentic_pdf_url and the notice. For a companion document (a draft’s Erläuterungen, Textgegenüberstellung, WFA, cover letter, or annex) these are the companion’s own XML/HTML/PDF, not the parent document’s — constructed rather than read back from RIS, so for the roughly one companion in eight that RIS files as a PDF only, xml and html return 404 and pdf is the one that resolves.',
  );

export const risGetDocument = tool('ris_get_document', {
  title: 'Get RIS Document',
  description:
    'Fetch one RIS document’s full text or its rendition URLs, with explicit binding status and the amtssigniert authentic PDF surfaced wherever it exists. Address the document exactly one of two ways: document_number plus application (both copied verbatim from a ris_search_* or ris_lookup_citation result), or a document_url from a result’s content_urls — or, for a draft’s companion documents (Erläuterungen, Textgegenüberstellung, WFA, cover letter, annexes), a ris_search_drafts record’s materials[].url, which is the only route to them. format: markdown (default — the HTML rendition converted to markdown), html (raw HTML rendition), xml (the RIS Nutzdaten XML), or urls_only (no fetch — every rendition URL, including the Authentisch PDF). Format availability varies by application and the tool degrades explicitly, never silently: consolidated law, gazettes, case law, drafts, and most sectoral collections carry full text; district and municipal promulgations and court rules (Bvb, GrA, KmGer) publish only the signed authentic PDF; party-transparency decisions and council minutes (Upts, Mrp) are PDF-only; the 1848–1940 imperial gazettes (BgblAlt) are metadata-only — for these a text-format request returns a format_unavailable notice with the usable URL, not an error. Every result carries binding_status; only authentic (amtssigniert) publications are legally binding. This tool returns content, not fresh metadata — the metadata rides the search/lookup step that produced the document number. When the markdown text overflows the 40,000-byte budget and carries at least two §/Artikel/Anlage headings the tool returns a section outline (kind: outline) instead of truncating; re-call with sections:[…] naming outline entries to retrieve just those, and a name matching no section returns the outline again with a notice rather than the whole document. Outlining needs those headings: a rendition without them — most court decisions, many gazette and announcement bodies, and every raw html/xml rendition — has nothing to outline and returns whole at any size. Markdown drops the screen-reader expansions RIS ships alongside each abbreviated citation, keeping the visible citation form; raw html/xml renditions are returned exactly as published.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    document_number: z
      .string()
      .optional()
      .describe(
        'Technical RIS document number (Technisch.ID), e.g. NOR40262691, JJT_…, BGBLA_2026_II_171 — copy verbatim from a ris_search_* or ris_lookup_citation result. Requires application; mutually exclusive with document_url.',
      ),
    application: z
      .enum(APPLICATION_CODES)
      .optional()
      .describe(
        'RIS application the document belongs to (e.g. BrKons, Dsk, BgblAuth) — copy verbatim from the same result. Required with document_number. Codes and coverage: ris_list_reference topic applications.',
      ),
    document_url: z
      .string()
      .optional()
      .describe(
        'A https://www.ris.bka.gv.at/Dokumente/… rendition URL as returned in a result’s content_urls — the alternative to document_number + application. Also the only way to read a draft’s companion documents: pass a ris_search_drafts record’s materials[].url (the Erläuterungen, Textgegenüberstellung, WFA, cover letter, or annex), whose filenames are opaque and per-record and so cannot be reached through document_number. Every companion filename RIS publishes is accepted, whichever shape it carries. The URL’s own extension is only checked against the rendition extensions RIS uses and is then discarded — format selects which rendition is returned, for a companion exactly as for a main document. A filename that is neither this document’s own rendition nor one of its companions is rejected; companion filenames cannot be composed by hand, so copy one verbatim.',
      ),
    format: z
      .enum(['markdown', 'html', 'xml', 'urls_only'])
      .default('markdown')
      .describe(
        'markdown (default — the HTML rendition converted to markdown), html (raw HTML rendition), xml (RIS Nutzdaten schema), or urls_only (no fetch — all rendition URLs incl. the authentic PDF).',
      ),
    sections: z
      .array(z.string())
      .optional()
      .describe(
        'Section names to retrieve, each copied verbatim from a prior outline response (kind: outline). Omit for the full document — which returns a §/Artikel/Anlage outline instead when the markdown overflows the 40,000-byte budget and carries at least two such headings. A name that matches no section is never silently ignored: a total miss returns the outline (kind: outline) with a notice, a partial miss returns the matched sections with a notice naming other sections to pick from. Applies to markdown only — html, xml, and urls_only carry no headings to select from and return in full.',
      ),
  }),
  output: z.object({
    text: z
      .string()
      .optional()
      .describe(
        'The document text in the requested format. Absent for urls_only and when the application carries no text rendition (see the notice).',
      ),
    format: z
      .enum(['markdown', 'html', 'xml', 'urls_only'])
      .describe('The format served — echoes the requested format.'),
    byte_size: z
      .number()
      .optional()
      .describe(
        'Full UTF-8 byte size of the document text. Present when text was fetched — for an overflowed document (kind: outline) this reports the full text’s size, not the outline payload’s.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'Present and true when the full text isn’t inline because a section outline was returned instead (kind: outline) — either the document overflowed the byte budget, or a sections:[…] selector matched nothing. The notice names which. Retrieve sections via the sections input, or fetch content_urls for the whole artifact.',
      ),
    kind: z
      .enum(['full', 'outline'])
      .describe(
        'full — the complete response (document text, selected sections, or rendition URLs). outline — sections lists the retrievable §/Artikel/Anlage units instead of the text, either because it overflowed the byte budget or because a sections:[…] selector matched nothing; re-call with sections:[…] naming entries from it.',
      ),
    sections: z
      .array(
        OUTLINE_VARIANT.shape.sections.element.describe(
          'A retrievable §/Artikel/Anlage section — its name and UTF-8 byte size.',
        ),
      )
      .optional()
      .describe(
        'Present when kind = outline: the document’s §/Artikel/Anlage sections, largest first, each with its UTF-8 byte size. Copy names into the sections input verbatim to retrieve them.',
      ),
    binding_status: z
      .enum(BINDING_STATUSES)
      .describe(
        'Legal binding status: authentic (amtssigniert, legally binding), consolidated_informational (consolidated view — not binding), historical_record (superseded/pre-e-Recht promulgation), decision (court/tribunal ruling), preparatory (draft/bill/minutes), administrative_directive (binds the administration, not citizens), or translation (unofficial English).',
      ),
    content_urls: ContentUrlsSchema,
    authentic_pdf_url: z
      .string()
      .optional()
      .describe(
        'The amtssigniert authentic PDF (.pdfsig, Authentisch DataType) — the legally binding artifact — where the application publishes one.',
      ),
    document_number: z.string().describe('Technical RIS document number (echoed).'),
    application: z.string().describe('RIS application the document belongs to (echoed).'),
  }),
  enrichment: {
    notice: z
      .string()
      .optional()
      .describe(
        'Present when the requested text format is unavailable for this application (names why and the usable URL), when the document overflowed to a section outline (names how to retrieve sections), or when a sections:[…] entry matched no section (names the unmatched entries).',
      ),
  },
  errors: [
    {
      reason: 'invalid_addressing',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither or both addressing modes were provided, document_number was given without application, or the document_number/application pairing is not a valid RIS document — thrown locally before any fetch.',
      recovery:
        'Provide exactly one addressing mode: document_number plus application (both from one search result), or a document_url from a result’s content_urls.',
    },
    {
      reason: 'unsupported_url',
      code: JsonRpcErrorCode.ValidationError,
      when: 'document_url fails the host + /Dokumente/ path-prefix allowlist, its path segment is not a recognized RIS application, or its trailing filename addresses neither the document’s own rendition nor one of its companion documents — thrown locally, nothing fetched.',
      recovery:
        'Only ris.bka.gv.at /Dokumente/ URLs are fetchable, and only a document’s own rendition or a companion filed in the same folder — copy the URL verbatim from a result’s content_urls or a ris_search_drafts record’s materials, or switch to document_number + application.',
    },
    {
      reason: 'document_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The constructed or passed content URL returned 404.',
      recovery:
        'The document_number/application pairing didn’t resolve — copy both verbatim from a fresh search result, or resolve the citation with ris_lookup_citation. Document numbers are application-specific.',
    },
    {
      reason: 'upstream_error',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The RIS content host was unreachable or returned a server error.',
      retryable: true,
      recovery:
        'The RIS content host is temporarily unavailable — retry the fetch after a short delay.',
    },
    {
      reason: 'upstream_timeout',
      code: JsonRpcErrorCode.Timeout,
      when: 'The content host did not return the rendition within the fetch deadline — typically a cold render, which it performs on first request before caching the result.',
      retryable: true,
      recovery:
        'Retry the identical call once or twice — the host renders a document on first request and caches it, so a later fetch often returns instantly. If it keeps timing out, check document_number against a fresh search result (a wrong number renders a slow 404 that looks identical), then re-call with format: urls_only and fetch content_urls yourself, without this deadline.',
    },
  ],

  async handler(input, ctx) {
    const documentNumber = meaningful(input.document_number);
    const application = meaningful(input.application);
    const documentUrl = meaningful(input.document_url);
    const { format } = input;

    const failAddressing = (message: string) =>
      ctx.fail('invalid_addressing', message, { ...ctx.recoveryFor('invalid_addressing') });

    let resolvedApplication: string;
    let resolvedDocumentNumber: string;
    let resolvedContentName: string | undefined;
    if (documentUrl !== undefined) {
      if (documentNumber !== undefined || application !== undefined) {
        throw failAddressing(
          'Provide document_url OR document_number + application, not both addressing modes.',
        );
      }
      const parsed = parseDocumentUrl(documentUrl, getServerConfig().contentBaseUrl);
      if ('error' in parsed) {
        throw ctx.fail('unsupported_url', `document_url is not fetchable — ${parsed.error}.`, {
          ...ctx.recoveryFor('unsupported_url'),
        });
      }
      resolvedApplication = parsed.application;
      resolvedDocumentNumber = parsed.documentNumber;
      resolvedContentName = parsed.contentName;
    } else {
      if (documentNumber === undefined || application === undefined) {
        throw failAddressing(
          'Provide document_number together with application, or a document_url instead.',
        );
      }
      resolvedApplication = application;
      resolvedDocumentNumber = documentNumber;
    }

    // Map framework errors from resolution/fetch onto this tool's declared contract.
    const rendition = await renderDocument(
      resolvedApplication,
      resolvedDocumentNumber,
      format,
      ctx,
      resolvedContentName,
    ).catch((err: unknown) => {
      if (err instanceof McpError) {
        if (err.code === JsonRpcErrorCode.ValidationError) {
          throw ctx.fail('invalid_addressing', err.message, {
            ...ctx.recoveryFor('invalid_addressing'),
          });
        }
        if (err.code === JsonRpcErrorCode.NotFound) {
          // The contract's recovery is written for the document_number + application mode.
          // A companion was addressed by a URL, and its likeliest 404 is a rendition RIS
          // never filed rather than a mistyped identifier — one companion in eight is filed
          // as PDF (or PDF and RTF) with no html or xml twin to render, nearly all of them
          // review-draft covering letters, and RIS 404s a rendition it does not list.
          throw ctx.fail(
            'document_not_found',
            err.message,
            resolvedContentName === undefined
              ? { ...ctx.recoveryFor('document_not_found') }
              : {
                  recovery: {
                    hint: `This companion document has no ${format} rendition — about one in eight is filed as a PDF with no text rendition at all, and RIS returns 404 for a rendition it does not publish. Re-call with format: urls_only and fetch content_urls.pdf yourself. If the PDF 404s too, the URL itself is stale — take a fresh one from a ris_search_drafts record's materials.`,
                  },
                },
          );
        }
        if (err.code === JsonRpcErrorCode.ServiceUnavailable) {
          throw ctx.fail('upstream_error', err.message, { ...ctx.recoveryFor('upstream_error') });
        }
        // Its own reason, not a widened upstream_error guard: `ctx.fail` resolves the code
        // from the contract entry, so folding a deadline into upstream_error would report
        // -32000 for it — and the two want different recovery (degraded host vs. cold render).
        if (err.code === JsonRpcErrorCode.Timeout) {
          throw ctx.fail('upstream_timeout', err.message, {
            ...ctx.recoveryFor('upstream_timeout'),
          });
        }
      }
      throw err;
    });

    const base = {
      application: rendition.application,
      binding_status: rendition.bindingStatus,
      content_urls: rendition.contentUrls,
      document_number: rendition.documentNumber,
      format: rendition.format,
      ...(rendition.authenticPdfUrl !== undefined && {
        authentic_pdf_url: rendition.authenticPdfUrl,
      }),
    };

    // No text payload — format_unavailable (with its notice) or urls_only. Complete either way.
    if (rendition.text === undefined) {
      if (rendition.unavailableNotice !== undefined) ctx.enrich.notice(rendition.unavailableNotice);
      return { ...base, kind: 'full' as const };
    }

    const { byteSize } = rendition;
    const requestedSections = input.sections?.filter((name) => name.trim() !== '') ?? [];

    // Selective retrieval — the re-call after an outline. Every outcome is disclosed: a
    // partial match names the entries that were dropped, and a total miss returns the section
    // roster (driven by the no-match, not by the byte budget) so the caller can tell "your
    // names were wrong" from "that section really is that large".
    if (requestedSections.length > 0) {
      const selection = selectDocumentSections(rendition.text, requestedSections);
      if (selection.text !== '') {
        if (selection.unmatched.length > 0) {
          // Names candidates from the roster rather than promising an outline on a re-call
          // without sections:[…] — that re-call only outlines a document over the byte
          // budget, and returns the whole text for every document under it.
          ctx.enrich.notice(
            `Returned only the matched sections — ${quoteNames(selection.unmatched)} named no section of this document and ${selection.unmatched.length === 1 ? 'was' : 'were'} skipped. This document has ${selection.available.length} §/Artikel/Anlage sections; copy a name verbatim and re-call ris_get_document with the same addressing — e.g. ${exampleSectionNames(selection.available)}.`,
          );
        }
        return {
          ...base,
          kind: 'full' as const,
          text: selection.text,
          byte_size: new TextEncoder().encode(selection.text).length,
        };
      }
      if (selection.available.length > 0) {
        ctx.enrich.notice(
          `sections:[…] matched nothing — ${quoteNames(selection.unmatched)} named no section of this document, so the outline below is a selector mismatch, not a size overflow. Copy a name verbatim from sections and re-call ris_get_document with the same addressing — e.g. ${exampleSectionNames(selection.available)}.`,
        );
        return {
          ...base,
          kind: 'outline' as const,
          sections: selection.available,
          truncated: true,
          ...(byteSize !== undefined && { byte_size: byteSize }),
        };
      }
      // Nothing to select from and nothing to list — an html/xml rendition or markdown with
      // no §/Artikel/Anlage headings. Say so, then return the document whole below.
      ctx.enrich.notice(
        `sections:[…] was ignored — this rendition carries no §/Artikel/Anlage headings to select from, so ${quoteNames(selection.unmatched)} could not be resolved. The whole document follows.`,
      );
    }

    // Disclosure — whole text under budget (or unsegmentable), else a section outline.
    const decision = outlineDocument(
      rendition.text,
      (sections) =>
        `Document too large to return in full${byteSize !== undefined ? ` (${byteSize} bytes)` : ''}. Re-call ris_get_document with the same addressing plus sections:[…] naming entries from the outline — e.g. ${exampleSectionNames(sections)}.`,
    );
    if (decision.kind === 'full') {
      return {
        ...base,
        kind: 'full' as const,
        text: decision.text,
        ...(byteSize !== undefined && { byte_size: byteSize }),
      };
    }
    ctx.enrich.notice(decision.notice);
    return {
      ...base,
      kind: 'outline' as const,
      sections: decision.sections,
      truncated: true,
      ...(byteSize !== undefined && { byte_size: byteSize }),
    };
  },

  // format() populates content[] — the markdown twin of structuredContent. Every output
  // field renders here; the notice rides the enrichment trailer. The full-text (`text`) and
  // outline (`sections`) arms render on field presence, independently — never branch on
  // `kind` (format-parity walks one sample with every optional field populated at once).
  format: (result) => {
    const lines = [`## ${result.document_number} (${result.application})`];
    lines.push(
      `**Binding:** ${result.binding_status} | **Format:** ${result.format} | **Kind:** ${result.kind}`,
    );
    if (result.byte_size !== undefined) {
      lines.push(
        `**Size:** ${result.byte_size} bytes${result.truncated === true ? ' (truncated — retrieve sections from the outline below)' : ''}`,
      );
    }
    if (result.authentic_pdf_url !== undefined) {
      lines.push(`**Authentic PDF:** ${result.authentic_pdf_url}`);
    }
    const urls = (['html', 'pdf', 'rtf', 'xml'] as const)
      .filter((key) => result.content_urls[key] !== undefined)
      .map((key) => `[${key.toUpperCase()}](${result.content_urls[key]})`);
    if (urls.length > 0) lines.push(`**Renditions:** ${urls.join(' · ')}`);
    if (result.sections !== undefined) lines.push('', renderOutlineSections(result.sections));
    if (result.text !== undefined) lines.push('', result.text);
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
