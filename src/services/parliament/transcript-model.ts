/**
 * @fileoverview Bulletin passage edge schemas and lossless original-text normalization.
 * @module services/parliament/transcript-model
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';
import { BusinessTextReferenceSchema, businessTextReferences } from './business-text.js';
import {
  Int64IdSchema,
  type Language,
  MetadataLanguageSchema,
  normalizeMeetingDate,
  odataInt64,
  RawDate,
  RawInt32,
  RawLanguage,
  RawText,
  utf8ByteLength,
} from './normalization.js';
import { odataEntityUrl } from './odata-client.js';

/** Text remains selected in metadata mode so its actual UTF-8 size can be measured. */
export const TRANSCRIPT_FIELDS = [
  'ID',
  'Language',
  'IdSubject',
  'PersonNumber',
  'SpeakerFirstName',
  'SpeakerLastName',
  'SpeakerFullName',
  'SpeakerFunction',
  'Type',
  'MeetingCouncilAbbreviation',
  'CouncilId',
  'CouncilName',
  'MeetingDate',
  'IdSession',
  'SortOrder',
  'Start',
  'End',
  'StartTimeWithTimezone',
  'EndTimeWithTimezone',
  'LanguageOfText',
  'VoteId',
  'VoteBusinessNumber',
  'VoteBusinessShortNumber',
  'Text',
] as const;

/** The source's Int64 values remain strings; nullable metadata never becomes a fabricated value. */
export const RawTranscriptSchema = z.object({
  ID: Int64IdSchema,
  Language: RawLanguage,
  IdSubject: Int64IdSchema.nullish(),
  PersonNumber: RawInt32,
  SpeakerFirstName: RawText,
  SpeakerLastName: RawText,
  SpeakerFullName: RawText,
  SpeakerFunction: RawText,
  Type: z.number().int().min(-32_768).max(32_767).nullish(),
  MeetingCouncilAbbreviation: RawText,
  CouncilId: RawInt32,
  CouncilName: RawText,
  MeetingDate: z.string().transform(normalizeMeetingDate).nullish(),
  IdSession: RawText,
  SortOrder: RawInt32,
  Start: RawDate,
  End: RawDate,
  StartTimeWithTimezone: RawDate,
  EndTimeWithTimezone: RawDate,
  LanguageOfText: RawText,
  VoteId: RawText,
  VoteBusinessNumber: RawInt32,
  VoteBusinessShortNumber: RawText,
  Text: RawText,
});

/** One source-validated Bulletin row with normalized calendar dates and instants. */
export type RawTranscript = z.infer<typeof RawTranscriptSchema>;

/** One whole Bulletin passage; metadata language does not identify the speaker's language. */
export const TranscriptSchema = z
  .object({
    transcriptId: z.string().describe('Transcript.ID as an exact signed Int64 decimal string.'),
    metadataLanguage: MetadataLanguageSchema.describe(
      'Selected metadata row language; original text is never translated.',
    ),
    sourceUrl: z.string().describe('Exact HTTPS OData composite-key passage URL.'),
    subjectId: z
      .string()
      .optional()
      .describe('Published debate IdSubject as an exact Int64 string.'),
    personNumber: z
      .string()
      .optional()
      .describe('Published speaker PersonNumber, distinct from Person.ID.'),
    speakerFirstName: z.string().optional().describe('Original speaker first name.'),
    speakerLastName: z.string().optional().describe('Original speaker last name.'),
    speakerName: z
      .string()
      .optional()
      .describe('Original SpeakerFullName, without reconstructing a missing name.'),
    speakerFunction: z.string().optional().describe('Original speaker function label.'),
    type: z.number().int().optional().describe('Published open Bulletin passage type code.'),
    councilId: z.string().optional().describe('Published CouncilId.'),
    councilName: z.string().optional().describe('Original council name.'),
    council: z.string().optional().describe('Original MeetingCouncilAbbreviation.'),
    meetingDate: z
      .string()
      .optional()
      .describe('Published calendar day as YYYY-MM-DD, without an inferred timezone.'),
    sessionId: z.string().optional().describe('Published IdSession string.'),
    sortOrder: z.number().int().optional().describe('Published passage sort order.'),
    startTime: z
      .string()
      .optional()
      .describe('Published passage start, retaining a source offset when supplied.'),
    endTime: z
      .string()
      .optional()
      .describe('Published passage end, retaining a source offset when supplied.'),
    languageOfText: z
      .string()
      .optional()
      .describe(
        'Original LanguageOfText label; absent means unknown, and compound labels remain intact.',
      ),
    voteId: z
      .string()
      .optional()
      .describe('Original VoteId string when the passage announces a vote.'),
    businessId: z
      .string()
      .optional()
      .describe(
        'Published VoteBusinessNumber; not an exhaustive passage-to-business relationship.',
      ),
    businessShortNumber: z.string().optional().describe('Original VoteBusinessShortNumber.'),
    textSizeBytes: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe(
        'Actual original Text UTF-8 byte length, including zero for an existing empty string.',
      ),
    text: z
      .string()
      .optional()
      .describe(
        'Whole original Bulletin Text, preserving HTML, line endings, and the speaker language.',
      ),
    references: z
      .array(BusinessTextReferenceSchema)
      .optional()
      .describe(
        'Link and image references from returned original Text; relative attributes remain unexpanded.',
      ),
  })
  .describe('One unshortened Bulletin passage or its metadata.');

/** Normalized passage with optional original text. */
export type Transcript = z.infer<typeof TranscriptSchema>;

/** Preserve published strings exactly and measure the same original text in both disclosure modes. */
export function normalizeTranscript(
  raw: RawTranscript,
  language: Language,
  includeText: boolean,
): Transcript {
  if (raw.Language !== language.toUpperCase())
    throw serializationError('Parliament returned a passage in a different metadata language.');
  const startTime = raw.StartTimeWithTimezone ?? raw.Start;
  const endTime = raw.EndTimeWithTimezone ?? raw.End;
  return {
    transcriptId: raw.ID,
    metadataLanguage: language,
    sourceUrl: `${odataEntityUrl('Transcript', odataInt64(raw.ID), language)}?$format=json`,
    ...(raw.IdSubject != null && { subjectId: raw.IdSubject }),
    ...(raw.PersonNumber != null && { personNumber: String(raw.PersonNumber) }),
    ...(raw.SpeakerFirstName != null && { speakerFirstName: raw.SpeakerFirstName }),
    ...(raw.SpeakerLastName != null && { speakerLastName: raw.SpeakerLastName }),
    ...(raw.SpeakerFullName != null && { speakerName: raw.SpeakerFullName }),
    ...(raw.SpeakerFunction != null && { speakerFunction: raw.SpeakerFunction }),
    ...(raw.Type != null && { type: raw.Type }),
    ...(raw.CouncilId != null && { councilId: String(raw.CouncilId) }),
    ...(raw.CouncilName != null && { councilName: raw.CouncilName }),
    ...(raw.MeetingCouncilAbbreviation != null && { council: raw.MeetingCouncilAbbreviation }),
    ...(raw.MeetingDate != null && { meetingDate: raw.MeetingDate }),
    ...(raw.IdSession != null && { sessionId: raw.IdSession }),
    ...(raw.SortOrder != null && { sortOrder: raw.SortOrder }),
    ...(startTime != null && { startTime }),
    ...(endTime != null && { endTime }),
    ...(raw.LanguageOfText != null && { languageOfText: raw.LanguageOfText }),
    ...(raw.VoteId != null && { voteId: raw.VoteId }),
    ...(raw.VoteBusinessNumber != null && { businessId: String(raw.VoteBusinessNumber) }),
    ...(raw.VoteBusinessShortNumber != null && {
      businessShortNumber: raw.VoteBusinessShortNumber,
    }),
    ...(raw.Text != null && {
      textSizeBytes: utf8ByteLength(raw.Text),
      ...(includeText && { text: raw.Text, references: businessTextReferences(raw.Text) }),
    }),
  };
}

/** Normalized filters echoed identically for exact lookup and scoped searches. */
export const TranscriptFiltersSchema = z
  .object({
    language: MetadataLanguageSchema.describe('Selected metadata language.'),
    businessId: z
      .string()
      .optional()
      .describe('Supplied business identifier resolved through all associated subjects.'),
    subjectId: z.string().optional().describe('Exact debate subject Int64 identifier.'),
    transcriptId: z
      .string()
      .optional()
      .describe('Exact passage Int64 identifier; incompatible with search filters and paging.'),
    personNumber: z.string().optional().describe('Exact speaker PersonNumber.'),
    sessionId: z.string().optional().describe('Exact source session string.'),
    council: z.enum(['N', 'S']).optional().describe('Normalized council abbreviation.'),
    dateFrom: z.string().optional().describe('Inclusive meeting-day lower bound.'),
    dateTo: z.string().optional().describe('Inclusive meeting-day upper bound.'),
    query: z
      .string()
      .optional()
      .describe('Original-text substring after caller whitespace normalization.'),
    includeText: z
      .boolean()
      .describe('Resolved original-text disclosure; exact default true, search default false.'),
    limit: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Effective page size for a search, absent for exact lookup.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Starting passage offset for a search, absent for exact lookup.'),
  })
  .describe('Effective passage filters, disclosure mode, and applicable paging defaults.');

/** Fully normalized passage request, shared by the tool and source service. */
export type TranscriptFilters = z.infer<typeof TranscriptFiltersSchema>;
