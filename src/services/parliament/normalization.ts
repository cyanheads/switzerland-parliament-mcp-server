/**
 * @fileoverview Parliament input primitives and lossless OData scalar normalization.
 * @module services/parliament/normalization
 */

import { z } from '@cyanheads/mcp-ts-core';
import { serializationError } from '@cyanheads/mcp-ts-core/errors';

/** Metadata language; input casing is normalized without selecting a fallback language. */
export const LanguageSchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() || undefined : value),
  z.enum(['de', 'fr', 'it']).default('de'),
);

/** Supported metadata language, distinct from the language of published debate text. */
export type Language = z.infer<typeof LanguageSchema>;

/** Form-client blank strings are unset before the wrapped validator runs. */
export function optionalString<T extends z.ZodType<string>>(schema: T) {
  return z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() || undefined : value),
    schema.optional(),
  );
}

/** Calendar-valid ISO day; no timezone is inferred for a calendar date. */
export const IsoDaySchema = z.iso.date();

/** Positive signed Int32 identifier, retained as a decimal string. */
export const Int32IdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, { abort: true })
  .refine((value) => BigInt(value) <= 2_147_483_647n, 'Identifier exceeds the signed Int32 range.');

/** Positive signed Int64 identifier; never converted through JavaScript Number. */
export const Int64IdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, { abort: true })
  .refine(
    (value) => BigInt(value) <= 9_223_372_036_854_775_807n,
    'Identifier exceeds the signed Int64 range.',
  );

/** Escape a normalized string for an OData string literal, before URL encoding. */
export function odataString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Validate an Int32 identifier before making a numeric OData literal. */
export function odataInt32(value: string): string {
  return Int32IdSchema.parse(value);
}

/** Validate an Int64 identifier and append the OData v2 Int64 suffix. */
export function odataInt64(value: string): string {
  return `${Int64IdSchema.parse(value)}L`;
}

/** Validate a day before making a timezone-free OData DateTime literal. */
export function odataDay(value: string, bound: 'start' | 'end' = 'start'): string {
  return `datetime'${IsoDaySchema.parse(value)}T${bound === 'start' ? '00:00:00' : '23:59:59.999'}'`;
}

/** Normalize a validated OData v2 wrapper, retaining an explicit offset when supplied. */
export function normalizeODataDate(value: string): string {
  const match = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/.exec(value);
  if (!match) throw serializationError('Parliament returned an invalid OData date.');
  const milliseconds = Number(match[1]);
  if (!Number.isSafeInteger(milliseconds)) {
    throw serializationError('Parliament returned an out-of-range OData date.');
  }
  const offset = match[2];
  if (!offset) {
    const date = new Date(milliseconds);
    if (Number.isNaN(date.getTime()))
      throw serializationError('Parliament returned an invalid date.');
    // Edm.DateTime has no timezone; UTC arithmetic decodes its components only.
    return date.toISOString().replace(/Z$/, '');
  }
  // OData v2 encodes total offset minutes, so +0120 means +02:00, not +01:20.
  const offsetMinutes = Number(offset.slice(1));
  if (offsetMinutes > 23 * 60 + 59)
    throw serializationError('Parliament returned an invalid date offset.');
  const hours = String(Math.floor(offsetMinutes / 60)).padStart(2, '0');
  const minutes = String(offsetMinutes % 60).padStart(2, '0');
  const offsetMs = offsetMinutes * 60_000 * (offset[0] === '-' ? -1 : 1);
  const date = new Date(milliseconds + offsetMs);
  if (Number.isNaN(date.getTime()))
    throw serializationError('Parliament returned an invalid date.');
  return `${date.toISOString().replace(/Z$/, '')}${offset[0]}${hours}:${minutes}`;
}

/** OData DateTime schema normalizes at the network edge, without an invented timezone. */
export const ODataDateSchema = z.string().transform(normalizeODataDate);

/** Parse the upstream decimal count only when it can be represented exactly. */
export const ODataCountSchema = z
  .string()
  .regex(/^\d+$/)
  .pipe(
    z
      .string()
      .refine(
        (value) => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER),
        'OData count exceeds the safe integer range.',
      ),
  )
  .transform(Number);

/** YYYYMMDD calendar dates published by MeetingDate. */
export function normalizeMeetingDate(value: string | number): string {
  const digits = String(value);
  const result = IsoDaySchema.safeParse(
    `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6)}`,
  );
  if (!/^\d{8}$/.test(digits) || !result.success) {
    throw serializationError('Parliament returned an invalid meeting date.');
  }
  return result.data;
}
