/**
 * @fileoverview Tests for the ris_list_reference tool — every topic returns non-empty,
 * well-shaped data, and format() carries the same data as the structured result.
 * @module tests/tools/ris-list-reference.tool.test
 */

import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { describe, expect, it } from 'vitest';
import { risListReference } from '@/mcp-server/tools/definitions/ris-list-reference.tool.js';

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
});
