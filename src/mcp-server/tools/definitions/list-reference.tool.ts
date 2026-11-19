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
  ReferenceQueryTopicSchema,
  ReferenceTopicSchema,
} from '@/services/parliament/reference-model.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import {
  clampNotice,
  fieldTrailer,
  formatParliamentResult,
  isPastEnd,
  joinNotices,
} from '../parliament-format.js';

const EnrichmentSchema = z.object({
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
    .describe('Effective row limit after clamping.'),
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
    .describe('Combined limit-clamp, empty-result, or past-end guidance.'),
});

/** Resolve reference keys and documented coverage without accepting caller-authored OData. */
export const listReferenceTool = tool('chparl_list_reference', {
  description:
    'List Swiss Parliament reference entries and source coverage. Choose identifiers, coverage, or languages for server explanations; statuses for the official legacy/current status snapshot; or business_types, tags, councils, cantons, parties, groups, committees, or sessions for live dictionaries. tags lists the business topic tags; pass a tag id as chparl_search_business tagId. Date filters apply only to sessions. query applies only to committees, parties, and groups: the source matches it as a case- and accent-insensitive substring of each entry label or abbreviation in the selected metadata language, and abbreviations differ by language (WAK-N is CER-N in fr). Follow nextOffset with the same topic, language, query, and dates; labels remain in the requested metadata language and missing labels stay unknown.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    topic: ReferenceTopicSchema.describe('Reference dictionary or explanatory topic to list.'),
    language: LanguageSchema.describe('Metadata label language: de (default), fr, or it.'),
    query: optionalString(z.string()).describe(
      'Committees, parties, and groups only: substring of the entry label or abbreviation in the selected metadata language, case- and accent-insensitive, trimmed. Totals and nextOffset describe the matching entries.',
    ),
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
      .describe('Requested page size, default 50; values above 100 are clamped with a notice.'),
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
  enrichment: EnrichmentSchema.shape,
  enrichmentTrailer: fieldTrailer(EnrichmentSchema.shape),
  errors: [
    {
      reason: 'incompatible_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Session dates were supplied for another topic, query was supplied for a topic other than committees, parties, or groups, or dateFrom is after dateTo.',
      recovery:
        'Supply dateFrom and dateTo only with topic sessions, and query only with topic committees, parties, or groups, then retry chparl_list_reference.',
    },
    {
      reason: 'request_too_long',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'query makes the URL-encoded Parliament request longer than its 2048-byte query-string limit.',
      recovery:
        'Shorten query and retry this tool; the request carries query twice, once each for the label and the abbreviation.',
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
    if (input.query !== undefined && !ReferenceQueryTopicSchema.safeParse(input.topic).success) {
      throw ctx.fail(
        'incompatible_fields',
        `query applies only to topics committees, parties, and groups, not ${input.topic}.`,
        {
          recovery: {
            hint: 'Omit query, or call chparl_list_reference with topic committees, parties, or groups.',
          },
        },
      );
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
      ...(input.query !== undefined && { query: input.query }),
      ...(input.dateFrom !== undefined && { dateFrom: input.dateFrom }),
      ...(input.dateTo !== undefined && { dateTo: input.dateTo }),
      limit: Math.min(input.limit, 100),
      offset: input.offset,
    });
    return withWorkflow(ctx, async (workflow) => {
      const { items, totalCount, hasMore, nextOffset } = await getParliamentService().listReference(
        filters,
        workflow,
      );
      const notice = joinNotices(
        clampNotice(input.limit, filters.limit),
        items.length === 0 &&
          `${isPastEnd(totalCount, filters.offset) ? 'The requested offset is past the last matching reference entry.' : 'No reference entries matched the query.'} No reference entries occur on this page. ${filters.query === undefined ? `Call chparl_list_reference for this topic with offset zero${filters.topic === 'sessions' ? ', or revise the session dates' : ''}.` : `Call chparl_list_reference for this topic with offset zero, or revise query: it matches entry labels and abbreviations in metadata language ${filters.language}, and abbreviations differ by language. Omit query to page the whole topic.`}`,
      );
      ctx.enrich({
        effectiveFilters: filters,
        returnedCount: items.length,
        effectiveLimit: filters.limit,
        ...(totalCount !== undefined && { totalCount }),
        ...(nextOffset !== undefined && { nextOffset }),
        hasMore,
        ...(notice !== undefined && { notice }),
      });
      return { topic: input.topic, items, provenance: provenance(workflow.sources) };
    });
  },
  format: formatParliamentResult,
});
