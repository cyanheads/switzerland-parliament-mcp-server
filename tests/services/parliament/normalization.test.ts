/**
 * @fileoverview Lossless scalar normalization and public identifier boundaries.
 * @module tests/services/parliament/normalization.test
 */

import { describe, expect, it } from 'vitest';
import {
  Int32IdSchema,
  Int64IdSchema,
  IsoDaySchema,
  LanguageSchema,
  normalizeMeetingDate,
  normalizeODataDate,
  ODataCountSchema,
  odataDay,
  odataInt32,
  odataInt64,
  odataString,
  optionalString,
} from '@/services/parliament/normalization.js';

describe('Parliament input and OData scalars', () => {
  it('normalizes only supported metadata languages and form-client blanks', () => {
    expect(LanguageSchema.parse(undefined)).toBe('de');
    expect(LanguageSchema.parse(' FR ')).toBe('fr');
    expect(LanguageSchema.parse(' ')).toBe('de');
    expect(LanguageSchema.safeParse('en').success).toBe(false);
    expect(optionalString(IsoDaySchema).parse(' ')).toBeUndefined();
    expect(optionalString(IsoDaySchema).parse(' 2024-02-29 ')).toBe('2024-02-29');
    expect(optionalString(IsoDaySchema).safeParse('2023-02-29').success).toBe(false);
  });

  it('retains exact signed integer ranges without Number round trips', () => {
    expect(odataInt32('2147483647')).toBe('2147483647');
    expect(odataInt64('9223372036854775807')).toBe('9223372036854775807L');
    for (const value of ['0', '-1', '01', '1.5', '2147483648', ' 1']) {
      expect(Int32IdSchema.safeParse(value).success, value).toBe(false);
    }
    expect(Int64IdSchema.safeParse('9223372036854775808').success).toBe(false);
    expect(Int64IdSchema.parse('9007199254740993')).toBe('9007199254740993');
    expect(ODataCountSchema.parse('0')).toBe(0);
    expect(ODataCountSchema.parse('9007199254740991')).toBe(Number.MAX_SAFE_INTEGER);
    for (const value of ['9007199254740992', '-1', '1.1', ' 2', 'NaN']) {
      expect(ODataCountSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('escapes query literals and uses inclusive calendar-day bounds', () => {
    expect(odataString("L'école d'été & O'Brien")).toBe("'L''école d''été & O''Brien'");
    expect(odataDay('2024-02-29')).toBe("datetime'2024-02-29T00:00:00'");
    expect(odataDay('2024-02-29', 'end')).toBe("datetime'2024-02-29T23:59:59.999'");
    expect(() => odataDay('2023-02-29')).toThrow();
  });

  it('preserves timezone absence and calendar meeting days', () => {
    expect(normalizeODataDate('/Date(0)/')).toBe('1970-01-01T00:00:00.000');
    expect(normalizeODataDate('/Date(-1)/')).toBe('1969-12-31T23:59:59.999');
    expect(normalizeMeetingDate(20240229)).toBe('2024-02-29');
  });

  it.each([
    ['/Date(0+0120)/', '1970-01-01T02:00:00.000+02:00'],
    ['/Date(0+0090)/', '1970-01-01T01:30:00.000+01:30'],
    ['/Date(0-0330)/', '1969-12-31T18:30:00.000-05:30'],
  ])('normalizes OData total-minute offset %s', (source, expected) => {
    expect(normalizeODataDate(source)).toBe(expected);
  });

  it.each([
    '/Date(0+2460)/',
    '/Date(9007199254740992)/',
    '/Date(8640000000000001)/',
    '2026-01-01',
    '/Date(no)/',
  ])('rejects malformed source date %s', (value) => {
    expect(() => normalizeODataDate(value)).toThrow();
  });

  it.each([20230229, 20241301, 123, 202401001])(
    'rejects malformed source meeting day %s',
    (value) => {
      expect(() => normalizeMeetingDate(value)).toThrow();
    },
  );
});
