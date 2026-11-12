import { describe, expect, it } from 'vitest';
import { formatCents, parseCents, plainCents } from '../src/money.js';

describe('parseCents', () => {
  it.each([
    ['1234.50', 123450], ['1,234.5', 123450], ['RM 1,234.50', 123450], ['MYR12', 1200], ['rm0.05', 5],
    ['-10.00', -1000], ['RM -10', -1000], ['-RM 10', -1000], ['(25.10)', -2510], ['  7 ', 700], ['0', 0],
    ['1,000,000.01', 100000001],
  ])('%s -> %i', (text, cents) => expect(parseCents(text, 'x')).toBe(cents));

  it.each(['', 'abc', '1.234', '12,34', '1,2345.00', '1.2.3', 'RM', '10 RM', '1e3'])('rejects %j', (text) => {
    expect(() => parseCents(text, 'file row 2')).toThrow(/file row 2: .* is not an amount/);
  });

  it('never uses floating point (0.1 + 0.2 style values stay exact)', () => {
    expect(parseCents('0.10', 'x') + parseCents('0.20', 'x')).toBe(30);
    expect(parseCents('19.99', 'x')).toBe(1999);
  });
});

describe('formatting', () => {
  it('formats with separators and sign', () => {
    expect(formatCents(123450)).toBe('1,234.50');
    expect(formatCents(-5)).toBe('-0.05');
    expect(formatCents(100000000)).toBe('1,000,000.00');
    expect(plainCents(123450)).toBe('1234.50');
    expect(plainCents(-1999)).toBe('-19.99');
  });
});
