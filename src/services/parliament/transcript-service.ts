/**
 * @fileoverview Scoped Bulletin retrieval through the complete business-to-subject relationship.
 * @module services/parliament/transcript-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  JsonRpcErrorCode,
  McpError,
  serializationError,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { resolveBusiness } from './business-service.js';
import {
  Int64IdSchema,
  type Language,
  odataDay,
  odataInt32,
  odataInt64,
  odataString,
  RawId,
  RawLanguage,
  RawText,
} from './normalization.js';
import {
  buildODataUrl,
  MAX_QUERY_STRING_BYTES,
  ODataClient,
  type ODataPage,
  type ODataQuery,
  queryStringBytes,
} from './odata-client.js';
import {
  normalizeTranscript,
  RawTranscriptSchema,
  type SubjectBusinesses,
  TRANSCRIPT_FIELDS,
  type Transcript,
  type TranscriptFilters,
} from './transcript-model.js';
import { remainingWorkflowMs, type WorkflowContext } from './workflow.js';

const client = new ODataClient();
const RawSubjectSchema = z.object({
  IdSubject: Int64IdSchema,
  BusinessNumber: RawId,
  Language: RawLanguage,
});
const RawSubjectBusinessSchema = RawSubjectSchema.extend({
  BusinessShortNumber: RawText,
  Title: RawText,
  SortOrder: z.number().int().min(-32_768).max(32_767),
});
type RawSubjectBusiness = z.infer<typeof RawSubjectBusinessSchema>;

/** Most subject IDs per SubjectBusiness request. */
const SUBJECT_BATCH_MAX_IDS = 50;
/** SubjectBusiness rows per page request while draining a batch. */
const SUBJECT_PAGE_ROWS = 1000;
/** The subject lookup's own bound, and the minimum it leaves of the workflow deadline. */
const SUBJECT_LOOKUP_BOUND_MS = 10_000;
const SUBJECT_LOOKUP_DEADLINE_MARGIN_MS = 1_000;

/**
 * Debate order: meeting day, sitting, subject, then speaking order within the subject. `SortOrder`
 * numbers each subject's passages from 1 and `MeetingVerbalixOid` identifies the sitting, so every
 * debate reads contiguously and a day's sittings stay apart; `ID` last makes the order total, so
 * offset paging neither repeats nor skips. Subjects within a sitting follow `IdSubject`, not agenda
 * order: the source sorts a `Subjects/SortOrder` join over every matching row.
 */
const PASSAGE_ORDER: ODataQuery['orderBy'] = [
  { field: 'MeetingDate', direction: 'asc' },
  { field: 'MeetingVerbalixOid', direction: 'asc' },
  { field: 'IdSubject', direction: 'asc' },
  { field: 'SortOrder', direction: 'asc' },
  { field: 'ID', direction: 'asc' },
];

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

/** Most debate subjects one business search ORs into its passage query. */
const BUSINESS_SUBJECT_CAP = 20;

/** The source's Meeting.Council code for each council selector. */
const MEETING_COUNCIL = { N: 1, S: 2 } as const satisfies Record<
  NonNullable<TranscriptFilters['council']>,
  number
>;

/** A business's debate subjects, or that more than the cap match. */
type BusinessSubjects =
  | { readonly tooBroad: false; readonly subjects: string[] }
  | { readonly tooBroad: true };

/**
 * Read a business's debate subjects, narrowed by `meeting` predicates on each subject's meeting.
 * One capped page with count; a count-free full page is probed with one more row.
 */
async function readBusinessSubjects(
  businessId: number,
  meeting: readonly string[],
  language: Language,
  workflow: WorkflowContext,
): Promise<BusinessSubjects> {
  const query: ODataQuery = {
    entity: 'SubjectBusiness',
    language,
    select: ['IdSubject', 'BusinessNumber', 'Language'],
    orderBy: [{ field: 'IdSubject', direction: 'asc' }],
    filter: [`BusinessNumber eq ${odataInt32(String(businessId))}`, ...meeting].join(' and '),
  };
  const page = await client.collection(
    query,
    RawSubjectSchema,
    { limit: BUSINESS_SUBJECT_CAP, offset: 0 },
    workflow,
  );
  // A count-free full page has unknown continuation; distinguish exactly 20 from more than 20.
  const sentinel =
    page.totalCount === undefined && page.hasMore
      ? await client.collection(
          query,
          RawSubjectSchema,
          { limit: 1, offset: page.items.length },
          workflow,
        )
      : undefined;
  if (
    (page.totalCount !== undefined && page.totalCount > BUSINESS_SUBJECT_CAP) ||
    (sentinel !== undefined ? sentinel.items.length > 0 : page.hasMore)
  )
    return { tooBroad: true };
  for (const row of page.items) {
    if (row.BusinessNumber !== businessId || row.Language !== language.toUpperCase())
      throw serializationError('Parliament returned a mismatched business debate subject.');
  }
  return { tooBroad: false, subjects: [...new Set(page.items.map((row) => row.IdSubject))] };
}

/**
 * Predicates on a subject's meeting for the search's council, session, and inclusive day filters.
 * A subject's meeting has the same day, session, and council as each of its passages, so narrowing
 * by them drops no matching passage. A speaker cannot narrow: filtering subjects by their passages'
 * speaker needs `any()`, which the source's OData v2 lacks.
 */
function meetingPredicates(filters: TranscriptFilters): string[] {
  const predicates: string[] = [];
  if (filters.council !== undefined)
    predicates.push(`Subjects/Meetings/Council eq ${MEETING_COUNCIL[filters.council]}`);
  if (filters.sessionId !== undefined)
    predicates.push(`Subjects/Meetings/IdSession eq ${odataInt32(filters.sessionId)}`);
  if (filters.dateFrom !== undefined)
    predicates.push(`Subjects/Meetings/Date ge ${odataDay(filters.dateFrom)}`);
  if (filters.dateTo !== undefined)
    predicates.push(`Subjects/Meetings/Date le ${odataDay(filters.dateTo, 'end')}`);
  return predicates;
}

/**
 * Resolve all associated subjects before one OR-filtered passage query; never use
 * Business/Transcripts. A business over the subject cap is re-read once under the search's
 * meeting filters and searched when they leave at most the cap; a business within it sends no
 * extra request.
 */
export async function searchTranscripts(
  filters: TranscriptFilters,
  paging: { limit: number; offset: number },
  workflow: WorkflowContext,
): Promise<TranscriptSearchResult> {
  let subjects: string[] | undefined;
  if (filters.businessId !== undefined) {
    const business = await resolveBusiness(filters.businessId, filters.language, workflow);
    if (!business) return { items: [], hasMore: false, scopeFound: false };
    const all = await readBusinessSubjects(business.ID, [], filters.language, workflow);
    const meeting = meetingPredicates(filters);
    const narrowed = all.tooBroad && meeting.length > 0;
    const read = narrowed
      ? await readBusinessSubjects(business.ID, meeting, filters.language, workflow)
      : all;
    if (read.tooBroad)
      throw validationError(
        narrowed
          ? 'This business has more than 20 associated debate subjects, and more than 20 remain after the council, session, and date filters.'
          : 'This business has more than 20 associated debate subjects.',
        { reason: 'business_scope_too_broad' },
      );
    // A business narrowed to no subject is a no-match, not a business without published subjects.
    if (read.subjects.length === 0)
      return {
        items: [],
        hasMore: false,
        totalCount: 0,
        scopeFound: true,
        ...(!narrowed && { noSubjects: true }),
      };
    subjects = read.subjects;
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
      orderBy: PASSAGE_ORDER,
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

/** Why a best-effort subject lookup returned no businesses. */
export type SubjectLookupUnavailableReason =
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'unexpected_response'
  | 'bound_expired';

/** A resolved lookup lists every requested subject in request order; an unavailable one says why. */
export type SubjectBusinessLookup =
  | { readonly status: 'resolved'; readonly entries: SubjectBusinesses[] }
  | { readonly status: 'unavailable'; readonly reason: SubjectLookupUnavailableReason };

/**
 * Resolve distinct debate subjects to their published businesses, best-effort. The lookup shares the
 * workflow's provenance ledger and cancellation under its own bound: at most 10 s, ending at least
 * 1 s before the workflow deadline. It sends nothing for no subjects, and the client never starts a
 * request on or past the bound. Every upstream failure returns `unavailable`; only caller
 * cancellation, workflow expiry, and a programmer error throw.
 */
export async function resolveSubjectBusinesses(
  subjectIds: readonly string[],
  language: Language,
  workflow: WorkflowContext,
): Promise<SubjectBusinessLookup> {
  if (subjectIds.length === 0) return { status: 'resolved', entries: [] };
  const deadlineAt = Math.min(
    performance.now() + SUBJECT_LOOKUP_BOUND_MS,
    workflow.deadlineAt - SUBJECT_LOOKUP_DEADLINE_MARGIN_MS,
  );
  const bound = new AbortController();
  const timer = setTimeout(
    () => bound.abort(new DOMException('Subject business lookup bound exceeded.', 'TimeoutError')),
    Math.max(0, deadlineAt - performance.now()),
  );
  const lookup: WorkflowContext = {
    ...workflow,
    deadlineAt,
    signal: AbortSignal.any([workflow.signal, bound.signal]),
  };
  try {
    const entries: SubjectBusinesses[] = [];
    for (let start = 0; start < subjectIds.length; ) {
      const batch = nextSubjectBatch(subjectIds.slice(start), language);
      entries.push(...(await readSubjectBusinesses(batch, language, lookup)));
      start += batch.length;
    }
    return { status: 'resolved', entries };
  } catch (error) {
    // Caller cancellation and the workflow deadline outrank any degrade.
    remainingWorkflowMs(workflow);
    const reason = unavailableReason(error, bound.signal);
    if (reason === undefined) throw error;
    workflow.request.log.warning('Subject business lookup unavailable; omitting it.', { reason });
    return { status: 'unavailable', reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The longest prefix of `ids`, at most 50, whose page requests all fit the source's query-string
 * limit, measured at the largest offset a page request can carry. Fifty 19-digit Int64 IDs exceed
 * that limit, so batches are sized by encoded bytes rather than by count.
 */
function nextSubjectBatch(ids: readonly string[], language: Language): readonly string[] {
  let size = Math.min(SUBJECT_BATCH_MAX_IDS, ids.length);
  const queryBytes = (count: number) =>
    queryStringBytes(
      buildODataUrl(
        subjectBusinessQuery(ids.slice(0, count), language),
        SUBJECT_PAGE_ROWS,
        Number.MAX_SAFE_INTEGER,
      ),
    );
  while (size > 1 && queryBytes(size) > MAX_QUERY_STRING_BYTES) size--;
  return ids.slice(0, size);
}

function subjectBusinessQuery(batch: readonly string[], language: Language): ODataQuery {
  return {
    entity: 'SubjectBusiness',
    language,
    select: [
      'IdSubject',
      'BusinessNumber',
      'Language',
      'BusinessShortNumber',
      'Title',
      'SortOrder',
    ],
    orderBy: [
      { field: 'IdSubject', direction: 'asc' },
      { field: 'SortOrder', direction: 'asc' },
      { field: 'BusinessNumber', direction: 'asc' },
    ],
    filter: batch.map((id) => `IdSubject eq ${odataInt64(id)}`).join(' or '),
  };
}

/** Read one batch completely and group its rows by subject in batch order. */
async function readSubjectBusinesses(
  batch: readonly string[],
  language: Language,
  workflow: WorkflowContext,
): Promise<SubjectBusinesses[]> {
  const query = subjectBusinessQuery(batch, language);
  const bySubject = new Map(batch.map((id) => [id, [] as RawSubjectBusiness[]]));
  const seen = new Set<string>();
  for (let offset = 0; ; ) {
    const page = await client.collection(
      query,
      RawSubjectBusinessSchema,
      { limit: SUBJECT_PAGE_ROWS, offset },
      workflow,
    );
    for (const row of page.items) {
      const key = `${row.IdSubject}/${row.BusinessNumber}`;
      const rows = bySubject.get(row.IdSubject);
      if (!rows || row.Language !== language.toUpperCase() || seen.has(key))
        throw serializationError(
          'Parliament returned an unrequested, duplicate, or other-language debate subject business.',
        );
      seen.add(key);
      rows.push(row);
    }
    if (!page.hasMore) break;
    offset += page.items.length;
  }
  return [...bySubject].map(([subjectId, rows]) => ({
    subjectId,
    businesses: rows
      .sort((a, b) => a.SortOrder - b.SortOrder || a.BusinessNumber - b.BusinessNumber)
      .map((row) => ({
        businessId: String(row.BusinessNumber),
        ...(row.BusinessShortNumber != null && { shortNumber: row.BusinessShortNumber }),
        ...(row.Title != null && { title: row.Title }),
      })),
  }));
}

/**
 * Degrade unless the failure is caller cancellation, the workflow deadline, or a programmer error;
 * the caller rules out the first two before asking. The lookup's whole upstream path (the client,
 * its retry, and the row checks above) reports every failure as an McpError, except the bound firing
 * mid-backoff, which surfaces as its raw abort reason and is checked first. Any other non-McpError is
 * a defect in this server and fails the call. The returned reason only words the notice. Every clock
 * inside the lookup derives from its bound, so a Timeout without an HTTP status is the bound expiring.
 */
function unavailableReason(
  error: unknown,
  bound: AbortSignal,
): SubjectLookupUnavailableReason | undefined {
  if (bound.aborted) return 'bound_expired';
  if (!(error instanceof McpError)) return undefined;
  const status = error.data?.status;
  if (status === 429) return 'rate_limited';
  if (error.code === JsonRpcErrorCode.SerializationError) return 'unexpected_response';
  if (error.code === JsonRpcErrorCode.Timeout && typeof status !== 'number') return 'bound_expired';
  return 'upstream_unavailable';
}
