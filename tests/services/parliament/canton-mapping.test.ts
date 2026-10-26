/**
 * @fileoverview All published canton abbreviations use the Canton dictionary numbering.
 * @module tests/services/parliament/canton-mapping.test
 */

import { describe, expect, it } from 'vitest';
import { canonicalCantonId } from '@/services/parliament/canton-mapping.js';

describe('canonical canton mapping', () => {
  it.each([
    ['ZH', '1'],
    ['BE', '2'],
    ['LU', '3'],
    ['UR', '4'],
    ['SZ', '5'],
    ['OW', '6'],
    ['NW', '7'],
    ['GL', '8'],
    ['ZG', '9'],
    ['FR', '10'],
    ['SO', '11'],
    ['BS', '12'],
    ['BL', '13'],
    ['SH', '14'],
    ['AR', '15'],
    ['AI', '16'],
    ['SG', '17'],
    ['GR', '18'],
    ['AG', '19'],
    ['TG', '20'],
    ['VD', '22'],
    ['VS', '23'],
    ['NE', '24'],
    ['GE', '25'],
    ['JU', '26'],
    ['TI', '27'],
  ])('maps %s to published CantonNumber %s', (code, id) => {
    expect(canonicalCantonId(code)).toBe(id);
  });

  it.each([undefined, null, '', 'ZZ', 'vd', ' VD ', '__proto__', 'constructor'])(
    'leaves noncanonical abbreviation %s unknown',
    (code) => {
      expect(canonicalCantonId(code)).toBeUndefined();
    },
  );
});
