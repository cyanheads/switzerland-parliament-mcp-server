/**
 * @fileoverview HTML entity reference destinations while preserving original business text.
 * @module tests/services/parliament/business-text.test
 */

import { describe, expect, it } from 'vitest';
import { businessTextReferences } from '@/services/parliament/business-text.js';

describe('businessTextReferences', () => {
  it.each([
    ['https://example.test/&num;chapter', 'https://example.test/#chapter'],
    ['https://example.test/&#35;chapter', 'https://example.test/#chapter'],
    ['https://example.test/&#x1F600;', 'https://example.test/%F0%9F%98%80'],
    ['https://example.test/&#xD800;', 'https://example.test/%EF%BF%BD'],
    ['https://example.test/&#0;', 'https://example.test/%EF%BF%BD'],
    ['https://example.test/&#x110000;', 'https://example.test/%EF%BF%BD'],
  ])('decodes HTML attribute %s while retaining the literal source', (originalUrl, url) => {
    expect(businessTextReferences(`<a href="${originalUrl}">link</a>`)).toEqual([
      { kind: 'link', originalUrl, url },
    ]);
  });
});
