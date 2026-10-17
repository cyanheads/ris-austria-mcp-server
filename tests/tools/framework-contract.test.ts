/**
 * @fileoverview RIS tool contract coverage through the framework's production rendering.
 * @module tests/tools/framework-contract
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { risListReference } from '@/mcp-server/tools/definitions/ris-list-reference.tool.js';

describe('RIS framework tool contract', () => {
  it('renders the reference result on both response surfaces', async () => {
    const result = await runToolContract(risListReference, { topic: 'states' });
    expect(result.isError).not.toBe(true);
    const data = risListReference.output.parse(result.structuredContent);
    const text = result.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    expect(text).toContain(data.summary);
    for (const entry of data.entries) {
      expect(text).toContain(entry.value);
      expect(text).toContain(entry.label);
      for (const detail of entry.details) {
        expect(text).toContain(detail.key);
        expect(text).toContain(detail.value);
      }
    }
    for (const note of data.notes) expect(text).toContain(note);
  });

  it('returns InvalidParams on both wire surfaces for an unknown root key', async () => {
    const child = spawn(
      'bun',
      ['run', fileURLToPath(new URL('../../src/index.ts', import.meta.url))],
      {
        env: {
          ...process.env,
          MCP_TRANSPORT_TYPE: 'stdio',
          MCP_AUTH_MODE: 'none',
          MCP_LOG_LEVEL: 'emerg',
          OTEL_ENABLED: 'false',
        },
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    const exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    const replies = lines[Symbol.asyncIterator]();
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'ris-contract-test', version: '1.0.0' },
          },
        })}\n`,
      );
      expect(JSON.parse((await replies.next()).value!)).toMatchObject({
        id: 1,
        result: { protocolVersion: '2025-11-25' },
      });
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'ris_list_reference',
            arguments: { topic: 'states', extra: true },
          },
        })}\n`,
      );
      /**
       * Both surfaces are asserted by containment, not byte-exact text: the framework
       * appends the synthesized recovery hint and the reason/retryable terms to the
       * rejection text, so the wording moves between releases while the offending key,
       * the code, and the reason stay put.
       */
      expect(JSON.parse((await replies.next()).value!)).toMatchObject({
        id: 2,
        result: {
          isError: true,
          structuredContent: {
            error: { code: JsonRpcErrorCode.InvalidParams, data: { reason: 'invalid_arguments' } },
          },
          content: expect.arrayContaining([
            expect.objectContaining({ type: 'text', text: expect.stringContaining('extra') }),
          ]),
        },
      });
    } finally {
      lines.close();
      child.kill('SIGTERM');
      await exited;
    }
  }, 15_000);

  it('declares server instructions within 2,048 bytes, naming only registered tools', async () => {
    const child = spawn(
      'bun',
      ['run', fileURLToPath(new URL('../../src/index.ts', import.meta.url))],
      {
        env: {
          ...process.env,
          MCP_TRANSPORT_TYPE: 'stdio',
          MCP_AUTH_MODE: 'none',
          MCP_LOG_LEVEL: 'emerg',
          OTEL_ENABLED: 'false',
        },
        stdio: ['pipe', 'pipe', 'inherit'],
      },
    );
    const exited = once(child, 'exit');
    const lines = createInterface({ input: child.stdout });
    const replies = lines[Symbol.asyncIterator]();
    try {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'ris-contract-test', version: '1.0.0' },
          },
        })}\n`,
      );
      const { instructions } = JSON.parse((await replies.next()).value!).result as {
        instructions?: unknown;
      };
      expect(typeof instructions).toBe('string');
      const text = instructions as string;
      // Claude Code truncates server instructions longer than this, mid-sentence.
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);
      // The citation entry point names every cite class ris_lookup_citation resolves, ECLI
      // included, and the norm chain reflects a default search that returns decision texts too.
      expect(text).toContain('a Geschäftszahl or ECLI) → ris_lookup_citation');
      expect(text).toContain('finds the Rechtssatz headnotes and decision texts citing it');

      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      const { tools } = JSON.parse((await replies.next()).value!).result as {
        tools: { name: string }[];
      };
      const registered = tools.map((tool) => tool.name);

      // A trailing `_*` names a tool family ("the ris_search_* tool"), which must match one.
      const named = [...text.matchAll(/\bris_[a-z]+(?:_[a-z]+)*(_\*)?/g)];
      expect(named.length).toBeGreaterThan(0);
      for (const [mention, family] of named) {
        if (family === undefined) expect(registered).toContain(mention);
        else {
          const prefix = mention.slice(0, -1);
          expect(registered.some((name) => name.startsWith(prefix))).toBe(true);
        }
      }
      for (const entryPoint of [
        'ris_lookup_citation',
        'ris_track_changes',
        'ris_get_document',
        'ris_search_case_law',
        'ris_list_reference',
      ]) {
        expect(text).toContain(entryPoint);
      }
    } finally {
      lines.close();
      child.kill('SIGTERM');
      await exited;
    }
  }, 15_000);
});
