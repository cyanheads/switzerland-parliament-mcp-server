/**
 * @fileoverview Read one Swiss parliamentary business, original text, or procedural collection.
 * @module mcp-server/tools/definitions/get-business.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  BusinessIdentifierSchema,
  BusinessOverviewSchema,
  BusinessSectionSchema,
  BusinessTextFieldSchema,
  normalizeBusiness,
} from '@/services/parliament/business-model.js';
import {
  BusinessSectionItemSchema,
  listBusinessSection,
} from '@/services/parliament/business-relations.js';
import { businessOverview, resolveBusiness } from '@/services/parliament/business-service.js';
import {
  BusinessTextDocumentSchema,
  businessTextDocument,
} from '@/services/parliament/business-text.js';
import { LanguageSchema, MetadataLanguageSchema } from '@/services/parliament/normalization.js';
import { ProvenanceSchema, provenance } from '@/services/parliament/provenance.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import {
  COLLECTION_RESULT_LIMIT_BYTES,
  clampNotice,
  completeResultBytes,
  fieldTrailer,
  fitCollectionPage,
  formatParliamentResult,
  isPastEnd,
  joinNotices,
} from '../parliament-format.js';

const EffectiveFiltersSchema = z
  .object({
    businessId: z
      .string()
      .describe('Normalized canonical ID or exact published short number supplied.'),
    language: MetadataLanguageSchema.describe('Requested metadata language.'),
    section: BusinessSectionSchema.describe('Selected readable unit.'),
    textFields: z
      .array(BusinessTextFieldSchema.describe('Selected complete original text field.'))
      .optional()
      .describe('Explicit text selection; absent means automatic full or outline disclosure.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Effective row limit, present only for relationships.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Starting row offset, present only for relationships.'),
  })
  .describe('Effective business identifier, section, selectors, and paging defaults.');

const EnrichmentSchema = z.object({
  effectiveFilters: EffectiveFiltersSchema,
  returnedCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'Complete relationship rows delivered; absent for overview, texts, or missing business.',
    ),
  effectiveLimit: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe('Effective relationship limit after clamping.'),
  totalCount: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Whole selected relationship count when supplied by the source.'),
  nextOffset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Original offset plus delivered rows when more remain.'),
  hasMore: z
    .boolean()
    .optional()
    .describe('Whether selected relationship rows remain; absent for non-collection results.'),
  notice: z
    .string()
    .optional()
    .describe('Combined clamping, byte-fitting, empty-section, or past-end guidance.'),
});

/** Read independently addressable business sections without implying relationship completeness. */
export const getBusinessTool = tool('chparl_get_business', {
  description:
    'Read a Swiss parliamentary business by canonical eight-digit businessId or exact published short number. Choose overview for metadata and available text sizes; texts for original published text, automatically outlined when several fields exceed the disclosure budget; or status_history, bills, related_business, preconsultations, or subjects for independently paged relationships. textFields selects complete original fields only in texts, even when large. Paging applies only to relationships. Use subjects to narrow chparl_search_transcripts; source text and HTML remain unchanged.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    businessId: BusinessIdentifierSchema.describe(
      'Canonical eight-digit businessId from chparl_search_business, or an exact published short number such as 99.1234.',
    ),
    language: LanguageSchema.describe(
      'Metadata and business-text variant: de (default), fr, or it.',
    ),
    section: BusinessSectionSchema.default('overview').describe(
      'Readable section, default overview.',
    ),
    textFields: z
      .preprocess(
        (value) => (Array.isArray(value) && value.length === 0 ? undefined : value),
        z.array(BusinessTextFieldSchema.describe('Original field to return complete.')).optional(),
      )
      .describe('Texts only: named original fields; empty array means unset.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe('Relationships only: requested page size, default 20, clamped to 100.'),
    offset: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe(
        'Relationships only: source row offset, default zero; continue with returned nextOffset.',
      ),
  }),
  output: z.object({
    found: z.boolean().describe('Whether the requested business metadata row exists.'),
    guidance: z.string().optional().describe('Discovery guidance when the business is missing.'),
    business: BusinessOverviewSchema.optional().describe(
      'Business summary on every found result, with extra metadata on overview.',
    ),
    section: BusinessSectionSchema.describe('Selected section.'),
    textDocument: BusinessTextDocumentSchema.optional().describe(
      'Original selected texts or automatic field outline.',
    ),
    statusHistory: z
      .array(BusinessSectionItemSchema)
      .optional()
      .describe('Published status history page.'),
    bills: z
      .array(BusinessSectionItemSchema)
      .optional()
      .describe('Linked bill page; no enacted-law content is inferred.'),
    relatedBusiness: z
      .array(BusinessSectionItemSchema)
      .optional()
      .describe('Related business page.'),
    preconsultations: z
      .array(BusinessSectionItemSchema)
      .optional()
      .describe('Published committee preconsultation page.'),
    subjects: z
      .array(BusinessSectionItemSchema)
      .optional()
      .describe('Debate subjects usable in chparl_search_transcripts.'),
    provenance: ProvenanceSchema,
  }),
  enrichment: EnrichmentSchema.shape,
  enrichmentTrailer: fieldTrailer(EnrichmentSchema.shape),
  errors: [
    {
      reason: 'ambiguous_business_number',
      code: JsonRpcErrorCode.ValidationError,
      thrownBy: 'service',
      when: 'An exact short number resolves to multiple canonical business IDs.',
      recovery: 'Use chparl_search_business to identify the intended canonical businessId.',
    },
    {
      reason: 'incompatible_fields',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Text selectors or relationship paging are supplied to another section.',
      recovery:
        'Call chparl_get_business with section texts for textFields, or select a relationship section for paging.',
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
    const relationship = input.section !== 'overview' && input.section !== 'texts';
    if (
      (input.textFields !== undefined && input.section !== 'texts') ||
      (!relationship && (input.limit !== undefined || input.offset !== undefined))
    )
      throw ctx.fail('incompatible_fields');
    const requestedLimit = input.limit ?? 20;
    const paging = { limit: Math.min(requestedLimit, 100), offset: input.offset ?? 0 };
    const filters = EffectiveFiltersSchema.parse({
      businessId: input.businessId,
      language: input.language,
      section: input.section,
      ...(input.textFields !== undefined && { textFields: input.textFields }),
      ...(relationship && paging),
    });
    return withWorkflow(ctx, async (workflow) => {
      const raw = await resolveBusiness(input.businessId, input.language, workflow, !relationship);
      if (!raw) {
        ctx.enrich({ effectiveFilters: filters });
        return {
          found: false,
          section: input.section,
          guidance:
            'No business matched this identifier. Use chparl_search_business to discover a businessId, or chparl_list_reference with topic identifiers.',
          provenance: provenance(workflow.sources),
        };
      }
      if (input.section === 'overview') {
        ctx.enrich({ effectiveFilters: filters });
        return {
          found: true,
          section: input.section,
          business: businessOverview(raw, input.language),
          provenance: provenance(workflow.sources),
        };
      }
      const business = normalizeBusiness(raw, input.language);
      if (input.section === 'texts') {
        const enrichment = { effectiveFilters: filters };
        const output = {
          found: true,
          section: input.section,
          business,
          textDocument: businessTextDocument(raw, input.textFields),
          provenance: provenance(workflow.sources),
        };
        if (completeResultBytes(output, enrichment) >= COLLECTION_RESULT_LIMIT_BYTES) {
          const populated = BusinessTextFieldSchema.options.filter(
            (name) => output.textDocument[name] !== undefined,
          );
          if (!input.textFields?.length && populated.length > 1) {
            output.textDocument = businessTextDocument(raw, 'outline');
          } else {
            output.textDocument.notice =
              'This complete text selection exceeds 24000 bytes and is returned whole. Call chparl_get_business with the same businessId and language, section:texts, and textFields to select individual original fields; no field is shortened.';
          }
        }
        ctx.enrich(enrichment);
        return output;
      }
      const result = await listBusinessSection(
        business.businessId,
        input.section,
        input.language,
        paging,
        workflow,
      );
      const key = {
        status_history: 'statusHistory',
        bills: 'bills',
        related_business: 'relatedBusiness',
        preconsultations: 'preconsultations',
        subjects: 'subjects',
      }[input.section];
      const prepared = fitCollectionPage(result.items, (items, cut, oversized) => {
        const hasMore = cut || result.hasMore;
        const notice = joinNotices(
          clampNotice(requestedLimit, paging.limit),
          cut &&
            'Response byte fitting returned fewer whole relationship rows. Continue with nextOffset; no field was shortened.',
          items.length === 0 &&
            (isPastEnd(result.totalCount, paging.offset)
              ? `This offset is past the last relationship record. Call chparl_get_business with businessId:${business.businessId}, section:${input.section}, language:${input.language}, offset:0.`
              : 'This business has no published records in this section. Use another chparl_get_business section or chparl_search_transcripts for its debate.'),
          oversized &&
            `One indivisible record or its provenance exceeds 24000 bytes and is returned whole. Retrieve it with chparl_get_business businessId:${business.businessId}, section:${input.section}, language:${input.language}, offset:${paging.offset}, limit:1.`,
        );
        return {
          output: {
            found: true,
            section: input.section,
            business,
            [key]: items,
            provenance: provenance(workflow.sources),
          },
          enrichment: {
            effectiveFilters: filters,
            returnedCount: items.length,
            effectiveLimit: paging.limit,
            ...(result.totalCount !== undefined && { totalCount: result.totalCount }),
            ...(hasMore && { nextOffset: paging.offset + items.length }),
            hasMore,
            ...(notice !== undefined && { notice }),
          },
        };
      });
      ctx.enrich(prepared.enrichment);
      return prepared.output;
    });
  },
  format: formatParliamentResult,
});
