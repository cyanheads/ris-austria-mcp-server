/**
 * @fileoverview The seven announcement collections served by `ris_search_announcements`
 * (the Sonstige controller minus Upts), with each collection's supported tool parameters.
 * Five of the seven are legally binding authentic publications.
 * @module services/ris/reference/collections
 */

/** One sectoral announcement collection. */
export interface AnnouncementCollection {
  /** RIS `Applikation` value it routes to. */
  readonly application: string;
  /** Whether documents are amtssignierte, legally binding publications. */
  readonly authentic: boolean;
  /** Value used by the tool's `collection` parameter. */
  readonly code: string;
  /** Coverage window, when documented. */
  readonly coverage: string | null;
  /** Official German designation. */
  readonly germanName: string;
  /** English name. */
  readonly name: string;
  /** Tool parameters valid for this collection (besides paging/sorting/changed_since). */
  readonly params: readonly string[];
}

/** All seven announcement collections. */
export const RIS_COLLECTIONS = [
  {
    code: 'social_insurance',
    application: 'Avsv',
    name: 'Official social-insurance notices',
    germanName: 'Amtliche Verlautbarungen der Sozialversicherung',
    authentic: true,
    coverage: '2002 and later',
    params: ['query', 'title', 'number', 'published_from', 'published_to', 'issuer'],
  },
  {
    code: 'veterinary',
    application: 'Avn',
    name: 'Official veterinary notices',
    germanName: 'Amtliche Veterinärnachrichten',
    authentic: true,
    coverage: '2004-09-15 and later',
    params: [
      'query',
      'title',
      'number',
      'published_from',
      'published_to',
      'in_force_as_of',
      'norm',
      'case_number',
      'type',
    ],
  },
  {
    code: 'court_rules',
    application: 'KmGer',
    name: 'Court rules of procedure and case-allocation plans',
    germanName: 'Kundmachungen der Gerichte',
    authentic: true,
    coverage: 'Currently LVwG Tirol and LVwG Vorarlberg only',
    params: ['query', 'title', 'published_from', 'published_to', 'in_force_as_of', 'type'],
  },
  {
    code: 'trade_exam_rules',
    application: 'PruefGewO',
    name: 'Trade-exam regulations',
    germanName: 'Prüfungsordnungen gemäß Gewerbeordnung',
    authentic: true,
    coverage: null,
    params: ['query', 'title', 'published_from', 'published_to', 'in_force_as_of', 'type'],
  },
  {
    code: 'health_structure_plans',
    application: 'Spg',
    name: 'Health structure plans',
    germanName: 'Strukturpläne Gesundheit (ÖSG, RSG)',
    authentic: true,
    coverage: null,
    params: [
      'query',
      'title',
      'number',
      'published_from',
      'published_to',
      'in_force_as_of',
      'plan_type',
      'plan_state',
    ],
  },
  {
    code: 'ministerial_decrees',
    application: 'Erlaesse',
    name: 'Federal-ministry decrees',
    germanName: 'Erlässe der Bundesministerien',
    authentic: false,
    coverage: null,
    params: [
      'query',
      'title',
      'in_force_as_of',
      'entered_force_from',
      'entered_force_to',
      'issuer',
      'norm',
      'case_number',
      'department',
    ],
  },
  {
    code: 'council_minutes',
    application: 'Mrp',
    name: 'Council-of-ministers minutes',
    germanName: 'Ministerratsprotokolle',
    authentic: false,
    coverage: '2004 and later',
    params: ['query', 'published_from', 'published_to', 'issuer', 'session_number', 'legislature'],
  },
] as const satisfies readonly AnnouncementCollection[];
