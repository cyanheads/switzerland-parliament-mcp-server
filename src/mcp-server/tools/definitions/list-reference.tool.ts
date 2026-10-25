/**
 * @fileoverview Resolve Swiss Parliament identifiers, source coverage, and live reference dictionaries.
 * @module mcp-server/tools/definitions/list-reference.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  IsoDaySchema,
  LanguageSchema,
  optionalString,
} from '@/services/parliament/normalization.js';
import { getParliamentService } from '@/services/parliament/parliament-service.js';
import { ProvenanceSchema, provenance } from '@/services/parliament/provenance.js';
import {
  ReferenceFiltersSchema,
  ReferenceItemSchema,
  ReferenceTopicSchema,
} from '@/services/parliament/reference-model.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import { fitCollectionPage, formatParliamentResult, renderField } from '../parliament-format.js';

/** Resolve reference keys and documented coverage without accepting caller-authored OData. */
export const listReferenceTool = tool('chparl_list_reference', {
  description:
    'List Swiss Parliament reference entries and source coverage. Choose identifiers, coverage, or languages for server explanations; statuses for the official legacy/current status snapshot; or business_types, councils, cantons, parties, groups, committees, or sessions for live dictionaries. Date filters apply only to sessions. Follow nextOffset with the same topic, language, and dates; labels remain in the requested metadata language and missing labels stay unknown.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    topic: ReferenceTopicSchema.describe('Reference dictionary or explanatory topic to list.'),
    language: LanguageSchema.describe('Metadata label language: de (default), fr, or it.'),
    dateFrom: optionalString(IsoDaySchema).describe(
      'Sessions only: inclusive StartDate lower bound, YYYY-MM-DD.',
    ),
    dateTo: optionalString(IsoDaySchema).describe(
      'Sessions only: inclusive EndDate upper bound, YYYY-MM-DD.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(50)
      .describe(
        'Requested page size, default 50; values above 100 are clamped with a notice. Whole-item byte fitting may return fewer entries.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .default(0)
      .describe('Starting row offset, default zero. Use the returned nextOffset to continue.'),
  }),
  output: z.object({
    topic: ReferenceTopicSchema.describe('Reference topic returned.'),
    items: z
      .array(ReferenceItemSchema)
      .describe('Complete reference entries delivered on this page.'),
    provenance: ProvenanceSchema,
  }),
  enrichment: {
    effectiveFilters: ReferenceFiltersSchema,
    returnedCount: z
      .number()
      .int()
      .nonnegative()
      .describe('Number of complete entries actually delivered.'),
    effectiveLimit: z
      .number()
      .int()
      .positive()
      .max(100)
      .describe('Effective row limit after clamping; response-size fitting may deliver fewer.'),
    totalCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Whole-query reference count when the source supplies one.'),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Original offset plus delivered entries; absent when exhausted.'),
    hasMore: z.boolean().describe('Whether entries remain beyond this delivered page.'),
    notice: z
      .string()
      .optional()
      .describe('Combined limit, whole-item byte-budget, empty-result, or past-end guidance.'),
  },
  enrichmentTrailer: {
    effectiveFilters: { render: (value) => renderField('effectiveFilters', value) },
    returnedCount: { render: (value) => renderField('returnedCount', value) },
    effectiveLimit: { render: (value) => renderField('effectiveLimit', value) },
    totalCount: { render: (value) => renderField('totalCount', value) },
    nextOffset: { render: (value) => renderField('nextOffset', value) },
    hasMore: { render: (value) => renderField('hasMore', value) },
    notice: { render: (value) => renderField('notice', value) },
  },
  errors: [
    {
      reason: 'incompatible_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Session dates were supplied for another topic, or dateFrom is after dateTo.',
      recovery: 'Use chparl_list_reference with topic sessions before supplying date filters.',
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
    if (
      input.topic !== 'sessions' &&
      (input.dateFrom !== undefined || input.dateTo !== undefined)
    ) {
      throw ctx.fail('incompatible_fields');
    }
    if (input.dateFrom && input.dateTo && input.dateFrom > input.dateTo) {
      throw ctx.fail('incompatible_fields', 'dateFrom must be on or before dateTo.', {
        recovery: {
          hint: 'Use an ascending session date range with dateFrom on or before dateTo.',
        },
      });
    }
    const filters = ReferenceFiltersSchema.parse({
      topic: input.topic,
      language: input.language,
      ...(input.dateFrom !== undefined && { dateFrom: input.dateFrom }),
      ...(input.dateTo !== undefined && { dateTo: input.dateTo }),
      limit: Math.min(input.limit, 100),
      offset: input.offset,
    });
    return withWorkflow(ctx, async (workflow) => {
      const result = await getParliamentService().listReference(filters, workflow);
      const prepared = fitCollectionPage(result.items, (items, cut, oversized) => {
        const notices: string[] = [];
        if (input.limit > 100) notices.push(`Requested limit ${input.limit} was clamped to 100.`);
        if (cut)
          notices.push(
            'Response byte fitting returned fewer whole entries. Continue with nextOffset; no entry fields were shortened.',
          );
        if (items.length === 0) {
          if (
            result.totalCount !== undefined &&
            result.totalCount > 0 &&
            filters.offset >= result.totalCount
          )
            notices.push('The requested offset is past the last matching reference entry.');
          else notices.push('No reference entries matched the query.');
          notices.push(
            'No reference entries occur on this page. Call chparl_list_reference for this topic with offset zero, or revise the session dates.',
          );
        }
        if (oversized)
          notices.push(
            `One indivisible reference entry or its provenance exceeds 24000 bytes. Retrieve this exact page with chparl_list_reference topic=${filters.topic}, language=${filters.language}, offset=${filters.offset}, limit=1${filters.dateFrom ? `, dateFrom=${filters.dateFrom}` : ''}${filters.dateTo ? `, dateTo=${filters.dateTo}` : ''}. The entry is returned whole.`,
          );
        const hasMore = cut || result.hasMore;
        return {
          output: { topic: input.topic, items, provenance: provenance(workflow.sources) },
          enrichment: {
            effectiveFilters: filters,
            returnedCount: items.length,
            effectiveLimit: filters.limit,
            ...(result.totalCount !== undefined && { totalCount: result.totalCount }),
            ...(hasMore && { nextOffset: filters.offset + items.length }),
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
