/**
 * @fileoverview Shared Zod schemas and error-contract plumbing reused across multiple tool
 * definitions.
 * @module mcp-server/tools/definitions/_shared
 */

import type { TypedFail } from '@cyanheads/mcp-ts-core';
import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError, validationError } from '@cyanheads/mcp-ts-core/errors';
import {
  createCounter,
  escapeMarkdownInline,
  logger,
  markdownLink,
  requestContextService,
} from '@cyanheads/mcp-ts-core/utils';

import { getServerConfig } from '@/config/server-config.js';
import { foldStateName } from '@/services/ris/reference/index.js';
import { type RisPageSize, UNRESOLVED_MINISTRY_REASON } from '@/services/ris/request-builder.js';
import type { RisContentFormat } from '@/services/ris/ris-service.js';

/**
 * Markdown links to the renditions a `content_urls` object carries, in html/pdf/rtf/xml order.
 * The order is spelled out here (not read from `RIS_CONTENT_FORMATS`) so this module needs no
 * runtime import of the service, which tool tests replace with a partial mock.
 */
export function renditionLinks(
  urls: Partial<Record<RisContentFormat, string | undefined>>,
): string[] {
  return (['html', 'pdf', 'rtf', 'xml'] as const).flatMap((format) => {
    const url = urls[format];
    return url === undefined ? [] : [markdownLink(format.toUpperCase(), url)];
  });
}

/** Months with 30 days — the only non-February lengths a day of 31 can overshoot. */
const THIRTY_DAY_MONTHS = new Set([4, 6, 9, 11]);

/**
 * True when a shape-valid `YYYY-MM-DD` names a day the month actually has. {@link isoDateString}'s
 * pattern already bounds month to 01–12 and day to 01–31, so only over-long months remain: the
 * four 30-day months, and February's 28/29-day split by leap year.
 */
function isRealCalendarDate(value: string): boolean {
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month === 2) {
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return day <= (leapYear ? 29 : 28);
  }
  return day <= (THIRTY_DAY_MONTHS.has(month) ? 30 : 31);
}

/**
 * An ISO calendar date (YYYY-MM-DD), validated client-side before any upstream call — an
 * impossible date is an input error at every tool that takes one, never a silent upstream
 * rejection reinterpreted downstream.
 *
 * The pattern bounds month and day because it is what reaches the advertised JSON Schema
 * (`pattern`), so a schema-validating client rejects `2026-99-99` without a round trip; the
 * refinement then catches the shape-valid impossibilities a pattern cannot express (31 April,
 * 29 February outside a leap year) and does not serialize.
 */
export const isoDateString = z
  .string()
  .regex(
    /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u,
    'Expected an ISO calendar date in YYYY-MM-DD form.',
  )
  .refine(isRealCalendarDate, 'No such calendar date — check the day against the month and year.');

/**
 * A free-text search filter, validated client-side: a supplied value must carry a
 * non-whitespace character. RIS reads an empty filter as no filter and ignores some
 * whitespace-only ones, so a blank would answer the unfiltered query the caller meant to
 * narrow; omitting the field is the one way to leave a filter unset. The pattern reaches the
 * advertised JSON Schema, so a schema-validating client rejects a blank before the call.
 */
export const filterText = z
  .string()
  .regex(
    /\S/u,
    'Blank or whitespace-only — send a value, or omit the field to leave it unfiltered.',
  );

const PAGE_SIZE_REJECTION =
  'Expected a whole number 1–100 (default 20) — it is served as a page of 10 or 20; raise page to read further results.';

/**
 * Documents per page on every paginated tool: any whole number 1–100, served by
 * {@link servePageSize} at one of the two RIS sizes the tools send. RIS takes only 10, 20, 50,
 * or 100 (`DokumenteProSeite`), and pages of 50 or 100 records are too large to return on both
 * response surfaces, so the service's larger sizes stay unused here. The 100 ceiling, RIS's
 * largest page, bounds absurd input; `min`/`max`/`int` reach the advertised JSON Schema, so a
 * schema-validating client rejects 0, 1.5, or 101 before the call.
 */
export const pageSizeParam = z
  .number({ error: PAGE_SIZE_REJECTION })
  .int({ error: PAGE_SIZE_REJECTION })
  .min(1, { error: PAGE_SIZE_REJECTION })
  .max(100, { error: PAGE_SIZE_REJECTION })
  .optional()
  .describe(
    'Documents per page, 1–100 (default 20). Served as a page of 10 (1–10) or 20 (11–100), with a notice when that differs. For more results, keep the size and raise page.',
  );

/** A page size the paginated tools send RIS. */
type ServedPageSize = Extract<RisPageSize, 10 | 20>;

/** How one requested `page_size` is served. */
export interface ServedPage {
  /** The enrichment sentence disclosing a served size that differs from the request. */
  readonly notice?: string;
  /** The size to send RIS; absent when page_size was omitted, so RIS applies its default 20. */
  readonly pageSize?: ServedPageSize;
}

/**
 * Map a requested `page_size` onto the size the tools send RIS: 10 for 1–10, 20 for 11–100.
 * The served size depends on the request alone, so a caller holding page_size constant while
 * raising page reads every row once, and `page` / `pageSize` / `totalCount` / `truncated` stay
 * exact at the served size. Rounding 11–19 up rather than down never serves fewer rows than the
 * default 20 would.
 */
export function servePageSize(requested: number | undefined): ServedPage {
  if (requested === undefined) return {};
  const pageSize: ServedPageSize = requested <= 10 ? 10 : 20;
  if (pageSize === requested) return { pageSize };
  return {
    notice: `page_size ${requested} served as ${pageSize} — this server serves pages of 10 or 20 documents, so page steps through pages of ${pageSize}.`,
    pageSize,
  };
}

/**
 * Join notice sentences, in order, into the one string `ctx.enrich.notice` carries — it is
 * last-wins, so a page-size disclosure and zero-hit guidance must share a single call.
 * Undefined when no sentence applies.
 */
export function joinNotices(...notices: [...(string | undefined)[], string]): string;
export function joinNotices(...notices: readonly (string | undefined)[]): string | undefined;
export function joinNotices(...notices: readonly (string | undefined)[]): string | undefined {
  const present = notices.filter((notice) => notice !== undefined);
  return present.length > 0 ? present.join(' ') : undefined;
}

/** One date window a tool takes: its `_from` field and value, then its `_to` field and value. */
export type DateWindow = readonly [
  fromField: string,
  from: string | undefined,
  toField: string,
  to: string | undefined,
];

/**
 * The notice for every window whose `_from` is later than its `_to`, or undefined when none is.
 * A reversed window holds no dates, so the tools answer it with an empty page instead of a RIS
 * request — RIS answers most reversed windows with an empty page a caller cannot tell from a
 * real zero-hit, and on Erlaesse with every decree that has no entry-into-force date. Both
 * bounds are `isoDateString` values, so string order is date order; equal bounds are a one-day
 * window, and a one-sided window is open, never reversed. The values are validated dates and
 * the fields are literals, so the notice needs no Markdown escaping.
 */
export function reversedWindowNotice(windows: readonly DateWindow[]): string | undefined {
  const reversed = windows.flatMap(([fromField, from, toField, to]) =>
    from !== undefined && to !== undefined && from > to ? [{ from, fromField, to, toField }] : [],
  );
  if (reversed.length === 0) return undefined;
  const pairs = reversed.map((w) => `${w.fromField} ${w.from} is after ${w.toField} ${w.to}`);
  const swaps = reversed.map((w) => `${w.fromField} ${w.to}, ${w.toField} ${w.from}`);
  return `${pairs.join('; ')} — a reversed window holds no dates, so nothing matches and RIS was not queried. Retry with the bounds swapped: ${swaps.join('; ')}.`;
}

/**
 * The `enrichmentTrailer.notice` entry for a tool whose notice can quote caller text. The
 * framework writes a notice into `content[]` as authored Markdown, so this escapes the whole
 * notice, then quotes every line: `content[]` reads back what `structuredContent.notice` holds,
 * and a one-line notice with nothing to escape renders exactly as the framework's default.
 * Escaping writes each line break as a hard break, so no quoted line is blank. Escaping where
 * the notice is built would put the backslashes into `structuredContent` too.
 */
export const escapedNoticeTrailer = {
  render: (notice: string) =>
    escapeMarkdownInline(notice)
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n'),
};

/**
 * An article token in a `norm` value: `Art` or `Art.` with optional whitespace, or `Artikel`
 * with whitespace, in any case and as a whole word; then a number with at most one attached
 * letter (`6`, `15a`) or an uppercase Roman numeral (`IX`), ending at a word boundary. A joined
 * `Artikel6` is not a token, since no arm would equal it. The keyword is matched letter by letter
 * so only the numeral is case-sensitive, and as one literal prefix, so a failed match never
 * re-reads the text after it under another alternative. Group 1 is the separator, which names
 * the token's spelling ({@link spellingOf}); group 2 is the number.
 */
const ARTICLE_TOKEN =
  /(?<![\p{L}\p{N}_])[Aa][Rr][Tt](\.?\s*|[Ii][Kk][Ee][Ll]\s+)(\d+[A-Za-z]?|[IVXLCDM]+)(?![\p{L}\p{N}_])/gu;

/** The three spellings RIS indexes an article under, in the order the expression lists them. */
const ARTICLE_SPELLINGS = [
  (number: string) => `Art${number}`,
  (number: string) => `Art ${number}`,
  (number: string) => `Artikel ${number}`,
] as const;

const SPELLING_LIST = new Intl.ListFormat('en', { type: 'disjunction' });

/** The sentence naming how RIS indexes article `number`: "Art57, Art 57, or Artikel 57". */
function spellingsSentence(number: string): string {
  return `RIS indexes an article as ${SPELLING_LIST.format(ARTICLE_SPELLINGS.map((spell) => spell(number)))}, and each spelling matches only entries indexed that way.`;
}

/**
 * The spelling a token's separator writes: none is joined, `ikel…` is Artikel, and a period or
 * whitespace is spaced — RIS reads `Art.6` and `Art 6` alike.
 */
function spellingOf(separator: string): 'artikel' | 'joined' | 'spaced' {
  if (separator === '') return 'joined';
  return /^[Ii]/u.test(separator) ? 'artikel' : 'spaced';
}

/**
 * The `norm` grammar's only pairing delimiters: `(`, `)`, and `"`. A value carrying one is sent
 * as written, since an arm wrapped around it could pair the caller's delimiter with another
 * arm's ({@link rewriteNormArticles}, {@link delimitedArticleAdvice}).
 */
const PAIRING_DELIMITER = /[()"]/u;

/** A `norm` value rewritten to search its articles under every spelling RIS indexes. */
export interface NormRewrite {
  /**
   * The `Norm` expression to send: one parenthesized arm per spelling, then the value as written
   * when its articles mix spellings, joined by ODER.
   */
  readonly expression: string;
  /** The sentence naming the expression, quoting caller text — escape it when rendering. */
  readonly notice: string;
}

/**
 * Rewrite the article tokens in a `norm` value so RIS searches every spelling it indexes an
 * article under. RIS matches a norm's tokens in any order and reads a period as nothing, yet
 * `Art6`, `Art 6`, and `Artikel 6` never match one another, so `Art. 6 DSGVO` is sent as
 * `(Art6 DSGVO) ODER (Art 6 DSGVO) ODER (Artikel 6 DSGVO)`, and so is `DSGVO Art6`: each arm
 * the value with every token in one spelling. The result is a superset of the value as written
 * by construction. When every token shares one spelling, one arm reproduces the value: a joined
 * value is its own joined arm, the spaced arm matches whatever an `Art.` spelling did, and an
 * `Artikel` value is its own Artikel arm. When the tokens mix spellings (`Art6 DSGVO UND Art. 7
 * DSGVO`) no arm does, so the value as written is sent as a fourth arm. RIS evaluates `ODER` in
 * this filter (`OR` is a literal word there), and a caller's own UND, ODER, or NICHT keeps its
 * meaning inside each arm.
 *
 * Undefined, so the value is sent as written, when it holds no token or carries a
 * {@link PAIRING_DELIMITER}.
 */
export function rewriteNormArticles(norm: string): NormRewrite | undefined {
  if (PAIRING_DELIMITER.test(norm)) return undefined;
  const value = norm.trim();
  const tokens = Array.from(value.matchAll(ARTICLE_TOKEN));
  const first = tokens[0]?.[2];
  if (first === undefined) return undefined;
  const spellings = new Set(tokens.map(([, separator = '']) => spellingOf(separator)));
  const arms: string[] = ARTICLE_SPELLINGS.map((spell) =>
    value.replace(ARTICLE_TOKEN, (_token: string, _separator: string, number: string) =>
      spell(number),
    ),
  );
  if (spellings.size > 1) arms.push(value);
  const expression = arms.map((arm) => `(${arm})`).join(' ODER ');
  // Spelled out for the first article; the expression shows every article's arms.
  return { expression, notice: `norm searched as ${expression} — ${spellingsSentence(first)}` };
}

/**
 * The zero-hit advice for a `norm` value sent as written although it holds an article token,
 * because it carries `(`, `)`, or `"` ({@link rewriteNormArticles}): RIS matched each article in
 * that one spelling. Undefined for any other value.
 */
export function delimitedArticleAdvice(norm: string): string | undefined {
  if (!PAIRING_DELIMITER.test(norm)) return;
  const number = norm.matchAll(ARTICLE_TOKEN).next().value?.[2];
  if (number === undefined) return;
  return `norm carries ( ) or ", so it was sent as written and each article matched only as spelled — ${spellingsSentence(number)} Drop the ( ) and " to search every spelling, or copy the exact string from a result's norms_cited.`;
}

/** Where a pre-validation fold sits: the tool or resource, and the field it serves. */
export interface FoldSite {
  /** Tool or resource name, e.g. `ris_search_case_law` or `ris_document`. */
  readonly definition: string;
  /** Input field or URI template variable, e.g. `court`. */
  readonly field: string;
}

/** An enum field as a definition declares it: required, optional, or defaulted. */
type EnumField = z.ZodEnum | z.ZodOptional<z.ZodEnum> | z.ZodDefault<z.ZodEnum>;

/** The codes an {@link EnumField} accepts. */
function enumCodes(field: EnumField): string[] {
  return (field instanceof z.ZodEnum ? field : field.unwrap()).options.map(String);
}

/**
 * Argument values a fold rewrote. Attributes are the definition and field names, both
 * author-defined, never the caller's text.
 */
const foldedValues = createCounter(
  'ris.input.folded',
  'Argument values a pre-validation fold rewrote to the code their field takes',
  '{values}',
);

/**
 * `field` behind a fold that rewrites a string argument before the enum validates it, unless
 * `RIS_FOLD_INPUT_SPELLINGS` is false. A rewrite writes one log line naming the definition, the
 * field, and the code, and adds one to `ris.input.folded`; a value already its code does
 * neither. The fold has no request context, so the line goes through the global logger, and it
 * runs once per parse: a call the framework repairs and parses again folds again.
 *
 * Pass the enum with its `.default()` or `.optional()` already applied and chain `.describe()`
 * on the result: the advertised JSON Schema is the inner enum's, so `enum`, `default`, and
 * `required` stay as before — a `.default()` outside the preprocess is dropped from the schema,
 * and a `.describe()` only inside it trips the `describe-on-fields` lint. The description keeps
 * offering only the codes, since that is what the schema advertises.
 */
function foldBeforeValidation<T extends EnumField>(
  field: T,
  site: FoldSite,
  fold: (value: string) => unknown,
) {
  return z.preprocess((value) => {
    if (typeof value !== 'string' || !getServerConfig().foldInputSpellings) return value;
    const folded = fold(value);
    if (folded !== value) {
      foldedValues.add(1, {
        'ris.input.definition': site.definition,
        'ris.input.field': site.field,
      });
      logger.info(
        `Folded ${site.definition} ${site.field} to ${JSON.stringify(folded)} before validation.`,
        requestContextService.createRequestContext({
          operation: 'FoldInputSpelling',
          additionalContext: { ...site, folded },
        }),
      );
    }
    return folded;
  }, field);
}

/**
 * A code-valued enum parameter that also accepts its code in any letter case and with
 * surrounding whitespace — `Vfgh`, `VFGH`, ` vfgh ` — folded to the code before the enum
 * validates it ({@link foldBeforeValidation}). Matching ignores case only while no two codes
 * share a lowercase form, so the fold names one code or none; any other value reaches the enum
 * as sent and is rejected as before.
 */
export function foldCodeCase<T extends EnumField>(field: T, site: FoldSite) {
  const codes = enumCodes(field);
  const byLowercase = new Map(codes.map((code) => [code.toLowerCase(), code]));
  if (byLowercase.size !== codes.length) {
    throw new Error(`${site.definition} ${site.field}: two codes differ only in letter case.`);
  }
  return foldBeforeValidation(
    field,
    site,
    (value) => byLowercase.get(value.trim().toLowerCase()) ?? value,
  );
}

/**
 * A state-valued enum parameter that also accepts the state's German or English name in any
 * capitalization ({@link foldStateName}), folded to the code before the enum validates it
 * ({@link foldBeforeValidation}).
 */
export function foldStateNames<T extends z.ZodDefault<z.ZodEnum> | z.ZodOptional<z.ZodEnum>>(
  field: T,
  site: FoldSite,
) {
  const accepted = new Set(enumCodes(field));
  return foldBeforeValidation(field, site, (value) => foldStateName(value, accepted));
}

/**
 * The three reasons every search-family tool declares for a failure raised below the
 * handler — in the request builder or in `RisService`. Each tool still declares its own
 * full `errors[]` inline (the contract is part of its public surface); this union is only
 * the subset {@link failSearchError} resolves against.
 */
type SearchFailureReason = 'invalid_query' | 'upstream_error' | 'upstream_timeout';

/** The slice of a handler `ctx` the search-failure mappers need. */
interface SearchFailureContext<R extends string = SearchFailureReason> {
  readonly fail: TypedFail<R>;
}

/**
 * Framework codes raised below the handler, mapped to the contract reason describing them.
 *
 * - `ValidationError` — a schema-valid but unsupported parameter combination the request
 *   builder rejected locally, before any upstream call.
 * - `ServiceUnavailable` — RIS unreachable, degraded, or serving an HTML error page.
 * - `Timeout` — the request deadline elapsed. Its own reason rather than a widened
 *   `upstream_error` guard: `ctx.fail` resolves the code from the contract entry, so folding
 *   the two would put -32000 back on the wire for every deadline.
 */
const REASON_BY_CODE = new Map<JsonRpcErrorCode, SearchFailureReason>([
  [JsonRpcErrorCode.ValidationError, 'invalid_query'],
  [JsonRpcErrorCode.ServiceUnavailable, 'upstream_error'],
  [JsonRpcErrorCode.Timeout, 'upstream_timeout'],
]);

/**
 * Input fields a tool routes to a request-builder param of another name, keyed by the builder
 * param — e.g. `{ state: 'state_era' }` where a state-scope rejection is cured by the era.
 * Every other builder param is its snake_case input field written in camelCase.
 */
export type BuilderParamFields = Readonly<Record<string, string>>;

/**
 * The `invalid_query` recovery for a parameter rejected locally, before any RIS request: it
 * names the input field to correct and, when given, the values that field takes. A local
 * rejection is never a page past the end, so it overrides the declared `invalid_query`
 * recovery, which leads with paging because RIS answers an out-of-range page with an error
 * indistinguishable from a bad value. Spread it into `ctx.fail`'s data.
 */
export function localRejectionRecovery(
  field: string,
  accepted: readonly unknown[] = [],
): { recovery: { hint: string } } {
  return {
    recovery: {
      hint:
        accepted.length > 0
          ? `Set ${field} to one of: ${accepted.join(', ')} — or omit ${field}.`
          : `Change or drop ${field}, as the message describes.`,
    },
  };
}

/**
 * Map a request-builder or service failure onto the declared contract, so `reason` reaches
 * the wire and the framework fills the entry's `recovery` from it — neither the builder's
 * `validationError` nor the service's framework errors carry a reason on their own. A builder
 * rejection carries `data.param` (nothing RIS returns does), and gets a recovery naming that
 * field in the caller's vocabulary instead. An unmapped code is returned untouched for the
 * framework to classify.
 *
 * Returns the error for the caller to `throw`, keeping the throw visible at the call site.
 */
export function failSearchError(
  error: unknown,
  ctx: SearchFailureContext,
  fields?: BuilderParamFields,
): unknown {
  if (!(error instanceof McpError)) return error;
  const reason = REASON_BY_CODE.get(error.code);
  if (reason === undefined) return error;
  const param = error.data?.param;
  if (reason !== 'invalid_query' || typeof param !== 'string') {
    return ctx.fail(reason, error.message);
  }
  const field = fields?.[param] ?? param.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`);
  const accepted = error.data?.valid ?? error.data?.alternatives;
  return ctx.fail(
    reason,
    error.message,
    localRejectionRecovery(field, Array.isArray(accepted) ? accepted : []),
  );
}

/**
 * {@link failSearchError} for the tools that take a ministry. The request builder tags a
 * ministry it cannot resolve with `data.reason: 'unresolved_ministry'`; that rejection maps to
 * the tool's own `unresolved_ministry` contract entry, whose recovery points at the ministries
 * table, instead of the generic `invalid_query` advice. Everything else maps as usual.
 */
export function failMinistrySearchError(
  error: unknown,
  ctx: SearchFailureContext<SearchFailureReason | typeof UNRESOLVED_MINISTRY_REASON>,
  fields?: BuilderParamFields,
): unknown {
  if (error instanceof McpError && error.data?.reason === UNRESOLVED_MINISTRY_REASON) {
    return ctx.fail(UNRESOLVED_MINISTRY_REASON, error.message);
  }
  return failSearchError(error, ctx, fields);
}

/** A request-builder unsupported-parameter rejection, as the builder recorded it. */
export interface UnsupportedParam {
  /** Values of the same parameter that *are* mapped for the target application. */
  readonly alternatives: readonly string[];
  /** The builder's own parameter name, e.g. `sortBy`. */
  readonly param: string;
  /** The rejected value, when the rejection was value-specific. */
  readonly value?: string;
}

/**
 * Replace the request builder's unsupported-parameter message with one written in the
 * calling tool's own vocabulary, so the caller reads back a field it actually sent.
 *
 * The builder holds only the resolved RIS application, never the tool input that selected
 * it, so it cannot name the caller's `court`/`scope`/`collection` itself. The handler still
 * has that input in scope here, and `rewrite` returns the finished message — or `undefined`
 * to leave a combination the tool has nothing better to say about untouched.
 *
 * `param` and `application` appearing together identify that rejection; the builder's other
 * `validationError`s (state coverage, ministry expansion) already name what the caller sent
 * and pass through unchanged, as does every error from the service.
 */
export function rewriteUnsupportedParam(
  error: unknown,
  rewrite: (rejected: UnsupportedParam) => string | undefined,
): unknown {
  if (!(error instanceof McpError)) return error;
  const { data } = error;
  if (typeof data?.param !== 'string' || typeof data.application !== 'string') return error;
  const { alternatives, param, value } = data;
  const message = rewrite({
    alternatives: Array.isArray(alternatives) ? (alternatives as string[]) : [],
    param,
    ...(typeof value === 'string' && { value }),
  });
  return message === undefined ? error : validationError(message, data);
}
