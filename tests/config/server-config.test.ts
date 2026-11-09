/**
 * @fileoverview Environment boundary coverage for optional RIS configuration.
 * @module tests/config/server-config
 */
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('RIS environment configuration', () => {
  it.each(['', `\${user_config.ris_api_base_url}`])(
    'uses defaults for unset value %j',
    async (value) => {
      vi.resetModules();
      vi.stubEnv('RIS_API_BASE_URL', value);
      vi.stubEnv('RIS_CONTENT_BASE_URL', value);
      vi.stubEnv('RIS_CONTACT', value);
      vi.stubEnv('RIS_FOLD_INPUT_SPELLINGS', value);
      const { getServerConfig } = await import('@/config/server-config.js');
      expect(getServerConfig()).toEqual({
        apiBaseUrl: 'https://data.bka.gv.at/ris/api/v2.6',
        // www.ris.bka.gv.at answers automated clients with a bot-check page; ogd. serves
        // the same /Dokumente/ tree to them (#75).
        contentBaseUrl: 'https://ogd.ris.bka.gv.at',
        contact: undefined,
        foldInputSpellings: true,
      });
    },
  );

  it('preserves supplied URLs and embedded placeholder text', async () => {
    vi.resetModules();
    vi.stubEnv('RIS_API_BASE_URL', 'https://api.example.test/v2.6');
    vi.stubEnv('RIS_CONTENT_BASE_URL', 'https://content.example.test');
    vi.stubEnv('RIS_CONTACT', `research-\${team}@example.test`);
    vi.stubEnv('RIS_FOLD_INPUT_SPELLINGS', 'false');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig()).toEqual({
      apiBaseUrl: 'https://api.example.test/v2.6',
      contentBaseUrl: 'https://content.example.test',
      contact: `research-\${team}@example.test`,
      foldInputSpellings: false,
    });
  });

  it.each([
    ['true', true],
    ['FALSE', false],
    ['0', false],
    ['1', true],
  ])('reads RIS_FOLD_INPUT_SPELLINGS %j as %s', async (value, expected) => {
    vi.resetModules();
    vi.stubEnv('RIS_FOLD_INPUT_SPELLINGS', value);
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(getServerConfig().foldInputSpellings).toBe(expected);
  });

  it('refuses a RIS_FOLD_INPUT_SPELLINGS that is not a boolean, naming the variable', async () => {
    vi.resetModules();
    vi.stubEnv('RIS_FOLD_INPUT_SPELLINGS', 'maybe');
    const { getServerConfig } = await import('@/config/server-config.js');
    expect(() => getServerConfig()).toThrow(
      expect.objectContaining({
        code: JsonRpcErrorCode.ConfigurationError,
        message: expect.stringContaining('RIS_FOLD_INPUT_SPELLINGS (foldInputSpellings)'),
      }),
    );
  });
});
