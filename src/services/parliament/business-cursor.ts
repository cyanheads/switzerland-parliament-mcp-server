/**
 * @fileoverview Versioned, filter-bound business keyset cursors containing validated data only.
 * @module services/parliament/business-cursor
 */

import { createHash } from 'node:crypto';
import { z } from '@cyanheads/mcp-ts-core';
import { validationError } from '@cyanheads/mcp-ts-core/errors';
import type { BusinessSearchFilters } from './business-model.js';
import { Int32IdSchema, MetadataLanguageSchema } from './normalization.js';

const CursorSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    language: MetadataLanguageSchema,
    order: z.literal('business_id_desc'),
    route: z.enum(['business', 'committee']),
    lastBusinessId: Int32IdSchema,
  })
  .strict();

function context(filters: BusinessSearchFilters) {
  const {
    language,
    query,
    author,
    typeId,
    statusId,
    sessionId,
    committeeId,
    submittedFrom,
    submittedTo,
  } = filters;
  return {
    fingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          language,
          query,
          author,
          typeId,
          statusId,
          sessionId,
          committeeId,
          submittedFrom,
          submittedTo,
        }),
      )
      .digest('hex'),
    language,
    route: committeeId ? ('committee' as const) : ('business' as const),
    order: 'business_id_desc' as const,
  };
}

/** Decode all cursor fields and reject altered filters before any upstream request. */
export function readBusinessCursor(filters: BusinessSearchFilters): string | undefined {
  if (filters.cursor === undefined) return undefined;
  let value: unknown;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(filters.cursor)) throw new Error('Invalid base64url.');
    const decoded = Buffer.from(filters.cursor, 'base64url');
    if (decoded.toString('base64url') !== filters.cursor)
      throw new Error('Noncanonical base64url.');
    value = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw validationError('The business cursor is malformed.', { reason: 'invalid_cursor' });
  }
  const parsed = CursorSchema.safeParse(value);
  const expected = context(filters);
  if (
    !parsed.success ||
    parsed.data.fingerprint !== expected.fingerprint ||
    parsed.data.language !== expected.language ||
    parsed.data.order !== expected.order ||
    parsed.data.route !== expected.route
  ) {
    throw validationError('The business cursor is unsupported or belongs to different filters.', {
      reason: 'invalid_cursor',
    });
  }
  return parsed.data.lastBusinessId;
}

/** Continue after the smallest business ID actually delivered, independent of role duplicates. */
export function createBusinessCursor(
  filters: BusinessSearchFilters,
  lastBusinessId: string,
): string {
  const value = CursorSchema.parse({ version: 1, ...context(filters), lastBusinessId });
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
