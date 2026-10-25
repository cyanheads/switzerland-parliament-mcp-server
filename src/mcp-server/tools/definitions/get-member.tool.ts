/**
 * @fileoverview Read parliamentary identity, complete base affiliations, and paged profile sections.
 * @module mcp-server/tools/definitions/get-member.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { internalError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  CouncilTermSchema,
  MemberCommitteeSchema,
  MemberInterestSchema,
  MemberPersonSchema,
  MemberProfileFiltersSchema,
  MemberSectionSchema,
  MemberSummarySchema,
} from '@/services/parliament/member-model.js';
import { MemberService } from '@/services/parliament/member-service.js';
import { Int32IdSchema, LanguageSchema } from '@/services/parliament/normalization.js';
import type { ODataPage } from '@/services/parliament/odata-client.js';
import { ProvenanceSchema, provenance } from '@/services/parliament/provenance.js';
import { withWorkflow } from '@/services/parliament/workflow.js';
import {
  completeResultBytes,
  fitCollectionPage,
  formatParliamentResult,
  renderField,
} from '../parliament-format.js';

const service = new MemberService();
const MemberOutputSchema = z.object({
  found: z.boolean().describe('Whether a Person matched the requested PersonNumber and language.'),
  guidance: z.string().optional().describe('Discovery guidance when the person is absent.'),
  person: MemberPersonSchema.optional().describe(
    'Resolved parliamentary identity, including the distinct Person.ID.',
  ),
  section: MemberSectionSchema.describe('Profile component returned.'),
  memberships: z
    .array(MemberSummarySchema)
    .optional()
    .describe(
      'Complete base MemberCouncil affiliations in overview; source continuations are drained.',
    ),
  councilTerms: z
    .array(CouncilTermSchema)
    .optional()
    .describe('Delivered complete historical council-term records.'),
  committees: z
    .array(MemberCommitteeSchema)
    .optional()
    .describe(
      'Delivered published committee memberships; not a complete historical committee ledger.',
    ),
  interests: z
    .array(MemberInterestSchema)
    .optional()
    .describe(
      'Delivered declared interests; missing paid flags stay unknown, and emptiness does not prove no conflicts of interest.',
    ),
  provenance: ProvenanceSchema,
});
type MemberOutput = z.infer<typeof MemberOutputSchema>;

/** Follow a PersonNumber through independent identity, term, committee, and interest workflows. */
export const getMemberTool = tool('chparl_get_member', {
  description:
    'Read a Swiss Parliament member by PersonNumber, which need not equal Person.ID. overview returns identity and every base MemberCouncil affiliation without pagination. Select council_terms for historical council terms, committees for published MemberCommittee rows, or interests for declared interests; those sections accept limit and offset. Missing paid status means unknown, and empty interests do not establish absence of conflicts of interest. Metadata labels remain in the selected language.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    personNumber: z
      .preprocess((value) => (typeof value === 'string' ? value.trim() : value), Int32IdSchema)
      .describe(
        'Required positive Int32 PersonNumber as a decimal string; discover with chparl_search_members.',
      ),
    language: LanguageSchema.describe(
      'Metadata language: de (default), fr, or it; uppercase is accepted.',
    ),
    section: MemberSectionSchema.default('overview').describe(
      'overview (default), council_terms, committees, or interests.',
    ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(10_000)
      .optional()
      .describe(
        'Relationship sections only: default 20, effective maximum 100 with notice. Omit for overview.',
      ),
    offset: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .describe(
        'Relationship sections only: default zero; continue with nextOffset. Omit for overview.',
      ),
  }),
  output: MemberOutputSchema,
  enrichment: {
    effectiveFilters: MemberProfileFiltersSchema.describe(
      'Normalized profile parameters and defaults for the selected section.',
    ),
    returnedCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Number of profile records returned; omitted for a missing person.'),
    effectiveLimit: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Effective page size, present only for relationship sections.'),
    totalCount: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Exact section count when supplied upstream, or the fully enumerated overview membership count.',
      ),
    nextOffset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Starting offset plus delivered records; absent when exhausted or unpaged.'),
    hasMore: z
      .boolean()
      .optional()
      .describe('Whether section records remain; false for complete overview affiliations.'),
    notice: z
      .string()
      .optional()
      .describe('Combined clamping, size, empty-section, or past-end guidance.'),
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
      when: 'Relationship pagination was supplied for overview.',
      recovery:
        'Select council_terms, committees, or interests in chparl_get_member before supplying pagination.',
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
    if (input.section === 'overview' && (input.limit !== undefined || input.offset !== undefined))
      throw ctx.fail('incompatible_fields');
    const filters = MemberProfileFiltersSchema.parse({
      personNumber: input.personNumber,
      language: input.language,
      section: input.section,
      ...(input.section !== 'overview' && {
        limit: Math.min(input.limit ?? 20, 100),
        offset: input.offset ?? 0,
      }),
    });
    return withWorkflow(ctx, async (workflow) => {
      const person = await service.getPerson(filters.personNumber, filters.language, workflow);
      if (!person) {
        ctx.enrich({ effectiveFilters: filters });
        return {
          found: false,
          section: filters.section,
          guidance:
            'No person matched this personNumber. Use chparl_search_members with membership all to discover a valid personNumber.',
          provenance: provenance(workflow.sources),
        };
      }
      if (filters.section === 'overview') {
        const memberships = await service.memberships(
          filters.personNumber,
          filters.language,
          workflow,
        );
        const output = {
          found: true,
          section: filters.section,
          person,
          memberships,
          provenance: provenance(workflow.sources),
        };
        const notices: string[] = [];
        if (memberships.length === 0)
          notices.push(
            'No records are published for this profile section. Use another chparl_get_member section or chparl_search_members with membership all.',
          );
        const enrichment = {
          effectiveFilters: filters,
          returnedCount: memberships.length,
          totalCount: memberships.length,
          hasMore: false,
        };
        if (
          completeResultBytes(output, {
            ...enrichment,
            ...(notices.length > 0 && { notice: notices.join(' ') }),
          }) >= 24_000
        )
          notices.push(
            'This complete unpaged overview exceeds 24000 bytes. All base affiliations are returned whole; use chparl_get_member section council_terms for independently paged historical terms.',
          );
        ctx.enrich({ ...enrichment, ...(notices.length > 0 && { notice: notices.join(' ') }) });
        return output;
      }
      const paging = { limit: Math.min(input.limit ?? 20, 100), offset: input.offset ?? 0 };
      const finish = <T>(page: ODataPage<T>, build: (items: T[]) => MemberOutput): MemberOutput => {
        const prepared = fitCollectionPage(page.items, (items, cut, oversized) => {
          const notices: string[] = [];
          if ((input.limit ?? 20) > 100)
            notices.push(`Requested limit ${input.limit} was clamped to 100.`);
          if (cut)
            notices.push(
              'Response byte fitting returned fewer whole profile records. Continue with nextOffset; no record fields were shortened.',
            );
          if (items.length === 0)
            notices.push(
              page.totalCount !== undefined &&
                page.totalCount > 0 &&
                paging.offset >= page.totalCount
                ? `The requested offset is past this profile section. Call chparl_get_member with personNumber=${filters.personNumber}, section=${filters.section}, language=${filters.language}, and offset=0.`
                : 'No records are published for this profile section. Use another chparl_get_member section or chparl_search_members with membership all.',
            );
          if (oversized)
            notices.push(
              `One indivisible profile record or its provenance exceeds 24000 bytes. Retrieve it with chparl_get_member personNumber=${filters.personNumber}, section=${filters.section}, language=${filters.language}, offset=${paging.offset}, limit=1. The record is returned whole.`,
            );
          const hasMore = cut || page.hasMore;
          return {
            output: build(items),
            enrichment: {
              effectiveFilters: filters,
              returnedCount: items.length,
              effectiveLimit: paging.limit,
              ...(page.totalCount !== undefined && { totalCount: page.totalCount }),
              ...(hasMore && { nextOffset: paging.offset + items.length }),
              hasMore,
              ...(notices.length > 0 && { notice: notices.join(' ') }),
            },
          };
        });
        ctx.enrich(prepared.enrichment);
        return prepared.output;
      };
      const base = () => ({
        found: true,
        person,
        section: filters.section,
        provenance: provenance(workflow.sources),
      });
      switch (filters.section) {
        case 'council_terms':
          return finish(
            await service.councilTerms(filters.personNumber, filters.language, paging, workflow),
            (councilTerms) => ({ ...base(), councilTerms }),
          );
        case 'committees':
          return finish(
            await service.committees(filters.personNumber, filters.language, paging, workflow),
            (committees) => ({ ...base(), committees }),
          );
        case 'interests':
          return finish(
            await service.interests(filters.personNumber, filters.language, paging, workflow),
            (interests) => ({ ...base(), interests }),
          );
        default: {
          const exhaustive: never = filters.section;
          throw internalError(`Unhandled profile section: ${exhaustive}`);
        }
      }
    });
  },
  format: formatParliamentResult,
});
