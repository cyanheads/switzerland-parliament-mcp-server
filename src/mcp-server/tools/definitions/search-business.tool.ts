/**
 * @fileoverview Discover Swiss parliamentary business with filter-bound keyset pagination.
 * @module mcp-server/tools/definitions/search-business.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, validationError } from '@cyanheads/mcp-ts-core/errors';
import { createBusinessCursor } from '@/services/parliament/business-cursor.js';
import {
  BusinessSearchFiltersSchema,
  BusinessSummarySchema,
} from '@/services/parliament/business-model.js';
import { searchBusiness } from '@/services/parliament/business-service.js';
import {
  Int32IdSchema,
  IsoDaySchema,
  LanguageSchema,
  optionalString,
} from '@/services/parliament/normalization.js';
import { ProvenanceSchema, provenance } from '@/services/parliament/provenance.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import { fitCollectionPage, formatParliamentResult, renderField } from '../parliament-format.js';

/** Find business items while keeping committee role counts distinct from business counts. */
export const searchBusinessTool = tool('chparl_search_business', {
  description:
    'Search Swiss parliamentary business by title substring, published submitter label, type, current status, submission session, inclusive submission dates, or committee role. Use chparl_list_reference to resolve codes and chparl_get_business to read a returned businessId. Follow nextCursor with unchanged filters; newest canonical business IDs appear first. Committee searches page role candidates and may return short pages without a distinct business total. Metadata labels remain in de, fr, or it without translation fallback.',
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
      'Committee number matched through any published BusinessRole.',
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
        'Page request, default 20; clamped to 100. Committee pages count candidate roles, and byte fitting may return fewer businesses.',
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
  enrichment: {
    effectiveFilters: BusinessSearchFiltersSchema,
    returnedCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Distinct businesses actually delivered.'),
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
      .describe('Original-filter business total, available only without a committee filter.'),
    nextCursor: z
      .string()
      .optional()
      .describe('Continue after the smallest delivered business ID using identical filters.'),
    hasMore: z.boolean().describe('Whether older matching businesses remain.'),
    notice: z
      .string()
      .optional()
      .describe('Combined clamp, short-page, size-fitting, or empty-result guidance.'),
  },
  enrichmentTrailer: {
    effectiveFilters: { render: (value) => renderField('effectiveFilters', value) },
    returnedCount: { render: (value) => renderField('returnedCount', value) },
    effectiveLimit: { render: (value) => renderField('effectiveLimit', value) },
    totalCount: { render: (value) => renderField('totalCount', value) },
    nextCursor: { render: (value) => renderField('nextCursor', value) },
    hasMore: { render: (value) => renderField('hasMore', value) },
    notice: { render: (value) => renderField('notice', value) },
  },
  errors: [
    {
      reason: 'invalid_cursor',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'Cursor is malformed, unsupported, or belongs to different filters.',
      recovery: 'Restart chparl_search_business without cursor, preserving the intended filters.',
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
      throw validationError('submittedFrom must be on or before submittedTo.', {
        recovery: {
          hint: 'Use an ascending submission-date range, then retry chparl_search_business.',
        },
      });
    const filters = BusinessSearchFiltersSchema.parse({
      ...input,
      limit: Math.min(input.limit, 100),
    });
    return withWorkflow(ctx, async (workflow) => {
      const result = await searchBusiness(filters, workflow);
      const prepared = fitCollectionPage(result.items, (businesses, cut, oversized) => {
        const notices: string[] = [];
        if (input.limit > 100) notices.push(`Requested limit ${input.limit} was clamped to 100.`);
        if (filters.committeeId)
          notices.push(
            'Committee pages examine at most the effective limit of role candidates and return each business once. Pages can be short; a distinct business total is unavailable.',
          );
        if (cut)
          notices.push(
            'Response byte fitting returned fewer whole businesses. Continue with nextCursor; no business fields were shortened.',
          );
        if (businesses.length === 0)
          notices.push(
            filters.cursor
              ? 'No business remains after this cursor. Start chparl_search_business without cursor to repeat the search.'
              : 'No parliamentary business matched these filters. Use chparl_list_reference with topic business_types, statuses, sessions, or committees to verify codes, or broaden chparl_search_business.',
          );
        if (oversized)
          notices.push(
            `One indivisible business or its provenance exceeds 24000 bytes and is returned whole. Retrieve this page with chparl_search_business arguments ${JSON.stringify({ ...filters, limit: 1 })}.`,
          );
        const hasMore = businesses.length > 0 && (cut || result.hasMore);
        const last = businesses.at(-1);
        return {
          output: { businesses, provenance: provenance(workflow.sources) },
          enrichment: {
            effectiveFilters: filters,
            returnedCount: businesses.length,
            effectiveLimit: filters.limit,
            ...(result.totalCount !== undefined && { totalCount: result.totalCount }),
            ...(hasMore && last && { nextCursor: createBusinessCursor(filters, last.businessId) }),
            hasMore,
            ...(notices.length > 0 && { notice: notices.join(' ') }),
          },
        };
      });
      ctx.enrich(prepared.enrichment);
      return prepared.output;
    });
  },
  format: formatParliamentResult,
});
