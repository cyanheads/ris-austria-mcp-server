/**
 * @fileoverview Tests for the ris_list_reference tool — every topic returns non-empty,
 * well-shaped data, and format() carries the same data as the structured result.
 * @module tests/tools/ris-list-reference.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { risListReference } from '@/mcp-server/tools/definitions/ris-list-reference.tool.js';
import {
  type IssuingBody,
  RIS_ISSUING_BODIES,
  RIS_MINISTRIES,
} from '@/services/ris/reference/index.js';

const TOPICS = [
  'applications',
  'courts',
  'states',
  'decision_types',
  'decision_kinds',
  'issuing_bodies',
  'ministries',
  'collections',
  'stages',
  'changed_since_intervals',
  'section_types',
  'gazette_parts',
  'law_types',
  'district_authorities',
  'justiz_subject_areas',
  'search_syntax',
  'citation_formats',
] as const;

async function run(topic: (typeof TOPICS)[number]) {
  const ctx = createMockContext();
  const input = risListReference.input.parse({ topic });
  return await risListReference.handler(input, ctx);
}

describe('risListReference', () => {
  for (const topic of TOPICS) {
    it(`returns non-empty, schema-conformant data for topic "${topic}"`, async () => {
      const result = await run(topic);
      expect(result).toEqual(expect.schemaMatching(risListReference.output));
      expect(result.topic).toBe(topic);
      expect(result.summary.length).toBeGreaterThan(20);
      expect(result.entries.length).toBeGreaterThan(0);
      for (const entry of result.entries) {
        expect(entry.value.length).toBeGreaterThan(0);
        expect(entry.label.length).toBeGreaterThan(0);
      }
    });

    it(`format() renders every entry value for topic "${topic}"`, async () => {
      const result = await run(topic);
      const blocks = risListReference.format!(result);
      expect(blocks).toHaveLength(1);
      const text = (blocks[0] as { type: 'text'; text: string }).text;
      for (const entry of result.entries) {
        expect(text).toContain(entry.value);
        for (const detail of entry.details) {
          expect(text).toContain(detail.key);
        }
      }
      for (const note of result.notes) {
        expect(text).toContain(note);
      }
    });
  }

  it('rejects an unknown topic at schema level', () => {
    expect(() => risListReference.input.parse({ topic: 'nonexistent' })).toThrow();
  });

  it('covers all 39 applications with binding status and History aliases', async () => {
    const result = await run('applications');
    expect(result.entries).toHaveLength(39);
    const brkons = result.entries.find((e) => e.value === 'BrKons');
    expect(brkons?.details).toContainEqual({ key: 'History feed name', value: 'Bundesnormen' });
    const bgblalt = result.entries.find((e) => e.value === 'BgblAlt');
    expect(bgblalt?.details).toContainEqual({ key: 'Formats', value: 'none' });
    for (const entry of result.entries) {
      expect(entry.details.some((d) => d.key === 'Binding')).toBe(true);
    }
  });

  it('covers all 17 courts with successor mapping and GZ examples', async () => {
    const result = await run('courts');
    expect(result.entries).toHaveLength(17);
    const uvs = result.entries.find((e) => e.value === 'uvs');
    expect(uvs?.details).toContainEqual({ key: 'Successor', value: 'lvwg' });
    const withGz = result.entries.filter((e) =>
      e.details.some((d) => d.key === 'Geschäftszahl example'),
    );
    expect(withGz).toHaveLength(16); // all except normenliste (a norm index, not decisions)
  });

  it('carries all three Bundesland spellings per state', async () => {
    const result = await run('states');
    expect(result.entries).toHaveLength(9);
    const kaernten = result.entries.find((e) => e.value === 'kaernten');
    expect(kaernten?.details).toContainEqual({
      key: 'Flat enum (most applications)',
      value: 'Kaernten',
    });
    expect(kaernten?.details).toContainEqual({
      key: 'Flat enum (Bvb districts)',
      value: 'Kärnten',
    });
  });

  it('lists the 12 Dsk decision kinds', async () => {
    const result = await run('decision_kinds');
    const dsk = result.entries.find((e) => e.value === 'dsk');
    const values = dsk?.details.find((d) => d.key === 'Values')?.value ?? '';
    expect(values.split(' | ')).toHaveLength(12);
    expect(values).toContain('BescheidBeschwerde');
  });

  it('carries exact composite issuer values for social insurance', async () => {
    const result = await run('issuing_bodies');
    expect(result.entries.length).toBeGreaterThanOrEqual(120);
    const oegk = result.entries.find((e) => e.value === 'Österreichische Gesundheitskasse (ÖGK)');
    expect(oegk?.label).toBe('Avsv Urheber');
  });

  it('shows the accepted abbreviation on every suffixed Avsv row, and says it is accepted (#38)', async () => {
    const result = await run('issuing_bodies');
    const bodies: readonly IssuingBody[] = RIS_ISSUING_BODIES;
    const carrying = bodies.filter((body) => body.abbreviation !== undefined);
    expect(carrying).toHaveLength(28);
    for (const body of carrying) {
      const entry = result.entries.find((e) => e.value === body.value);
      expect(entry?.details, body.value).toContainEqual({
        key: 'Accepted abbreviation',
        value: body.abbreviation,
      });
    }
    const withDetail = result.entries.filter((e) =>
      e.details.some((d) => d.key === 'Accepted abbreviation'),
    );
    expect(withDetail).toHaveLength(28);
    const notes = result.notes.join(' ');
    expect(notes).toContain('abbreviation');
    expect(notes).not.toContain('pass them completely');
    expect(notes).not.toContain('78 notices');
    const text = (risListReference.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('| Österreichische Gesundheitskasse (ÖGK) | Avsv Urheber |');
    expect(text).toContain('Accepted abbreviation');
  });

  it('lists the ministries in office since 2025 (#44)', async () => {
    const result = await run('ministries');
    for (const [abbreviation, composite] of [
      ['BMWET', 'BMWET (Bundesministerium für Wirtschaft, Energie und Tourismus)'],
      ['BMIMI', 'BMIMI (Bundesministerium für Innovation, Mobilität und Infrastruktur)'],
      ['BMEIF', 'BMEIF (Bundesministerium für Europa, Integration und Familie)'],
      ['BMFI', 'BMFI (Bundesministerin für Frauen und Integration)'],
    ] as const) {
      const entry = result.entries.find(
        (e) => e.value === abbreviation && e.details.some((d) => d.value === composite),
      );
      expect(entry, composite).toBeDefined();
    }
    expect(result.entries).toHaveLength(RIS_MINISTRIES.length);
    expect(result.notes.join(' ')).toContain('passed to RIS unchanged');
  });

  it('lists changed_since only under the five collections RIS honors it on (#37)', async () => {
    const result = await run('collections');
    const withRecency = result.entries
      .filter((e) =>
        (e.details.find((d) => d.key === 'Supported parameters')?.value ?? '')
          .split(', ')
          .includes('changed_since'),
      )
      .map((e) => e.value);
    expect(withRecency.sort()).toEqual([
      'council_minutes',
      'court_rules',
      'health_structure_plans',
      'ministerial_decrees',
      'trade_exam_rules',
    ]);
    const notes = result.notes.join(' ');
    expect(notes).not.toMatch(/changed_since[^.]*every collection/u);
    expect(notes).toContain('ris_track_changes');
  });

  it('makes no Kundmachung.Periode claim for changed_since (#37)', async () => {
    const result = await run('changed_since_intervals');
    expect(result.notes.join(' ')).not.toContain('Kundmachung.Periode');
  });

  it('maps ministry abbreviations to full designations', async () => {
    const result = await run('ministries');
    const bmf = result.entries.find(
      (e) => e.value === 'BMF' && e.label === 'Bundesministerium für Finanzen',
    );
    expect(bmf).toBeDefined();
    expect(bmf?.details).toContainEqual({
      key: 'Mrp exact value',
      value: 'BMF (Bundesministerium für Finanzen)',
    });
  });

  it('lists every district authority with its state', async () => {
    const result = await run('district_authorities');
    expect(result.entries.length).toBeGreaterThanOrEqual(70);
    const liezen = result.entries.find((e) => e.value === 'Bezirkshauptmannschaft Liezen');
    expect(liezen?.label).toBe('District commission — Steiermark');
  });

  it('flags the unpopulated Fachgebiet taxonomy', async () => {
    const result = await run('justiz_subject_areas');
    expect(result.entries).toHaveLength(39);
    expect(result.notes.join(' ')).toContain('0 hits');
  });

  it('covers the seven announcement collections with their parameter sets', async () => {
    const result = await run('collections');
    expect(result.entries).toHaveLength(7);
    const decrees = result.entries.find((e) => e.value === 'ministerial_decrees');
    const params = decrees?.details.find((d) => d.key === 'Supported parameters')?.value ?? '';
    expect(params).toContain('norm');
    expect(params).not.toContain('published_from');
  });

  it('renders a markdown table with dynamic detail columns', async () => {
    const result = await run('changed_since_intervals');
    expect(result.entries).toHaveLength(6);
    const text = (risListReference.format!(result)[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('| Value | Label | RIS value |');
    expect(text).toContain('| one_week | Within the last week | EinerWoche |');
  });

  it('escapes backslashes before pipes so cell text survives markdown rendering', () => {
    /**
     * A markdown renderer consumes a backslash standing before ASCII punctuation, so an
     * unescaped one in the source value is dropped from the rendered cell. Escaping runs
     * backslashes first: pipes first would re-escape the backslash it had just introduced,
     * turning the cell's own `\|` delimiter escape into a literal `\|` in the output.
     */
    const result = {
      topic: 'search_syntax',
      summary: 'Escaping fixture — values carrying backslashes and pipes.',
      entries: [
        {
          value: String.raw`x\|y`,
          label: String.raw`a\*b|c`,
          details: [{ key: 'Example', value: String.raw`C:\dir|tail` }],
        },
      ],
      notes: [],
    };

    const text = (risListReference.format!(result)[0] as { type: 'text'; text: string }).text;

    expect(text).toContain(
      `| ${String.raw`x\\\|y`} | ${String.raw`a\\*b\|c`} | ${String.raw`C:\\dir\|tail`} |`,
    );
  });
});
