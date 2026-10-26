/**
 * @fileoverview Typed reference topics, fields, and effective filters.
 * @module services/parliament/reference-model
 */

import { z } from '@cyanheads/mcp-ts-core';
import { IsoDaySchema, MetadataLanguageSchema } from './normalization.js';

/** Published reference dictionaries and server explanations available for paging. */
export const ReferenceTopicSchema = z.enum([
  'identifiers',
  'coverage',
  'languages',
  'business_types',
  'statuses',
  'councils',
  'cantons',
  'parties',
  'groups',
  'committees',
  'sessions',
]);

/** Reference topic discriminator. */
export type ReferenceTopic = z.infer<typeof ReferenceTopicSchema>;

/** A documented reference entry; missing source labels remain unknown. */
export const ReferenceItemSchema = z
  .object({
    id: z
      .string()
      .describe('Source dictionary key, or stable identifier for a server explanation.'),
    label: z
      .string()
      .optional()
      .describe(
        'Original source label in the requested language; omitted when unpublished. Static facts use server explanations.',
      ),
    abbreviation: z
      .string()
      .optional()
      .describe('Published abbreviation, including an existing empty string.'),
    code: z
      .string()
      .optional()
      .describe('Published status or parliamentary-group code when available.'),
    description: z
      .string()
      .optional()
      .describe('Source description, session number and type, or explicit server explanation.'),
    startDate: z
      .string()
      .optional()
      .describe(
        'Published start date normalized from OData DateTime without an invented timezone.',
      ),
    endDate: z
      .string()
      .optional()
      .describe('Published end date normalized from OData DateTime without an invented timezone.'),
    active: z.boolean().optional().describe('Published active flag; absent does not imply false.'),
    councilId: z
      .string()
      .optional()
      .describe('Published numeric council key, resolved with topic councils.'),
    legislativePeriod: z
      .number()
      .int()
      .optional()
      .describe('Published legislative period number for a session.'),
    era: z
      .enum(['legacy', 'current'])
      .optional()
      .describe('Status vocabulary before or from 1 July 2023.'),
  })
  .describe('One source reference record or explicitly identified server explanation.');

/** Normalized reference item shared by static and live lists. */
export type ReferenceItem = z.infer<typeof ReferenceItemSchema>;

/** Effective defaults and filters echoed on every reference success branch. */
export const ReferenceFiltersSchema = z
  .object({
    topic: ReferenceTopicSchema.describe('Requested reference topic.'),
    language: MetadataLanguageSchema.describe('Requested metadata label language.'),
    dateFrom: IsoDaySchema.optional().describe(
      'Inclusive session StartDate lower bound, if supplied.',
    ),
    dateTo: IsoDaySchema.optional().describe('Inclusive session EndDate upper bound, if supplied.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(100)
      .describe('Effective maximum entries requested from the source, capped at 100.'),
    offset: z
      .number()
      .int()
      .nonnegative()
      .describe('Requested starting row, before any whole-item response-size fitting.'),
  })
  .describe('Normalized reference filters and resolved paging defaults.');

/** Service input after schema validation and per-tool limit clamping. */
export type ReferenceFilters = z.infer<typeof ReferenceFiltersSchema>;
