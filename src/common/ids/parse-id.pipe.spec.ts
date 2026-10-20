import { BadRequestException } from '@nestjs/common';
import { MAX_ENTITY_ID } from './numeric-id';
import { ParseIdPipe } from './parse-id.pipe';

describe('Numeric entity IDs', () => {
  const pipe = new ParseIdPipe();

  it.each([1, MAX_ENTITY_ID])('accepts integer boundary %i as a number', (id) => {
    expect(pipe.transform(String(id))).toBe(id);
  });

  it.each([
    '',
    '0',
    '-1',
    '1.5',
    '1e2',
    '+1',
    '01',
    ' 1',
    '1 ',
    'NaN',
    '2147483648',
    '99999999999999999999',
  ])('rejects non-canonical or out-of-range ID %j before reaching PostgreSQL', (id) => {
    expect(() => pipe.transform(id)).toThrow(BadRequestException);
  });
});
