/**
 * @fileoverview Business record schemas, selected source fields, and lossless summary mapping.
 * @module services/parliament/business-model
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import {
  Int32IdSchema,
  type Language,
  MetadataLanguageSchema,
  RawDate,
  RawId,
  RawInt32,
  RawLanguage,
  RawText,
} from './normalization.js';
import { odataEntityUrl } from './odata-client.js';

/** Canonical eight-digit business ID or an exact published short number; no century inference. */
export const BusinessIdentifierSchema = z
  .string()
  .trim()
  .regex(/^(?:[1-9]\d{7}|\d{2}\.\d{3,4})$/);

/** Selectable original business text fields and their upstream property names. */
export const BUSINESS_TEXT_FIELDS = {
  description: 'Description',
  initialSituation: 'InitialSituation',
  proceedings: 'Proceedings',
  draftText: 'DraftText',
  submittedText: 'SubmittedText',
  reasonText: 'ReasonText',
  documentationText: 'DocumentationText',
  motionText: 'MotionText',
  federalCouncilResponseText: 'FederalCouncilResponseText',
  federalCouncilProposalText: 'FederalCouncilProposalText',
} as const;

/** One original text field name accepted by chparl_get_business. */
export const BusinessTextFieldSchema = z.enum(
  Object.keys(BUSINESS_TEXT_FIELDS) as (keyof typeof BUSINESS_TEXT_FIELDS)[],
);

/** Named business sections; every relationship is independently paged. */
export const BusinessSectionSchema = z.enum([
  'overview',
  'texts',
  'status_history',
  'bills',
  'related_business',
  'preconsultations',
  'subjects',
]);

/** Summary projection deliberately excludes original large text fields. */
export const BUSINESS_SUMMARY_FIELDS = [
  'ID',
  'Language',
  'BusinessShortNumber',
  'Title',
  'BusinessType',
  'BusinessTypeName',
  'BusinessTypeAbbreviation',
  'BusinessStatus',
  'BusinessStatusText',
  'BusinessStatusDate',
  'SubmissionDate',
  'SubmittedBy',
  'SubmissionCouncil',
  'SubmissionCouncilName',
  'SubmissionSession',
  'Modified',
] as const;

/** Overview-only metadata and original texts used to disclose available field sizes. */
export const BUSINESS_DETAIL_FIELDS = [
  'ResponsibleDepartment',
  'ResponsibleDepartmentName',
  'ResponsibleDepartmentAbbreviation',
  'FederalCouncilProposal',
  'FederalCouncilProposalDate',
  'FirstCouncil1',
  'FirstCouncil1Name',
  'FirstCouncil2',
  'FirstCouncil2Name',
  'Tags',
  'TagNames',
  'Category',
  ...Object.values(BUSINESS_TEXT_FIELDS),
] as const;

/** Validate selected fields at the OData edge while ignoring additive source properties. */
export const RawBusinessSchema = z.object({
  ID: RawId,
  Language: RawLanguage,
  BusinessShortNumber: RawText,
  Title: RawText,
  BusinessType: RawInt32,
  BusinessTypeName: RawText,
  BusinessTypeAbbreviation: RawText,
  BusinessStatus: RawInt32,
  BusinessStatusText: RawText,
  BusinessStatusDate: RawDate,
  SubmissionDate: RawDate,
  SubmittedBy: RawText,
  SubmissionCouncil: RawInt32,
  SubmissionCouncilName: RawText,
  SubmissionSession: RawInt32,
  Modified: RawDate,
  ResponsibleDepartment: RawInt32,
  ResponsibleDepartmentName: RawText,
  ResponsibleDepartmentAbbreviation: RawText,
  FederalCouncilProposal: RawInt32,
  FederalCouncilProposalDate: RawDate,
  FirstCouncil1: RawInt32,
  FirstCouncil1Name: RawText,
  FirstCouncil2: RawInt32,
  FirstCouncil2Name: RawText,
  Tags: RawText,
  TagNames: RawText,
  Category: RawText,
  Description: RawText,
  InitialSituation: RawText,
  Proceedings: RawText,
  DraftText: RawText,
  SubmittedText: RawText,
  ReasonText: RawText,
  DocumentationText: RawText,
  MotionText: RawText,
  FederalCouncilResponseText: RawText,
  FederalCouncilProposalText: RawText,
});

/** Validated business source record with dates normalized once at the network boundary. */
export type RawBusiness = z.infer<typeof RawBusinessSchema>;

/** Shared business identity returned by discovery and downstream workflows. */
export const BusinessSummarySchema = z
  .object({
    businessId: z.string().describe('Canonical Business.ID as a decimal string.'),
    metadataLanguage: MetadataLanguageSchema.describe(
      'Requested metadata row language; no text translation is implied.',
    ),
    sourceUrl: z.string().describe('Exact HTTPS OData entity URL for this metadata row.'),
    shortNumber: z.string().optional().describe('Published BusinessShortNumber, unchanged.'),
    title: z.string().optional().describe('Published business title.'),
    typeId: z.string().optional().describe('Published business type code.'),
    typeName: z.string().optional().describe('Published type name.'),
    typeAbbreviation: z.string().optional().describe('Published type abbreviation.'),
    statusId: z
      .string()
      .optional()
      .describe('Current business status code, including unknown source codes.'),
    statusText: z.string().optional().describe('Published current status label.'),
    statusDate: z
      .string()
      .optional()
      .describe('Current status date with source timezone semantics.'),
    submissionDate: z.string().optional().describe('Published submission date.'),
    submittedBy: z
      .string()
      .optional()
      .describe('Published submitter label; not an exhaustive signatory list.'),
    submissionCouncilId: z.string().optional().describe('Council code at submission.'),
    submissionCouncilName: z.string().optional().describe('Published submission council name.'),
    submissionSessionId: z.string().optional().describe('Submission session identifier.'),
    modifiedAt: z.string().optional().describe('Source modification date.'),
  })
  .describe('One parliamentary business, preserving sparse source metadata.');

/** Normalized summary used by business, vote, and debate workflows. */
export type BusinessSummary = z.infer<typeof BusinessSummarySchema>;

/** Normalize only present values, retaining empty source strings. */
export function normalizeBusiness(raw: RawBusiness, language: Language): BusinessSummary {
  if (raw.Language !== language.toUpperCase())
    throw serializationError('Parliament returned a business in a different metadata language.');
  return {
    businessId: String(raw.ID),
    metadataLanguage: language,
    sourceUrl: `${odataEntityUrl('Business', String(raw.ID), language)}?$format=json`,
    ...(raw.BusinessShortNumber != null && { shortNumber: raw.BusinessShortNumber }),
    ...(raw.Title != null && { title: raw.Title }),
    ...(raw.BusinessType != null && { typeId: String(raw.BusinessType) }),
    ...(raw.BusinessTypeName != null && { typeName: raw.BusinessTypeName }),
    ...(raw.BusinessTypeAbbreviation != null && { typeAbbreviation: raw.BusinessTypeAbbreviation }),
    ...(raw.BusinessStatus != null && { statusId: String(raw.BusinessStatus) }),
    ...(raw.BusinessStatusText != null && { statusText: raw.BusinessStatusText }),
    ...(raw.BusinessStatusDate != null && { statusDate: raw.BusinessStatusDate }),
    ...(raw.SubmissionDate != null && { submissionDate: raw.SubmissionDate }),
    ...(raw.SubmittedBy != null && { submittedBy: raw.SubmittedBy }),
    ...(raw.SubmissionCouncil != null && { submissionCouncilId: String(raw.SubmissionCouncil) }),
    ...(raw.SubmissionCouncilName != null && { submissionCouncilName: raw.SubmissionCouncilName }),
    ...(raw.SubmissionSession != null && { submissionSessionId: String(raw.SubmissionSession) }),
    ...(raw.Modified != null && { modifiedAt: raw.Modified }),
  };
}

/** Fully disclosed overview metadata; text content remains accessible through the texts section. */
export const BusinessOverviewSchema = BusinessSummarySchema.extend({
  responsibleDepartmentId: z.string().optional().describe('Responsible department code.'),
  responsibleDepartmentName: z.string().optional().describe('Published department name.'),
  responsibleDepartmentAbbreviation: z
    .string()
    .optional()
    .describe('Published department abbreviation.'),
  federalCouncilProposalId: z
    .string()
    .optional()
    .describe('Published Federal Council proposal code.'),
  federalCouncilProposalDate: z
    .string()
    .optional()
    .describe('Published Federal Council proposal date.'),
  firstCouncil1Id: z.string().optional().describe('FirstCouncil1 code from the source.'),
  firstCouncil1Name: z.string().optional().describe('FirstCouncil1 name from the source.'),
  firstCouncil2Id: z.string().optional().describe('FirstCouncil2 code from the source.'),
  firstCouncil2Name: z.string().optional().describe('FirstCouncil2 name from the source.'),
  tags: z.string().optional().describe('Original Tags value.'),
  tagNames: z.string().optional().describe('Original TagNames value.'),
  category: z.string().optional().describe('Published business category.'),
  availableTextFields: z
    .array(
      z
        .object({
          name: BusinessTextFieldSchema.describe('Selectable original text name.'),
          sizeBytes: z
            .number()
            .int()
            .nonnegative()
            .optional()
            .describe('UTF-8 bytes; absent means the text is unpublished.'),
        })
        .describe('Availability of one supported original text field.'),
    )
    .optional()
    .describe('Every supported text field; present on overview only.'),
}).describe('Business identity and optional overview metadata.');

/** Normalized search inputs echoed on both client surfaces. */
export const BusinessSearchFiltersSchema = z
  .object({
    language: MetadataLanguageSchema.describe('Metadata language.'),
    query: z.string().optional().describe('Exact title substring.'),
    author: z.string().optional().describe('Exact submitter-label substring.'),
    typeId: Int32IdSchema.optional().describe('Business type code.'),
    statusId: Int32IdSchema.optional().describe('Current status code.'),
    sessionId: Int32IdSchema.optional().describe('Submission session code.'),
    committeeId: Int32IdSchema.optional().describe('Committee role code.'),
    submittedFrom: z.string().optional().describe('Inclusive submission-date lower bound.'),
    submittedTo: z.string().optional().describe('Inclusive submission-date upper bound.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .describe('Effective role-candidate or business row limit.'),
    cursor: z.string().optional().describe('Validated cursor supplied for this page.'),
  })
  .describe('Effective business discovery filters and defaults.');

/** Normalized filters consumed by business discovery. */
export type BusinessSearchFilters = z.infer<typeof BusinessSearchFiltersSchema>;
