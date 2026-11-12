import { describe, expect, it } from 'vitest';
import { addAging, ageBucket, AGE_BUCKETS, daysPastDue, latestPaymentDate } from '../src/aging.js';
import { parseInvoices } from '../src/input.js';
import { reconcile } from '../src/reconcile.js';
import { payments } from './helpers.js';

const invoices = parseInvoices([
  'ref,amount,due_date',
  'A,100,2026-12-02', // not yet due
  'B,100,2026-11-01', // 30 days
  'C,100,2026-10-31', // 31 days
  'D,100,2026-09-01', // 91 days
  'E,100,', // no due date
  'F,100,2026-01-01', // paid, not aged
  'G,100,2026-10-02', // partly paid, 60 days
].join('\n'));

describe('aging', () => {
  it('counts whole days, across months and leap years', () => {
    expect(daysPastDue('2026-11-12', '2026-11-12')).toBe(0);
    expect(daysPastDue('2026-11-13', '2026-11-12')).toBe(-1);
    expect(daysPastDue('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysPastDue('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('puts days into buckets at the edges', () => {
    expect([undefined, -5, 0, 1, 30, 31, 60, 61, 90, 91].map(ageBucket)).toEqual([
      'no due date', 'not yet due', 'not yet due', '1-30 days', '1-30 days', '31-60 days', '31-60 days', '61-90 days', '61-90 days', 'over 90 days',
    ]);
  });

  it('ages only what is still owed and keeps the totals equal', () => {
    const pays = payments(['2026-11-20', '100', 'F'], ['2026-11-25', '40', 'G']);
    const rec = addAging(reconcile(invoices, pays), '2026-12-01', 'option');
    expect(rec.aging!.asOf).toBe('2026-12-01');
    expect(rec.aging!.rows.map((r) => r.bucket)).toEqual(AGE_BUCKETS);
    const by = Object.fromEntries(rec.aging!.rows.map((r) => [r.bucket, [r.invoices, r.outstandingCents]]));
    expect(by).toEqual({
      'not yet due': [1, 10000],
      '1-30 days': [1, 10000],
      '31-60 days': [2, 16000],
      '61-90 days': [0, 0],
      'over 90 days': [1, 10000],
      'no due date': [1, 10000],
    });
    expect(rec.aging!.rows.reduce((a, r) => a + r.outstandingCents, 0)).toBe(rec.totals.outstandingCents);
    const days = Object.fromEntries(rec.invoices.map((i) => [i.ref, i.daysOverdue]));
    expect(days).toEqual({ A: -1, B: 30, C: 31, D: 91, E: undefined, F: undefined, G: 60 });
  });

  it('does not change the input reconciliation', () => {
    const rec = reconcile(invoices, payments(['2026-11-20', '100', 'F']));
    const aged = addAging(rec, '2026-12-01', 'option');
    expect(rec.aging).toBeUndefined();
    expect(rec.invoices.every((i) => i.daysOverdue === undefined)).toBe(true);
    expect(aged.invoices[0].daysOverdue).toBe(-1);
  });

  it('finds the latest payment date', () => {
    expect(latestPaymentDate(reconcile(invoices, payments(['2026-11-20', '1', 'x'], ['2026-11-03', '1', 'y'])))).toBe('2026-11-20');
    expect(latestPaymentDate(reconcile(invoices, []))).toBeUndefined();
  });
});
