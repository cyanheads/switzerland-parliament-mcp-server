/**
 * @fileoverview Synthetic roll-call data and independent public-surface assertions.
 * @module tests/helpers/vote-fixtures
 */

import { expect } from 'vitest';
import { decodeParliamentMarkdown, textContent } from './parliament.js';

/** Published metadata intentionally carries untouched punctuation and a timezone. */
export const voteRow = {
  ID: 500,
  Language: 'DE',
  BusinessNumber: 20991234,
  BusinessShortNumber: '99.1234',
  BusinessTitle: ' Étude [A] *B* \\ C ',
  Subject: '<p>Original\r\nsubject</p>',
  MeaningYes: 'Oui — inchangé',
  MeaningNo: '',
  VoteEnd: '/Date(0)/',
  VoteEndWithTimezone: '/Date(0+0120)/',
};

/** Independent literal expected metadata rather than a production-normalized fixture. */
export const voteSummary = {
  voteId: '500',
  metadataLanguage: 'de',
  sourceUrl: "https://ws.parlament.ch/odata.svc/Vote(ID=500,Language='DE')?$format=json",
  businessId: '20991234',
  businessShortNumber: '99.1234',
  businessTitle: ' Étude [A] *B* \\ C ',
  subject: '<p>Original\r\nsubject</p>',
  meaningYes: 'Oui — inchangé',
  meaningNo: '',
  endTime: '1970-01-01T02:00:00.000+02:00',
};

/** Small complete member record, with affiliation explicitly tied to this roll call. */
export function votingRow(id: number) {
  return {
    ID: id,
    Language: 'DE',
    IdVote: 500,
    PersonNumber: id + 1000,
    FirstName: 'Prénom',
    LastName: `Synthetic ${id}`,
    ParlGroupCode: id % 2 === 0 ? 'B' : 'A',
    ParlGroupName: id % 2 === 0 ? 'Groupe B' : 'Groupe A',
    Decision: id % 2 === 0 ? 2 : 1,
    DecisionText: id % 2 === 0 ? 'Non' : 'Oui',
  };
}

/** Reconstruct all scalar values and URLs from a content-only CommonMark consumer. */
export function expectVoteParity(result: {
  structuredContent?: unknown;
  content: readonly { type: string; text?: string }[];
}) {
  const decoded = decodeParliamentMarkdown(textContent(result));
  const visit = (value: unknown): void => {
    if (typeof value === 'string')
      expect(
        decoded.strings.some((line) => line.includes(value)),
        value,
      ).toBe(true);
    else if (typeof value === 'number' || typeof value === 'boolean')
      expect(
        decoded.strings
          .flatMap((line) => line.split('\n'))
          .some((line) => line.endsWith(`: ${String(value)}`)),
      ).toBe(true);
    else if (Array.isArray(value)) for (const item of value) visit(item);
    else if (value !== null && typeof value === 'object')
      for (const item of Object.values(value)) visit(item);
  };
  visit(result.structuredContent);
  return decoded;
}
