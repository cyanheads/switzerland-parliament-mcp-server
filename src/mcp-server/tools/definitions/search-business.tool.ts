/**
 * @fileoverview Discover Swiss parliamentary business with filter-bound keyset pagination.
 * @module mcp-server/tools/definitions/search-business.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createBusinessCursor } from '@/services/parliament/business-cursor.js';
import {
  BusinessRoleSchema,
  BusinessSearchFiltersSchema,
  BusinessSummarySchema,
} from '@/services/parliament/business-model.js';
import { searchBusiness } from '@/services/parliament/business-service.js';
import {
  Int32IdSchema,
  IsoDaySchema,
  inclusiveDaySpan,
  LanguageSchema,
  optionalString,
} from '@/services/parliament/normalization.js';
import { ProvenanceSchema, provenance } from '@/services/parliament/provenance.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import {
  clampNotice,
  fieldTrailer,
  formatParliamentResult,
  joinNotices,
} from '../parliament-format.js';

const EnrichmentSchema = z.object({
  effectiveFilters: BusinessSearchFiltersSchema,
  returnedCount: z.number().int().nonnegative().describe('Distinct businesses actually delivered.'),
  effectiveLimit: z
    .number()
    .int()
    .positive()
    .max(100)
    .describe('Effective business or role-candidate limit after clamping.'),
  totalCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Original-filter business total; omitted for author searches, committee searches, personNumber searches without role, and continuation pages of a tagId search without committeeId or personNumber, whose first page carries it.',
    ),
  nextCursor: z
    .string()
    .optional()
    .describe('Continue after the smallest delivered business ID using identical filters.'),
  hasMore: z.boolean().describe('Whether older matching businesses remain.'),
  notice: z.string().optional().describe('Combined clamp, short-page, or empty-result guidance.'),
});

/** Find business items while keeping committee role counts distinct from business counts. */
export const searchBusinessTool = tool('chparl_search_business', {
  description:
    "Search Swiss parliamentary business by title substring, published submitter label, type, current status, submission session, inclusive submission dates, committee role, a member's own roles (personNumber, optionally one role such as author or cosignatory), or topic tag (tagId; without committeeId or personNumber it needs a submission-date window of at most 366 days). Use chparl_list_reference to resolve codes and chparl_get_business to read a returned businessId. Follow nextCursor with unchanged filters; newest canonical business IDs appear first. Author searches omit the business total. Committee searches, and personNumber searches without role, page role candidates and may return short pages without a distinct business total; a personNumber search with one role reports an exact total. Metadata labels remain in de, fr, or it without translation fallback.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    language: LanguageSchema.describe('Metadata language: de (default), fr, or it.'),
    query: optionalString(z.string()).describe(
      'One title substring, preserving punctuation and diacritics.',
    ),
    author: optionalString(z.string()).describe(
      'Substring of the published submitter label, not every co-signatory.',
    ),
    typeId: optionalString(Int32IdSchema).describe(
      'Business type code from chparl_list_reference topic business_types.',
    ),
    statusId: optionalString(Int32IdSchema).describe(
      'Current status code from chparl_list_reference topic statuses.',
    ),
    sessionId: optionalString(Int32IdSchema).describe(
      'Submission session ID from chparl_list_reference topic sessions.',
    ),
    committeeId: optionalString(Int32IdSchema).describe(
      'Committee number from chparl_list_reference topic committees; matches any published committee role.',
    ),
    personNumber: optionalString(Int32IdSchema).describe(
      'Exact member PersonNumber from chparl_search_members, chparl_get_member, a chparl_get_votes member row, or a chparl_search_transcripts passage speaker; former members included. Matches business where that member holds a published role, co-signatures included. Cannot combine with committeeId.',
    ),
    role: optionalString(BusinessRoleSchema).describe(
      "With personNumber only: one role the member holds. author (Urheber/Auteur/Autore), cosignatory (Mitunterzeichner/Cosignataire/Cofirmatario), spokesperson (Sprecher/Porte-parole/Relatore, e.g. for a parliamentary group's business), opponent (Bekämpfer/Opposant/Opposto), or successor (Übernehmer/Repreneur/Assumente, took over a departed author's business). With one role the result reports an exact totalCount; omit role for every role.",
    ),
    tagId: optionalString(Int32IdSchema).describe(
      "Topic tag ID from chparl_list_reference topic tags, matched as one whole element of the business's pipe-delimited Tags (12 does not match 1216). Without committeeId or personNumber, requires submittedFrom and submittedTo spanning at most 366 inclusive days and reports totalCount on the first page only; if a call runs out of time, retry with a narrower submission window.",
    ),
    submittedFrom: optionalString(IsoDaySchema).describe(
      'Inclusive submission-date lower bound, YYYY-MM-DD.',
    ),
    submittedTo: optionalString(IsoDaySchema).describe(
      'Inclusive submission-date upper bound, YYYY-MM-DD.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(20)
      .describe(
        'Page request, default 20; clamped to 100. Committee pages, and personNumber pages without role, count candidate roles and return each business once, so they may hold fewer businesses.',
      ),
    cursor: optionalString(z.string()).describe(
      'Opaque nextCursor from a previous call with identical filters; omit to start.',
    ),
  }),
  output: z.object({
    businesses: z
      .array(BusinessSummarySchema)
      .describe('Distinct complete business summaries on this page.'),
    provenance: ProvenanceSchema,
  }),
  enrichment: EnrichmentSchema.shape,
  enrichmentTrailer: fieldTrailer(EnrichmentSchema.shape),
  errors: [
    {
      reason: 'incompatible_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'submittedFrom is after submittedTo, personNumber is combined with committeeId, or role is supplied without personNumber.',
      recovery:
        'Use an ascending submission-date range, search by committeeId or personNumber but not both, and supply role only with personNumber; then retry chparl_search_business.',
    },
    {
      reason: 'tag_scope_required',
      code: JsonRpcErrorCode.ValidationError,
      when: 'tagId is used without committeeId or personNumber, and without submittedFrom and submittedTo spanning at most 366 inclusive days.',
      recovery:
        'Supply submittedFrom and submittedTo at most 366 days apart, or scope by committeeId or personNumber, then retry chparl_search_business.',
    },
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Cursor is malformed, unsupported, or belongs to different filters.',
      recovery: 'Restart chparl_search_business without cursor, preserving the intended filters.',
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
    if (input.submittedFrom && input.submittedTo && input.submittedFrom > input.submittedTo)
      throw ctx.fail('incompatible_fields', 'submittedFrom must be on or before submittedTo.', {
        recovery: {
          hint: 'Use an ascending submission-date range, then retry chparl_search_business.',
        },
      });
    if (input.personNumber !== undefined && input.committeeId !== undefined)
      throw ctx.fail('incompatible_fields', 'personNumber cannot be combined with committeeId.', {
        recovery: {
          hint: 'Search by committeeId or by personNumber, not both, then retry chparl_search_business.',
        },
      });
    if (input.role !== undefined && input.personNumber === undefined)
      throw ctx.fail('incompatible_fields', 'role requires personNumber.', {
        recovery: {
          hint: 'Add personNumber from chparl_search_members, or omit role, then retry chparl_search_business.',
        },
      });
    if (
      input.tagId !== undefined &&
      input.committeeId === undefined &&
      input.personNumber === undefined
    ) {
      const days =
        input.submittedFrom !== undefined && input.submittedTo !== undefined
          ? inclusiveDaySpan(input.submittedFrom, input.submittedTo)
          : undefined;
      if (days === undefined || days > 366) throw ctx.fail('tag_scope_required');
    }
    const filters = BusinessSearchFiltersSchema.parse({
      ...input,
      limit: Math.min(input.limit, 100),
    });
    return withWorkflow(ctx, async (workflow) => {
      const result = await searchBusiness(filters, workflow);
      const businesses = result.items;
      const last = businesses.at(-1);
      const hasMore = last !== undefined && result.hasMore;
      const notice = joinNotices(
        clampNotice(input.limit, filters.limit),
        filters.committeeId !== undefined &&
          'Committee pages examine at most the effective limit of role candidates and return each business once. Pages can be short; a distinct business total is unavailable.',
        filters.personNumber !== undefined &&
          filters.role === undefined &&
          "Pages without role examine at most the effective limit of this member's role rows and return each business once. Pages can be short; a distinct business total is unavailable. A single role reports an exact total.",
        businesses.length === 0 &&
          (filters.cursor
            ? 'No business remains after this cursor. Start chparl_search_business without cursor to repeat the search.'
            : 'No parliamentary business matched these filters. Use chparl_list_reference with topic business_types, statuses, sessions, committees, or tags to verify codes, or broaden chparl_search_business.'),
      );
      ctx.enrich({
        effectiveFilters: filters,
        returnedCount: businesses.length,
        effectiveLimit: filters.limit,
        ...(result.totalCount !== undefined && { totalCount: result.totalCount }),
        ...(hasMore && { nextCursor: createBusinessCursor(filters, last.businessId) }),
        hasMore,
        ...(notice !== undefined && { notice }),
      });
      return { businesses, provenance: provenance(workflow.sources) };
    });
  },
  format: formatParliamentResult,
});
