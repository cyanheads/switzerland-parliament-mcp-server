/**
 * @fileoverview Typed procedural business sections with direct filtered OData paging.
 * @module services/parliament/business-relations
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import type { BusinessSectionSchema } from './business-model.js';
import {
  Int64IdSchema,
  type Language,
  ODataDateSchema,
  odataInt32,
  odataString,
} from './normalization.js';
import {
  type ODataClient,
  type ODataPage,
  type ODataQuery,
  PARLIAMENT_ORIGIN,
} from './odata-client.js';
import type { WorkflowContext } from './workflow.js';

const Text = z.string().nullish();
const Integer = z.number().int().min(-2_147_483_648).max(2_147_483_647).nullish();
const DateValue = ODataDateSchema.nullish();
const RawSectionSchema = z.object({
  ID: z.guid().optional(),
  Language: z.enum(['DE', 'FR', 'IT']),
  BusinessNumber: Integer,
  BusinessStatusId: Integer,
  BusinessStatusName: Text,
  BusinessStatusDate: DateValue,
  IsMotionInSecondCouncil: z.boolean().nullish(),
  NewKey: Integer,
  Modified: DateValue,
  BillNumber: Integer,
  BillType: Integer,
  BillTypeName: Text,
  Title: Text,
  BusinessStatus: Integer,
  BusinessStatusText: Text,
  SubmissionDate: DateValue,
  RelatedBusinessNumber: Integer,
  RelatedBusinessShortNumber: Text,
  RelatedBusinessTitle: Text,
  RelatedBusinessType: Integer,
  RelatedBusinessTypeName: Text,
  RelatedBusinessTypeAbbreviation: Text,
  PriorityCode: Text,
  IdBill: z.guid().nullish(),
  CommitteeNumber: Integer,
  CommitteeName: Text,
  Abbreviation: Text,
  Abbreviation1: Text,
  Abbreviation2: Text,
  PreconsultationDate: DateValue,
  TreatmentCategory: Text,
  IdSubject: Int64IdSchema.optional(),
  SortOrder: Integer,
  PublishedNotes: Text,
});

/** Complete selected procedural fields; absent source values remain unknown. */
export const BusinessSectionItemSchema = z
  .object({
    id: z
      .string()
      .optional()
      .describe('Published relationship GUID; subjects instead carry subjectId.'),
    statusId: z.string().optional().describe('Published status code.'),
    statusName: z.string().optional().describe('Published historical status name.'),
    date: z.string().optional().describe('Published status date.'),
    isMotionInSecondCouncil: z
      .boolean()
      .optional()
      .describe('Published second-council motion flag.'),
    newKey: z.number().int().optional().describe('Published NewKey value.'),
    modifiedAt: z.string().optional().describe('Source modification date.'),
    billNumber: z.number().int().optional().describe('Published bill number within the business.'),
    billTypeId: z.string().optional().describe('Published bill type code.'),
    billTypeName: z.string().optional().describe('Published bill type name.'),
    title: z.string().optional().describe('Published bill or debate-subject title.'),
    statusText: z.string().optional().describe('Published bill status label.'),
    statusDate: z.string().optional().describe('Published bill status date.'),
    submissionDate: z.string().optional().describe('Published bill submission date.'),
    sourceUrl: z.string().optional().describe('Exact HTTPS source entity URL for a linked bill.'),
    relatedBusinessId: z.string().optional().describe('Related canonical business ID.'),
    shortNumber: z.string().optional().describe('Related business published short number.'),
    typeId: z.string().optional().describe('Related business type code.'),
    typeName: z.string().optional().describe('Related business type name.'),
    typeAbbreviation: z.string().optional().describe('Related business type abbreviation.'),
    priorityCode: z.string().optional().describe('Published relationship priority code.'),
    billId: z.string().optional().describe('Linked bill GUID.'),
    committeeId: z.string().optional().describe('Published committee number.'),
    committeeName: z.string().optional().describe('Published committee name.'),
    committeeAbbreviation: z.string().optional().describe('Published Abbreviation value.'),
    committeeAbbreviation1: z.string().optional().describe('Published Abbreviation1 value.'),
    committeeAbbreviation2: z.string().optional().describe('Published Abbreviation2 value.'),
    preconsultationDate: z.string().optional().describe('Published preconsultation date.'),
    treatmentCategory: z.string().optional().describe('Published treatment category.'),
    subjectId: z.string().optional().describe('Exact Int64 debate-subject ID.'),
    businessId: z
      .string()
      .optional()
      .describe('Canonical business ID for this subject relationship.'),
    sortOrder: z.number().int().optional().describe('Published subject order.'),
    publishedNotes: z.string().optional().describe('Original published subject notes.'),
  })
  .describe('One complete procedural relationship row for the selected section.');

/** A business section with independent source paging. */
export type BusinessSectionItem = z.infer<typeof BusinessSectionItemSchema>;

/** Relationship sections accepted by the direct paged reader. */
export type BusinessRelationshipSection = Exclude<
  z.infer<typeof BusinessSectionSchema>,
  'overview' | 'texts'
>;

type Definition = {
  entity: ODataQuery['entity'];
  fields: readonly string[];
  orderBy: ODataQuery['orderBy'];
};
const definitions: Record<BusinessRelationshipSection, Definition> = {
  status_history: {
    entity: 'BusinessStatus',
    fields: [
      'ID',
      'BusinessStatusId',
      'BusinessStatusName',
      'BusinessStatusDate',
      'IsMotionInSecondCouncil',
      'NewKey',
      'Modified',
    ],
    orderBy: [
      { field: 'BusinessStatusDate', direction: 'asc' },
      { field: 'ID', direction: 'asc' },
    ],
  },
  bills: {
    entity: 'Bill',
    fields: [
      'ID',
      'BillNumber',
      'BillType',
      'BillTypeName',
      'Title',
      'BusinessStatus',
      'BusinessStatusText',
      'BusinessStatusDate',
      'SubmissionDate',
      'Modified',
    ],
    orderBy: [
      { field: 'BillNumber', direction: 'asc' },
      { field: 'ID', direction: 'asc' },
    ],
  },
  related_business: {
    entity: 'RelatedBusiness',
    fields: [
      'ID',
      'RelatedBusinessNumber',
      'RelatedBusinessShortNumber',
      'RelatedBusinessTitle',
      'RelatedBusinessType',
      'RelatedBusinessTypeName',
      'RelatedBusinessTypeAbbreviation',
      'PriorityCode',
      'Modified',
    ],
    orderBy: [
      { field: 'RelatedBusinessNumber', direction: 'asc' },
      { field: 'ID', direction: 'asc' },
    ],
  },
  preconsultations: {
    entity: 'Preconsultation',
    fields: [
      'ID',
      'IdBill',
      'BillNumber',
      'CommitteeNumber',
      'CommitteeName',
      'Abbreviation',
      'Abbreviation1',
      'Abbreviation2',
      'PreconsultationDate',
      'TreatmentCategory',
      'Modified',
    ],
    orderBy: [
      { field: 'PreconsultationDate', direction: 'asc' },
      { field: 'ID', direction: 'asc' },
    ],
  },
  subjects: {
    entity: 'SubjectBusiness',
    fields: ['IdSubject', 'Title', 'SortOrder', 'PublishedNotes', 'Modified'],
    orderBy: [{ field: 'IdSubject', direction: 'asc' }],
  },
};

/** Page the chosen section directly; deferred or partial navigation collections are never used. */
export async function listBusinessSection(
  client: ODataClient,
  businessId: string,
  section: BusinessRelationshipSection,
  language: Language,
  paging: { limit: number; offset: number },
  workflow: WorkflowContext,
): Promise<ODataPage<BusinessSectionItem>> {
  const definition = definitions[section];
  const schema: z.ZodType<z.infer<typeof RawSectionSchema>> =
    section === 'subjects'
      ? RawSectionSchema.extend({
          IdSubject: Int64IdSchema,
          BusinessNumber: z.number().int().positive().max(2_147_483_647),
        })
      : RawSectionSchema.extend({ ID: z.guid() });
  const page = await client.collection(
    {
      entity: definition.entity,
      language,
      filter: `BusinessNumber eq ${odataInt32(businessId)}`,
      select: ['Language', 'BusinessNumber', ...definition.fields],
      orderBy: definition.orderBy,
    },
    schema,
    paging,
    workflow,
  );
  return {
    ...page,
    items: page.items.map((raw) => {
      if (
        raw.Language !== language.toUpperCase() ||
        (raw.BusinessNumber != null && String(raw.BusinessNumber) !== businessId)
      )
        throw serializationError('Parliament returned a mismatched business relationship.');
      return {
        ...(raw.ID !== undefined && { id: raw.ID }),
        ...(raw.Modified != null && { modifiedAt: raw.Modified }),
        ...(raw.BusinessStatusId != null && { statusId: String(raw.BusinessStatusId) }),
        ...(raw.BusinessStatusName != null && { statusName: raw.BusinessStatusName }),
        ...(section === 'status_history' &&
          raw.BusinessStatusDate != null && { date: raw.BusinessStatusDate }),
        ...(raw.IsMotionInSecondCouncil != null && {
          isMotionInSecondCouncil: raw.IsMotionInSecondCouncil,
        }),
        ...(raw.NewKey != null && { newKey: raw.NewKey }),
        ...(raw.BillNumber != null && { billNumber: raw.BillNumber }),
        ...(raw.BillType != null && { billTypeId: String(raw.BillType) }),
        ...(raw.BillTypeName != null && { billTypeName: raw.BillTypeName }),
        ...(raw.Title != null && { title: raw.Title }),
        ...(raw.BusinessStatus != null && { statusId: String(raw.BusinessStatus) }),
        ...(raw.BusinessStatusText != null && { statusText: raw.BusinessStatusText }),
        ...(section === 'bills' &&
          raw.BusinessStatusDate != null && { statusDate: raw.BusinessStatusDate }),
        ...(raw.SubmissionDate != null && { submissionDate: raw.SubmissionDate }),
        ...(section === 'bills' &&
          raw.ID !== undefined && {
            sourceUrl: `${PARLIAMENT_ORIGIN}/odata.svc/Bill(ID=guid'${raw.ID}',Language=${odataString(language.toUpperCase())})?$format=json`,
          }),
        ...(raw.RelatedBusinessNumber != null && {
          relatedBusinessId: String(raw.RelatedBusinessNumber),
        }),
        ...(raw.RelatedBusinessShortNumber != null && {
          shortNumber: raw.RelatedBusinessShortNumber,
        }),
        ...(raw.RelatedBusinessTitle != null && { title: raw.RelatedBusinessTitle }),
        ...(raw.RelatedBusinessType != null && { typeId: String(raw.RelatedBusinessType) }),
        ...(raw.RelatedBusinessTypeName != null && { typeName: raw.RelatedBusinessTypeName }),
        ...(raw.RelatedBusinessTypeAbbreviation != null && {
          typeAbbreviation: raw.RelatedBusinessTypeAbbreviation,
        }),
        ...(raw.PriorityCode != null && { priorityCode: raw.PriorityCode }),
        ...(raw.IdBill != null && { billId: raw.IdBill }),
        ...(raw.CommitteeNumber != null && { committeeId: String(raw.CommitteeNumber) }),
        ...(raw.CommitteeName != null && { committeeName: raw.CommitteeName }),
        ...(raw.Abbreviation != null && { committeeAbbreviation: raw.Abbreviation }),
        ...(raw.Abbreviation1 != null && { committeeAbbreviation1: raw.Abbreviation1 }),
        ...(raw.Abbreviation2 != null && { committeeAbbreviation2: raw.Abbreviation2 }),
        ...(raw.PreconsultationDate != null && { preconsultationDate: raw.PreconsultationDate }),
        ...(raw.TreatmentCategory != null && { treatmentCategory: raw.TreatmentCategory }),
        ...(raw.IdSubject !== undefined && { subjectId: raw.IdSubject, businessId }),
        ...(raw.SortOrder != null && { sortOrder: raw.SortOrder }),
        ...(raw.PublishedNotes != null && { publishedNotes: raw.PublishedNotes }),
      };
    }),
  };
}
