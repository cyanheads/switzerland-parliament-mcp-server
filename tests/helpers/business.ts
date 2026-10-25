/**
 * @fileoverview Synthetic business records and independent public-surface assertions.
 * @module tests/helpers/business
 */

import { z } from '@cyanheads/mcp-ts-core';
import { expect } from 'vitest';
import { decodeParliamentMarkdown, textContent } from './parliament.js';

/** Complete synthetic summary, with an unknown status and explicit timezone offset. */
export const businessRow = {
  ID: 20991234,
  Language: 'DE',
  BusinessShortNumber: '99.1234',
  Title: 'Étude [A] *B* \\ C | D',
  BusinessType: 3,
  BusinessTypeName: 'Synthetic motion',
  BusinessTypeAbbreviation: 'Mo.',
  BusinessStatus: 9999,
  BusinessStatusText: '',
  BusinessStatusDate: '/Date(0+0060)/',
  SubmissionDate: '/Date(0)/',
  SubmittedBy: "Synthetic O'Brien",
  SubmissionCouncil: 2,
  SubmissionCouncilName: 'Synthetic council',
  SubmissionSession: 50,
  Modified: '/Date(1000)/',
};

/** Expected summary is literal and independent of the production normalizer. */
export const businessSummary = {
  businessId: '20991234',
  metadataLanguage: 'de',
  sourceUrl: "https://ws.parlament.ch/odata.svc/Business(ID=20991234,Language='DE')?$format=json",
  shortNumber: '99.1234',
  title: 'Étude [A] *B* \\ C | D',
  typeId: '3',
  typeName: 'Synthetic motion',
  typeAbbreviation: 'Mo.',
  statusId: '9999',
  statusText: '',
  statusDate: '1970-01-01T01:00:00.000+01:00',
  submissionDate: '1970-01-01T00:00:00.000',
  submittedBy: "Synthetic O'Brien",
  submissionCouncilId: '2',
  submissionCouncilName: 'Synthetic council',
  submissionSessionId: '50',
  modifiedAt: '1970-01-01T00:00:01.000',
};

/** Parse continuation enrichment without casting the public structured response. */
export function businessNextCursor(result: { structuredContent?: unknown }): string {
  return z.object({ nextCursor: z.string() }).parse(result.structuredContent).nextCursor;
}

/** Reconstruct every public string, including JSON-fenced original HTML and real link targets. */
export function expectBusinessParity(result: {
  structuredContent?: unknown;
  content: readonly { type: string; text?: string }[];
}) {
  const decoded = decodeParliamentMarkdown(textContent(result));
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      expect(
        decoded.strings.some((line) => line.includes(value)) ||
          decoded.links.includes(value) ||
          decoded.images.includes(value),
        value,
      ).toBe(true);
    } else if (Array.isArray(value)) {
      for (const item of value) visit(item);
    } else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(result.structuredContent);
  return decoded;
}
