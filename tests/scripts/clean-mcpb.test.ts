/**
 * @fileoverview Bundle pruning keeps the MCP SDK's `dist/ext/skills/` runtime modules — which
 * `createApp({ skills })` imports — while still stripping agent docs that dependencies ship at
 * their package root. The cleaner and the post-bundle linter share one selector, so both are
 * checked against the same entries.
 * @module tests/scripts/clean-mcpb.test
 */
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { AGENT_DOC_ENTRY } from '../../scripts/lint-packaging.js';

const entries = [
  'skills/ris-austria-guide/SKILL.md',
  'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/@modelcontextprotocol/core/dist/ext/skills/node.mjs',
  'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
  'node_modules/example/dist/skills/runtime.js',
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/example/skills/guide/reference.md',
  'node_modules/outer/node_modules/@scope/example/skills/guide/reference.md',
  'node_modules/example/.claude/settings.json',
  'node_modules/example/.agents/guide.md',
  'node_modules/example/docs/SKILL.md',
];

const documentation = [
  'node_modules/@cyanheads/mcp-ts-core/framework-skills/add-tool/SKILL.md',
  'node_modules/example/skills/guide/reference.md',
  'node_modules/outer/node_modules/@scope/example/skills/guide/reference.md',
  'node_modules/example/.claude/settings.json',
  'node_modules/example/.agents/guide.md',
  'node_modules/example/docs/SKILL.md',
];

describe('MCPB agent-doc pruning', () => {
  it('keeps runtime modules and the published guide when selecting entries to strip', () => {
    expect(filterAgentDocEntries(entries)).toEqual(documentation);
  });

  it('applies the same selector in the post-bundle linter', () => {
    expect(entries.filter((entry) => AGENT_DOC_ENTRY.test(entry))).toEqual(documentation);
  });
});
