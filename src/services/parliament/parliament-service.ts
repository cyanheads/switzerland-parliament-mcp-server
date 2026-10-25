/**
 * @fileoverview Parliament reference workflows built on the shared OData network boundary.
 * @module services/parliament/parliament-service
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import { ODataDateSchema, odataDay } from './normalization.js';
import { ODataClient, type ODataPage, type ODataQuery } from './odata-client.js';
import type { ReferenceFilters, ReferenceItem } from './reference-model.js';
import { staticReference } from './static-reference.js';
import { remainingWorkflowMs, type WorkflowContext } from './workflow.js';

const RawInt32 = z.number().int().nonnegative().max(2_147_483_647);
const RawId = RawInt32.positive();
const RawText = z.string().nullish();
const RawDate = ODataDateSchema.nullish();
const RawReferenceSchema = z.object({
  ID: RawId,
  Language: z.enum(['DE', 'FR', 'IT']),
  BusinessTypeName: RawText,
  BusinessTypeAbbreviation: RawText,
  CouncilName: RawText,
  CouncilAbbreviation: RawText,
  CantonNumber: RawId.optional(),
  CantonName: RawText,
  CantonAbbreviation: RawText,
  PartyNumber: RawId.optional(),
  PartyName: RawText,
  PartyAbbreviation: RawText,
  ParlGroupNumber: RawId.optional(),
  ParlGroupName: RawText,
  ParlGroupAbbreviation: RawText,
  ParlGroupCode: RawText,
  IsActive: z.boolean().nullish(),
  CommitteeNumber: RawId.optional(),
  CommitteeName: RawText,
  Abbreviation1: RawText,
  Council: RawInt32.nullish(),
  CommitteeTypeName: RawText,
  SessionName: RawText,
  Abbreviation: RawText,
  SessionNumber: z.number().int().min(-32_768).max(32_767).optional(),
  TypeName: RawText,
  LegislativePeriodNumber: z.number().int().min(-32_768).max(32_767).optional(),
  StartDate: RawDate,
  EndDate: RawDate,
});
type RawReference = z.infer<typeof RawReferenceSchema>;
type LiveTopic = Exclude<
  ReferenceFilters['topic'],
  'identifiers' | 'coverage' | 'languages' | 'statuses'
>;
type ReferenceDefinition = {
  entity: ODataQuery['entity'];
  key: 'ID' | 'CantonNumber' | 'PartyNumber' | 'ParlGroupNumber' | 'CommitteeNumber';
  label:
    | 'BusinessTypeName'
    | 'CouncilName'
    | 'CantonName'
    | 'PartyName'
    | 'ParlGroupName'
    | 'CommitteeName'
    | 'SessionName';
  abbreviation:
    | 'BusinessTypeAbbreviation'
    | 'CouncilAbbreviation'
    | 'CantonAbbreviation'
    | 'PartyAbbreviation'
    | 'ParlGroupAbbreviation'
    | 'Abbreviation1'
    | 'Abbreviation';
  fields: readonly string[];
  schema: z.ZodType<RawReference>;
  orderBy: ODataQuery['orderBy'];
};

const definitions: Record<LiveTopic, ReferenceDefinition> = {
  business_types: {
    entity: 'BusinessType',
    key: 'ID',
    label: 'BusinessTypeName',
    abbreviation: 'BusinessTypeAbbreviation',
    fields: ['BusinessTypeName', 'BusinessTypeAbbreviation'],
    schema: RawReferenceSchema,
    orderBy: [{ field: 'ID', direction: 'asc' }],
  },
  councils: {
    entity: 'Council',
    key: 'ID',
    label: 'CouncilName',
    abbreviation: 'CouncilAbbreviation',
    fields: ['CouncilName', 'CouncilAbbreviation'],
    schema: RawReferenceSchema,
    orderBy: [{ field: 'ID', direction: 'asc' }],
  },
  cantons: {
    entity: 'Canton',
    key: 'CantonNumber',
    label: 'CantonName',
    abbreviation: 'CantonAbbreviation',
    fields: ['CantonNumber', 'CantonName', 'CantonAbbreviation'],
    schema: RawReferenceSchema.extend({ CantonNumber: RawId }),
    orderBy: [
      { field: 'CantonNumber', direction: 'asc' },
      { field: 'ID', direction: 'asc' },
    ],
  },
  parties: {
    entity: 'Party',
    key: 'PartyNumber',
    label: 'PartyName',
    abbreviation: 'PartyAbbreviation',
    fields: ['PartyNumber', 'PartyName', 'PartyAbbreviation', 'StartDate', 'EndDate'],
    schema: RawReferenceSchema.extend({ PartyNumber: RawId }),
    orderBy: [
      { field: 'PartyNumber', direction: 'asc' },
      { field: 'ID', direction: 'asc' },
    ],
  },
  groups: {
    entity: 'ParlGroup',
    key: 'ParlGroupNumber',
    label: 'ParlGroupName',
    abbreviation: 'ParlGroupAbbreviation',
    fields: [
      'ParlGroupNumber',
      'ParlGroupName',
      'ParlGroupAbbreviation',
      'ParlGroupCode',
      'IsActive',
    ],
    schema: RawReferenceSchema.extend({ ParlGroupNumber: RawId }),
    orderBy: [
      { field: 'ParlGroupNumber', direction: 'asc' },
      { field: 'ID', direction: 'asc' },
    ],
  },
  committees: {
    entity: 'Committee',
    key: 'CommitteeNumber',
    label: 'CommitteeName',
    abbreviation: 'Abbreviation1',
    fields: ['CommitteeNumber', 'CommitteeName', 'Abbreviation1', 'Council', 'CommitteeTypeName'],
    schema: RawReferenceSchema.extend({ CommitteeNumber: RawId }),
    orderBy: [
      { field: 'CommitteeNumber', direction: 'asc' },
      { field: 'ID', direction: 'asc' },
    ],
  },
  sessions: {
    entity: 'Session',
    key: 'ID',
    label: 'SessionName',
    abbreviation: 'Abbreviation',
    fields: [
      'SessionName',
      'Abbreviation',
      'SessionNumber',
      'TypeName',
      'LegislativePeriodNumber',
      'StartDate',
      'EndDate',
    ],
    schema: RawReferenceSchema,
    orderBy: [
      { field: 'StartDate', direction: 'desc' },
      { field: 'ID', direction: 'desc' },
    ],
  },
};

function normalizeReference(
  raw: RawReference,
  definition: ReferenceDefinition,
  topic: LiveTopic,
): ReferenceItem {
  const key = raw[definition.key];
  if (key === undefined)
    throw serializationError('Parliament reference row is missing its dictionary key.');
  const label = raw[definition.label];
  const abbreviation = raw[definition.abbreviation];
  const sessionParts = [
    raw.SessionNumber === undefined ? undefined : `SessionNumber: ${raw.SessionNumber}`,
    raw.TypeName == null ? undefined : `TypeName: ${raw.TypeName}`,
  ].filter((value) => value !== undefined);
  const description =
    topic === 'sessions'
      ? sessionParts.length > 0
        ? sessionParts.join('\n')
        : undefined
      : raw.CommitteeTypeName;
  return {
    id: String(key),
    ...(label != null && { label }),
    ...(abbreviation != null && { abbreviation }),
    ...(raw.ParlGroupCode != null && { code: raw.ParlGroupCode }),
    ...(description != null && { description }),
    ...(raw.StartDate != null && { startDate: raw.StartDate }),
    ...(raw.EndDate != null && { endDate: raw.EndDate }),
    ...(raw.IsActive != null && { active: raw.IsActive }),
    ...(raw.Council != null && { councilId: String(raw.Council) }),
    ...(raw.LegislativePeriodNumber !== undefined && {
      legislativePeriod: raw.LegislativePeriodNumber,
    }),
  };
}

/** Source-specific workflows; request state is always explicit and never cached. */
export class ParliamentService {
  readonly #client = new ODataClient();

  /** List one static or live reference topic, preserving source keys and sparse labels. */
  async listReference(
    filters: ReferenceFilters,
    workflow: WorkflowContext,
  ): Promise<ODataPage<ReferenceItem>> {
    remainingWorkflowMs(workflow);
    if (
      filters.topic === 'identifiers' ||
      filters.topic === 'coverage' ||
      filters.topic === 'languages' ||
      filters.topic === 'statuses'
    ) {
      const snapshot = staticReference(filters.topic, filters.language);
      workflow.sources.push(...snapshot.sources);
      const items = snapshot.items.slice(filters.offset, filters.offset + filters.limit);
      const hasMore = filters.offset + items.length < snapshot.items.length;
      return {
        items,
        totalCount: snapshot.items.length,
        hasMore,
        ...(hasMore && { nextOffset: filters.offset + items.length }),
      };
    }
    const topic = filters.topic;
    const definition = definitions[topic];
    const predicates: string[] = [];
    if (filters.dateFrom) predicates.push(`StartDate ge ${odataDay(filters.dateFrom)}`);
    if (filters.dateTo) predicates.push(`EndDate le ${odataDay(filters.dateTo, 'end')}`);
    const query: ODataQuery = {
      entity: definition.entity,
      language: filters.language,
      select: ['ID', 'Language', ...definition.fields],
      orderBy: definition.orderBy,
      ...(predicates.length > 0 && { filter: predicates.join(' and ') }),
    };
    const page = await this.#client.collection(query, definition.schema, filters, workflow);
    for (const raw of page.items) {
      if (raw.Language !== filters.language.toUpperCase())
        throw serializationError(
          'Parliament returned a reference row in a different metadata language.',
        );
    }
    return {
      ...page,
      items: page.items.map((raw) => normalizeReference(raw, definition, topic)),
    };
  }
}

let service: ParliamentService | undefined;

/** Initialize the stateless Parliament service during application setup. */
export function initParliamentService(): void {
  service = new ParliamentService();
}

/** Access the initialized service; a missing setup call is a programmer error. */
export function getParliamentService(): ParliamentService {
  if (!service) throw new Error('ParliamentService was not initialized in application setup.');
  return service;
}
