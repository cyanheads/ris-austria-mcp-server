/**
 * @fileoverview Bundle pruning keeps the MCP SDK's `dist/ext/skills/` runtime modules — which
 * `createApp({ skills })` imports — while still stripping agent docs that dependencies ship at
 * their package root. The cleaner and the post-bundle linter share one selector, so both are
 * checked against the same entries.
 * @module tests/scripts/clean-mcpb.test
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';

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
    // The synced linter carries a framework-repo-only import, so load it at run time as its
    // CLI does rather than statically (a static import breaks `tsc`).
    const output = execFileSync(
      process.execPath,
      [
        '--eval',
        'import(process.argv[2]).then(({ AGENT_DOC_ENTRY }) => console.log(JSON.stringify(JSON.parse(process.argv[3]).filter((entry) => AGENT_DOC_ENTRY.test(entry)))));',
        'mcpb-regression',
        new URL('../../scripts/lint-packaging.ts', import.meta.url).href,
        JSON.stringify(entries),
      ],
      { encoding: 'utf8' },
    );
    expect(JSON.parse(output)).toEqual(documentation);
  });
});
