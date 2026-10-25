/**
 * @fileoverview Assertions over the dual-surface envelope `runToolContract` returns — the
 * shape a client receives on the wire, `structuredContent` and `content[]` alike.
 * @module tests/tools/_wire
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import MarkdownIt, { type Token } from 'markdown-it';
import { expect } from 'vitest';

import type { RisHit } from '@/services/ris/types.js';

/** GFM-flavored CommonMark parser — the reading a Markdown-rendering client applies to `content[]`. */
const COMMONMARK = new MarkdownIt('default', { html: true });

/** The result of one `runToolContract` call. */
export type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** A tool error as the client receives it in `structuredContent.error`. */
export interface WireError {
  readonly code: number;
  readonly data?: Record<string, unknown>;
  readonly message: string;
}

/**
 * Run one call through `runToolContract` and return the error the client receives. Assert a
 * declared reason's recovery hint here, not on a direct `definition.handler(...)` throw: the
 * framework fills `data.recovery` from the `errors[]` entry on the factory path, so a throw
 * site that names only the reason carries no hint until then.
 */
export async function contractError(
  ...args: Parameters<typeof runToolContract>
): Promise<WireError> {
  const result = await runToolContract(...args);
  expect(result.isError).toBe(true);
  return (result.structuredContent as { error: WireError }).error;
}

/** Every text block of `content[]`, joined — what a content-only client reads. */
export function contentText(result: ToolResult): string {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n');
}

/**
 * The text a CommonMark parse of `markdown` reads as: each block's inline text (line breaks as
 * `\n`), blocks joined by a blank line, and every node that is not plain text named in place
 * (`⟨em⟩`, `⟨code_inline:x⟩`, `⟨bullet_list_open⟩`) — so a plain-text expectation fails on any
 * syntax that renders live instead of reading back as written.
 */
export function readCommonMark(markdown: string): string {
  const readInline = (children: readonly Token[]): string =>
    children
      .map((token) => {
        if (token.type === 'text' || token.type === 'text_special') return token.content;
        if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
        if (token.nesting === 1) return `⟨${token.tag}⟩`;
        if (token.nesting === -1) return `⟨/${token.tag}⟩`;
        return `⟨${token.type}:${token.content}⟩`;
      })
      .join('');
  return COMMONMARK.parse(markdown, {})
    .flatMap((token) => {
      if (token.type === 'inline') return [readInline(token.children ?? [])];
      if (token.type === 'paragraph_open' || token.type === 'paragraph_close') return [];
      return [`⟨${token.type}⟩`];
    })
    .join('\n\n');
}

/** Every link destination (`href`) a CommonMark parse of `markdown` finds, in document order. */
export function linkDestinations(markdown: string): string[] {
  return COMMONMARK.parse(markdown, {}).flatMap((token) =>
    (token.children ?? []).flatMap((child) =>
      child.type === 'link_open' ? [String(child.attrGet('href') ?? '')] : [],
    ),
  );
}

/**
 * RIS-authored text shaped to render live if `format()` interpolates it raw: a multi-line
 * title whose continuation opens an ordered list, inline emphasis/code/strike/link/HTML,
 * line-leading block markers, a table pipe, and a backslash. A fixture field set to one of
 * these must read back verbatim through {@link readCommonMark}.
 */
export const HOSTILE_TEXT = {
  multiLineTitle: 'Verordnung über die Behandlung des\nZuschusses ab\n1. Jänner 2026',
  listOpener: '1. Absatz eins',
  inline: 'a *b* _c_ `d` ~~e~~ [f](g) <b>h</b>',
  blockMarkers: '# Kopf\n- Punkt\n> Zitat',
  pipeAndBackslash: 'a | b \\ c',
} as const;

/** A string that is one whole http(s) URL — the RIS values `format()` renders as a link. */
export const WEB_URL = /^https?:\/\/\S+$/u;

const HOSTILE_SHAPES: readonly string[] = Object.values(HOSTILE_TEXT);

/**
 * `hit` with every non-URL metadata string and array element replaced by a {@link HOSTILE_TEXT}
 * shape (rotating from `offset`, so records differ), an empty array filled with two, and
 * `overrides` laid on top. `controller` keeps its value — it routes the record's mapping.
 */
export function hostileHit(
  hit: RisHit,
  offset: number,
  overrides: Record<string, unknown>,
): RisHit {
  let next = offset;
  const swap = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return WEB_URL.test(value) ? value : HOSTILE_SHAPES[next++ % HOSTILE_SHAPES.length];
    }
    if (Array.isArray(value)) return (value.length > 0 ? value : ['', '']).map(swap);
    return value;
  };
  const metadata = Object.fromEntries(
    Object.entries(hit.metadata).map(([key, value]) => [
      key,
      key === 'controller' ? value : swap(value),
    ]),
  );
  return { ...hit, metadata: { ...metadata, ...overrides } as RisHit['metadata'] };
}

/** Every string leaf of `value`, depth-first. */
export function stringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value !== null && typeof value === 'object') {
    return Object.values(value).flatMap(stringLeaves);
  }
  return [];
}

/**
 * The format() block of a contract run (`content[0]`; the enrichment trailer after it is the
 * framework's): its Markdown, the CommonMark reading of it, that reading's blank-line-separated
 * parts, each heading's text, and the link destinations.
 */
export function readFormatBlock(result: ToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('expected a text block from format()');
  const text = readCommonMark(block.text);
  const parts = text.split('\n\n');
  const headings = parts.flatMap((part, i) => (part === '⟨heading_open⟩' ? [parts[i + 1]] : []));
  return { headings, hrefs: linkDestinations(block.text), markdown: block.text, parts, text };
}

/** The nodes `format()` itself writes: record headings, `**Label:**` emphasis, and URL links. */
const AUTHORED_NODES = [
  '⟨heading_open⟩',
  '⟨heading_close⟩',
  '⟨strong⟩',
  '⟨/strong⟩',
  '⟨a⟩',
  '⟨/a⟩',
];
/** The nodes of an authored bullet list (the drafts materials list). */
const LIST_NODES = [
  '⟨bullet_list_open⟩',
  '⟨bullet_list_close⟩',
  '⟨list_item_open⟩',
  '⟨list_item_close⟩',
];

/**
 * Assert the format() block renders `records` (non-empty, in output order) one Markdown block
 * each, and that a CommonMark parse of each block reads back that record's every non-URL string
 * verbatim, links exactly that record's URLs (each URL as its own destination, as many times as
 * the record carries it), and holds one heading. Across the whole block, the only nodes are
 * {@link AUTHORED_NODES} — plus `bulletLists` authored bullet lists, counted exactly — and
 * every strong span is a `Label:`. Returns the per-record Markdown blocks.
 */
export function expectReadBack(
  result: ToolResult,
  records: readonly object[],
  { bulletLists = 0 }: { bulletLists?: number } = {},
): string[] {
  expect(records.length).toBeGreaterThan(0);
  const { markdown, text } = readFormatBlock(result);
  const blocks = markdown.split('\n\n');
  expect(blocks).toHaveLength(records.length);
  records.forEach((record, i) => {
    const leaves = stringLeaves(record);
    expect(leaves.length).toBeGreaterThan(0);
    const read = readCommonMark(blocks[i]!);
    for (const leaf of leaves.filter((l) => !WEB_URL.test(l))) expect(read).toContain(leaf);
    expect(linkDestinations(blocks[i]!).toSorted()).toEqual(
      leaves.filter((l) => WEB_URL.test(l)).toSorted(),
    );
    expect(read.match(/⟨heading_open⟩/gu) ?? []).toHaveLength(1);
  });
  expect(text.match(/⟨heading_open⟩/gu) ?? []).toHaveLength(records.length);
  expect(text.match(/⟨bullet_list_open⟩/gu) ?? []).toHaveLength(bulletLists);
  const allowed = bulletLists > 0 ? [...AUTHORED_NODES, ...LIST_NODES] : AUTHORED_NODES;
  for (const node of new Set(text.match(/⟨[^⟩]*⟩/gu))) expect(allowed).toContain(node);
  for (const [, label] of text.matchAll(/⟨strong⟩(.*?)⟨\/strong⟩/gu)) {
    expect(label).toMatch(/^\p{Lu}[\p{L} ]*:$/u);
  }
  return blocks;
}

/**
 * Assert a schema-level argument rejection as it reaches the client: `isError`, InvalidParams
 * (-32602) with the framework's `invalid_arguments` reason, and every phrase present on both
 * surfaces — the structured error message and the `content[]` text as a CommonMark parse reads
 * it (the framework Markdown-escapes error text there, so `|` is written `\|` and reads back `|`).
 */
export function expectArgumentRejection(result: ToolResult, phrases: readonly string[]): void {
  expect(result.isError).toBe(true);
  const { error } = result.structuredContent as {
    error: { code: number; data?: { reason?: string }; message: string };
  };
  expect(error).toMatchObject({
    code: JsonRpcErrorCode.InvalidParams,
    data: { reason: 'invalid_arguments' },
  });
  const text = readCommonMark(contentText(result));
  for (const phrase of phrases) {
    expect(error.message).toContain(phrase);
    expect(text).toContain(phrase);
  }
}
