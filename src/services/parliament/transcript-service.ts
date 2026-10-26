/**
 * @fileoverview Scoped Bulletin retrieval through the complete business-to-subject relationship.
 * @module services/parliament/transcript-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serializationError, validationError } from '@cyanheads/mcp-ts-core/errors';
import { resolveBusiness } from './business-service.js';
import {
  Int64IdSchema,
  type Language,
  odataInt32,
  odataInt64,
  odataString,
  RawId,
  RawLanguage,
} from './normalization.js';
import { ODataClient, type ODataPage, type ODataQuery } from './odata-client.js';
import {
  normalizeTranscript,
  RawTranscriptSchema,
  TRANSCRIPT_FIELDS,
  type Transcript,
  type TranscriptFilters,
} from './transcript-model.js';
import type { WorkflowContext } from './workflow.js';

const client = new ODataClient();
const RawSubjectSchema = z.object({
  IdSubject: Int64IdSchema,
  BusinessNumber: RawId,
  Language: RawLanguage,
});

/** Exact lookup remains a single-item resolution and preserves missing-key semantics. */
export async function getTranscript(
  id: string,
  language: Language,
  includeText: boolean,
  workflow: WorkflowContext,
): Promise<Transcript | undefined> {
  const raw = await client.entity(
    { entity: 'Transcript', id, language, select: TRANSCRIPT_FIELDS },
    RawTranscriptSchema,
    workflow,
  );
  if (raw && raw.ID !== id)
    throw serializationError(
      'Parliament returned a different passage than the requested composite key.',
    );
  return raw ? normalizeTranscript(raw, language, includeText) : undefined;
}

/** Search result distinguishes an absent business from a business with no published debate subjects. */
export interface TranscriptSearchResult extends ODataPage<Transcript> {
  readonly noSubjects?: boolean;
  readonly scopeFound?: boolean;
}

/** Resolve all associated subjects before one OR-filtered passage query; never use Business/Transcripts. */
export async function searchTranscripts(
  filters: TranscriptFilters,
  paging: { limit: number; offset: number },
  workflow: WorkflowContext,
): Promise<TranscriptSearchResult> {
  let subjects: string[] | undefined;
  if (filters.businessId !== undefined) {
    const business = await resolveBusiness(filters.businessId, filters.language, workflow);
    if (!business) return { items: [], hasMore: false, scopeFound: false };
    const subjectQuery: ODataQuery = {
      entity: 'SubjectBusiness',
      language: filters.language,
      select: ['IdSubject', 'BusinessNumber', 'Language'],
      orderBy: [{ field: 'IdSubject', direction: 'asc' }],
      filter: `BusinessNumber eq ${odataInt32(String(business.ID))}`,
    };
    const subjectPage = await client.collection(
      subjectQuery,
      RawSubjectSchema,
      { limit: 20, offset: 0 },
      workflow,
    );
    // A count-free full page has unknown continuation; distinguish exactly 20 from more than 20.
    const sentinel =
      subjectPage.totalCount === undefined && subjectPage.hasMore
        ? await client.collection(
            subjectQuery,
            RawSubjectSchema,
            { limit: 1, offset: subjectPage.items.length },
            workflow,
          )
        : undefined;
    if (
      (subjectPage.totalCount !== undefined && subjectPage.totalCount > 20) ||
      (sentinel !== undefined ? sentinel.items.length > 0 : subjectPage.hasMore)
    )
      throw validationError('This business has more than 20 associated debate subjects.', {
        reason: 'business_scope_too_broad',
      });
    for (const row of subjectPage.items) {
      if (row.BusinessNumber !== business.ID || row.Language !== filters.language.toUpperCase())
        throw serializationError('Parliament returned a mismatched business debate subject.');
    }
    subjects = [...new Set(subjectPage.items.map((row) => row.IdSubject))];
    if (subjects.length === 0)
      return { items: [], hasMore: false, totalCount: 0, scopeFound: true, noSubjects: true };
  } else if (filters.subjectId !== undefined) subjects = [filters.subjectId];

  const predicates: string[] = [];
  if (subjects !== undefined)
    predicates.push(`(${subjects.map((id) => `IdSubject eq ${odataInt64(id)}`).join(' or ')})`);
  if (filters.personNumber !== undefined)
    predicates.push(`PersonNumber eq ${odataInt32(filters.personNumber)}`);
  if (filters.sessionId !== undefined)
    predicates.push(`IdSession eq ${odataString(filters.sessionId)}`);
  if (filters.council !== undefined)
    predicates.push(`MeetingCouncilAbbreviation eq ${odataString(filters.council)}`);
  if (filters.dateFrom !== undefined)
    predicates.push(`MeetingDate ge ${odataString(filters.dateFrom.replaceAll('-', ''))}`);
  if (filters.dateTo !== undefined)
    predicates.push(`MeetingDate le ${odataString(filters.dateTo.replaceAll('-', ''))}`);
  if (filters.query !== undefined)
    predicates.push(`substringof(${odataString(filters.query)},Text)`);
  const page = await client.collection(
    {
      entity: 'Transcript',
      language: filters.language,
      select: TRANSCRIPT_FIELDS,
      orderBy: [{ field: 'ID', direction: 'asc' }],
      filter: predicates.join(' and '),
    },
    RawTranscriptSchema,
    paging,
    workflow,
  );
  return {
    ...page,
    items: page.items.map((row) => normalizeTranscript(row, filters.language, filters.includeText)),
    ...(filters.businessId !== undefined && { scopeFound: true }),
  };
}
