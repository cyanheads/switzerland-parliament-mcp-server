/**
 * @fileoverview Synthetic member source rows and independent CommonMark parity assertions.
 * @module tests/helpers/member-fixtures
 */

import { expect } from 'vitest';
import { decodeParliamentMarkdown, textContent } from './parliament.js';

/** Synthetic GUID with a stable valid variant, unrelated to any published person. */
export function memberGuid(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

/** Complete source affiliation with deliberately distinct entity and person identifiers. */
export function memberRow(overrides: Record<string, unknown> = {}) {
  return {
    ID: 801,
    PersonNumber: 91,
    Language: 'DE',
    FirstName: 'Zoë',
    LastName: "D'Essai",
    OfficialName: "Zoë D'Essai",
    Active: false,
    Council: 2,
    CouncilName: 'Conseil des États',
    CouncilAbbreviation: 'S',
    Canton: 7,
    CantonName: 'Canton synthétique',
    CantonAbbreviation: 'SY',
    Party: 8,
    PartyName: 'Parti synthétique',
    PartyAbbreviation: 'PSYN',
    ParlGroupNumber: 9,
    ParlGroupName: 'Groupe synthétique',
    ParlGroupAbbreviation: 'GSYN',
    DateJoining: '/Date(0+0060)/',
    DateLeaving: '/Date(86400000)/',
    ...overrides,
  };
}

/** Parliamentary identity excludes unrelated and private source fields. */
export function personRow(overrides: Record<string, unknown> = {}) {
  return {
    ID: 901,
    PersonNumber: 91,
    Language: 'DE',
    FirstName: 'Zoë',
    LastName: "D'Essai",
    OfficialName: "Zoë D'Essai",
    NativeLanguage: 'FR',
    ...overrides,
  };
}

/** Complete synthetic committee membership. */
export function committeeRow(overrides: Record<string, unknown> = {}) {
  return {
    ID: memberGuid(1),
    PersonNumber: 91,
    Language: 'DE',
    CommitteeNumber: 11,
    CommitteeName: 'Commission synthétique',
    Abbreviation: 'CS',
    Abbreviation1: 'CS1',
    Abbreviation2: '',
    CommitteeType: 12,
    CommitteeTypeName: 'Type synthétique',
    CommitteeTypeAbbreviation: 'TS',
    Council: 2,
    CouncilName: 'Conseil des États',
    CouncilAbbreviation: 'S',
    CommitteeFunction: 0,
    CommitteeFunctionName: 'Membre',
    ...overrides,
  };
}

/** Complete synthetic declaration with a published false paid flag. */
export function interestRow(overrides: Record<string, unknown> = {}) {
  return {
    ID: memberGuid(2),
    PersonNumber: 91,
    Language: 'DE',
    InterestName: 'Association synthétique',
    Agency: '',
    InterestType: 0,
    InterestTypeText: 'Intérêt synthétique',
    OrganizationType: 2,
    OrganizationTypeText: 'Association',
    FunctionInAgency: 3,
    FunctionInAgencyText: 'Membre',
    Paid: false,
    SortOrder: 0,
    Modified: '/Date(0-0090)/',
    ...overrides,
  };
}

/** Check every published leaf against independently parsed CommonMark, including JSON string fences. */
export function expectMemberParity(result: {
  structuredContent?: unknown;
  content: readonly { type: string; text?: string }[];
}) {
  const decoded = decodeParliamentMarkdown(textContent(result));
  function visit(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      if (value.length === 0) expect(decoded.strings).toContain(`${path}: []`);
      value.forEach((item, index) => {
        visit(item, `${path}[${index}]`);
      });
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, path ? `${path}.${key}` : key);
      return;
    }
    if (value === undefined) return;
    if (typeof value === 'string' && /^https?:\/\//.test(value))
      expect(decoded.links, path).toContain(value);
    const rendered = `${path}: ${String(value)}`;
    expect(
      decoded.strings.some(
        (paragraph) =>
          paragraph === value ||
          paragraph
            .split('\n')
            .some((line) => line === rendered || (value === '' && line === `${path}:`)),
      ),
      `${path} must survive CommonMark decoding`,
    ).toBe(true);
  }
  visit(result.structuredContent, '');
}
