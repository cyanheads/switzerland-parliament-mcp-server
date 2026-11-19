/**
 * @fileoverview Find scoped Bulletin passages or resolve one complete original passage.
 * @module mcp-server/tools/definitions/search-transcripts.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { BusinessIdentifierSchema } from '@/services/parliament/business-model.js';
import { MemberCouncilInputSchema } from '@/services/parliament/member-model.js';
import {
  Int32IdSchema,
  Int64IdSchema,
  IsoDaySchema,
  inclusiveDaySpan,
  LanguageSchema,
  optionalString,
} from '@/services/parliament/normalization.js';
import { ProvenanceSchema, provenance } from '@/services/parliament/provenance.js';
import {
  SubjectBusinessesSchema,
  type Transcript,
  TranscriptFiltersSchema,
  TranscriptSchema,
} from '@/services/parliament/transcript-model.js';
import {
  getTranscript,
  resolveSubjectBusinesses,
  type SubjectBusinessLookup,
  type SubjectLookupUnavailableReason,
  searchTranscripts,
} from '@/services/parliament/transcript-service.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import {
  clampNotice,
  completeResultBytes,
  fieldTrailer,
  formatParliamentResult,
  isPastEnd,
  joinNotices,
  WHOLE_RESULT_NOTICE_BYTES,
} from '../parliament-format.js';

const OutputSchema = z.object({
  found: z
    .boolean()
    .optional()
    .describe('Exact-ID mode only: whether the selected passage exists.'),
  scopeFound: z
    .boolean()
    .optional()
    .describe(
      'Business searches only: whether the business exists, independently of published subjects or passages.',
    ),
  guidance: z
    .string()
    .optional()
    .describe('How to discover a valid exact passage or missing business identifier.'),
  transcripts: z
    .array(TranscriptSchema)
    .describe(
      'Whole matching passages or zero-or-one exact-ID result, without shortening original fields.',
    ),
  subjectBusinesses: z
    .array(SubjectBusinessesSchema)
    .optional()
    .describe(
      'One entry per distinct subjectId among the delivered passages, in first-appearance order; join passages on subjectId. Absent when no delivered passage has a subject, or when the lookup was unavailable, which a notice reports.',
    ),
  provenance: ProvenanceSchema,
});
type Output = z.infer<typeof OutputSchema>;

/** Distinct debate subjects in first-appearance order. */
function subjectsOf(transcripts: readonly Transcript[]): string[] {
  return [
    ...new Set(
      transcripts.flatMap((passage) =>
        passage.subjectId === undefined ? [] : [passage.subjectId],
      ),
    ),
  ];
}

/** The lookup covers every delivered subject; absent when unavailable or without a subject. */
function subjectBusinessesOf(lookup: SubjectBusinessLookup): Output['subjectBusinesses'] {
  return lookup.status === 'resolved' && lookup.entries.length > 0 ? lookup.entries : undefined;
}

const UNAVAILABLE_LOOKUP = {
  rate_limited: 'was rate-limited by Parliament',
  upstream_unavailable: 'failed because Parliament was unavailable or refused the request',
  unexpected_response: 'received an unexpected response from Parliament',
  bound_expired: 'did not finish within its 10-second bound',
} satisfies Record<SubjectLookupUnavailableReason, string>;

/** Disclose an omitted subjectBusinesses field; absence alone never reads as "no businesses". */
function lookupNotice(lookup: SubjectBusinessLookup): string | undefined {
  return lookup.status === 'unavailable'
    ? `The debate subject lookup ${UNAVAILABLE_LOOKUP[lookup.reason]}, so subjectBusinesses is omitted; the passages are complete. Retry chparl_search_transcripts with the same arguments after a short wait to resolve their businesses.`
    : undefined;
}

const EnrichmentSchema = z.object({
  effectiveFilters: TranscriptFiltersSchema,
  returnedCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Passages actually delivered on a search page; absent in exact-ID mode.'),
  effectiveLimit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Search page size after metadata or full-text clamping.'),
  totalCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Exact whole-scope passage count when supplied; absent when a business does not exist.',
    ),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Original offset plus actually delivered passages, when more remain.'),
  hasMore: z
    .boolean()
    .optional()
    .describe('Whether passages remain after the delivered search page; absent in exact-ID mode.'),
  notice: z
    .string()
    .optional()
    .describe(
      'Combined clamp, empty-result, past-end, unavailable-lookup, or oversized exact-passage guidance.',
    ),
});

/** Read original debate text in both councils through exact passage or bounded search scopes. */
export const searchTranscriptsTool = tool('chparl_search_transcripts', {
  description:
    'Find Amtliches Bulletin passages by business, debate subject, speaker, session, council, or inclusive meeting dates. Supply at least a business, subject, speaker, session, or date bound. A text substring query additionally requires sessionId or a closed date range of at most 31 calendar days. Searches return metadata by default; includeText returns whole original passages, and an exact transcriptId defaults to full text. Metadata language never translates the speaker text; missing LanguageOfText remains unknown. Business searches cover every associated subject up to 20; a business with more is searched when council, sessionId, or date bounds leave at most 20 of its subjects, and otherwise requires selecting subjectId through chparl_get_business section subjects. subjectBusinesses lists the businesses published for each delivered subjectId; pass a subjectBusinesses[].businesses[].businessId to chparl_get_business or chparl_get_votes. Searches run in debate order, oldest first: meeting day, sitting, debate subject, then speaking order (sortOrder) within the subject. Follow nextOffset with unchanged filters.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    language: LanguageSchema.describe(
      'Metadata language: de (default), fr, or it; original passage text stays in its published language.',
    ),
    businessId: optionalString(BusinessIdentifierSchema).describe(
      'Canonical eight-digit businessId from chparl_search_business or published short number; incompatible with subjectId and transcriptId.',
    ),
    subjectId: optionalString(Int64IdSchema).describe(
      'Positive Int64 debate IdSubject string; incompatible with businessId and transcriptId.',
    ),
    transcriptId: optionalString(Int64IdSchema).describe(
      'Exact positive Int64 transcriptId from a previous chparl_search_transcripts result; only language and includeText may accompany it.',
    ),
    personNumber: optionalString(Int32IdSchema).describe(
      'Exact speaker PersonNumber from chparl_search_members.',
    ),
    sessionId: optionalString(Int32IdSchema).describe(
      'Exact positive decimal session identifier from chparl_list_reference topic sessions.',
    ),
    council: MemberCouncilInputSchema.describe(
      'N or S; exact German, French, and Italian council names are also accepted.',
    ),
    dateFrom: optionalString(IsoDaySchema).describe(
      'Inclusive meeting-day lower bound, YYYY-MM-DD.',
    ),
    dateTo: optionalString(IsoDaySchema).describe('Inclusive meeting-day upper bound, YYYY-MM-DD.'),
    query: optionalString(z.string()).describe(
      'One original-text substring; requires sessionId or both dates spanning at most 31 inclusive calendar days.',
    ),
    includeText: z
      .boolean()
      .optional()
      .describe(
        'Return whole original text and references; defaults true for transcriptId and false for searches. Explicit false always wins.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe(
        'Search page request: metadata default 20/max 100, full text default 3/max 10; clamped with notice. Incompatible with transcriptId.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe(
        'Search starting row offset, default zero; use returned nextOffset. Incompatible with transcriptId.',
      ),
  }),
  output: OutputSchema,
  enrichment: EnrichmentSchema.shape,
  enrichmentTrailer: fieldTrailer(EnrichmentSchema.shape),
  errors: [
    {
      reason: 'search_scope_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'No business, subject, speaker, session, date bound, or exact passage identifies the search.',
      recovery:
        'Use chparl_list_reference with topic sessions, then supply sessionId to chparl_search_transcripts.',
    },
    {
      reason: 'text_scope_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'A text query lacks a session or a valid closed date range of at most 31 days.',
      recovery:
        'Use chparl_list_reference with topic sessions, then narrow chparl_search_transcripts by sessionId or a closed date range.',
    },
    {
      reason: 'business_scope_too_broad',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'A business has more than 20 associated debate subjects, and council, sessionId, dateFrom, and dateTo, when supplied, leave more than 20 of them.',
      recovery:
        'Narrow chparl_search_transcripts by council, sessionId, or a narrower date range; otherwise page chparl_get_business with section subjects, then call chparl_search_transcripts with one subjectId.',
    },
    {
      reason: 'incompatible_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Business and subject are combined, an exact passage ID is combined with search filters or paging, or dateFrom is after dateTo.',
      recovery:
        'For an exact passage, keep only transcriptId, language, and includeText; for searches, omit transcriptId, choose at most one of businessId and subjectId, and use ascending date bounds.',
    },
    {
      reason: 'ambiguous_business_number',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'A short business number resolves to multiple canonical businesses.',
      recovery: 'Use chparl_search_business to identify the intended canonical businessId.',
    },
    {
      reason: 'request_too_long',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'The text filters make the URL-encoded Parliament request longer than its 2048-byte query-string limit.',
      recovery: 'Shorten the text filters and retry this tool.',
    },
    {
      reason: 'upstream_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      retryable: true,
      thrownBy: 'service',
      when: 'Parliament returned HTTP 429.',
      recovery:
        'Wait for the supplied retry delay, then retry this tool; use chparl_list_reference with topic coverage to review source limits.',
    },
  ],
  handler(input, ctx) {
    if (input.businessId !== undefined && input.subjectId !== undefined)
      throw ctx.fail('incompatible_fields');
    if (
      input.transcriptId !== undefined &&
      [
        input.businessId,
        input.subjectId,
        input.personNumber,
        input.sessionId,
        input.council,
        input.dateFrom,
        input.dateTo,
        input.query,
        input.limit,
        input.offset,
      ].some((value) => value !== undefined)
    )
      throw ctx.fail('incompatible_fields');
    if (input.dateFrom !== undefined && input.dateTo !== undefined && input.dateFrom > input.dateTo)
      throw ctx.fail('incompatible_fields', 'dateFrom must be on or before dateTo.', {
        recovery: {
          hint: 'Use an ascending calendar-day range, then retry chparl_search_transcripts.',
        },
      });
    if (input.query !== undefined && input.sessionId === undefined) {
      const days =
        input.dateFrom !== undefined && input.dateTo !== undefined
          ? inclusiveDaySpan(input.dateFrom, input.dateTo)
          : undefined;
      if (days === undefined || days > 31) throw ctx.fail('text_scope_required');
    }
    if (
      [
        input.businessId,
        input.subjectId,
        input.personNumber,
        input.sessionId,
        input.dateFrom,
        input.dateTo,
        input.transcriptId,
      ].every((value) => value === undefined)
    )
      throw ctx.fail('search_scope_required');

    const exact = input.transcriptId !== undefined;
    const includeText = input.includeText ?? exact;
    const requestedLimit = input.limit ?? (includeText ? 3 : 20);
    const paging = {
      limit: Math.min(requestedLimit, includeText ? 10 : 100),
      offset: input.offset ?? 0,
    };
    const filters = TranscriptFiltersSchema.parse({
      ...input,
      includeText,
      ...(exact ? {} : paging),
    });

    return withWorkflow(ctx, async (workflow): Promise<Output> => {
      if (input.transcriptId !== undefined) {
        const passage = await getTranscript(
          input.transcriptId,
          input.language,
          includeText,
          workflow,
        );
        const transcripts = passage ? [passage] : [];
        const lookup = await resolveSubjectBusinesses(
          subjectsOf(transcripts),
          input.language,
          workflow,
        );
        const subjectBusinesses = subjectBusinessesOf(lookup);
        const output: Output = {
          found: passage !== undefined,
          transcripts,
          ...(subjectBusinesses && { subjectBusinesses }),
          ...(!passage && {
            guidance:
              'No Bulletin passage matched this transcriptId. Use chparl_search_transcripts with a subjectId, businessId, or sessionId to discover a valid passage.',
          }),
          provenance: provenance(workflow.sources),
        };
        const unavailable = lookupNotice(lookup);
        const oversized =
          completeResultBytes(output, {
            effectiveFilters: filters,
            ...(unavailable !== undefined && { notice: unavailable }),
          }) >= WHOLE_RESULT_NOTICE_BYTES;
        const notice = joinNotices(
          oversized &&
            `This indivisible passage, its subject businesses, or its provenance exceeds 24000 bytes and is returned whole. Retrieve it with chparl_search_transcripts arguments ${JSON.stringify({ transcriptId: input.transcriptId, language: input.language, includeText })}.`,
          unavailable,
        );
        ctx.enrich({ effectiveFilters: filters, ...(notice !== undefined && { notice }) });
        return output;
      }

      const { items: transcripts, ...result } = await searchTranscripts(filters, paging, workflow);
      const lookup = await resolveSubjectBusinesses(
        subjectsOf(transcripts),
        filters.language,
        workflow,
      );
      const subjectBusinesses = subjectBusinessesOf(lookup);
      const hasMore = transcripts.length > 0 && result.hasMore;
      const notice = joinNotices(
        clampNotice(requestedLimit, paging.limit),
        transcripts.length === 0 &&
          result.scopeFound !== false &&
          (result.noSubjects
            ? 'This business has no published debate subjects. Use another chparl_get_business section or chparl_search_transcripts with a session or speaker filter.'
            : isPastEnd(result.totalCount, paging.offset)
              ? 'The requested offset is past the last matching passage. Retry chparl_search_transcripts with the same filters and offset:0.'
              : 'No Bulletin passages matched these filters. Use chparl_get_business with section subjects, or chparl_list_reference with topic sessions, then retry chparl_search_transcripts.'),
        lookupNotice(lookup),
      );
      ctx.enrich({
        effectiveFilters: filters,
        returnedCount: transcripts.length,
        effectiveLimit: paging.limit,
        ...(result.totalCount !== undefined && { totalCount: result.totalCount }),
        hasMore,
        ...(hasMore && { nextOffset: paging.offset + transcripts.length }),
        ...(notice !== undefined && { notice }),
      });
      return {
        transcripts,
        ...(subjectBusinesses && { subjectBusinesses }),
        ...(result.scopeFound !== undefined && { scopeFound: result.scopeFound }),
        ...(result.scopeFound === false && {
          guidance:
            'No business matched this identifier. Use chparl_search_business to discover a valid businessId.',
        }),
        provenance: provenance(workflow.sources),
      };
    });
  },
  format: formatParliamentResult,
});
