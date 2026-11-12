import { describe, expect, it } from 'vitest';
import { mergePayments, parsePayments } from '../src/input.js';
import { reconcile } from '../src/reconcile.js';
import { invoices } from './helpers.js';

const parse = (text: string, file: string) => parsePayments(text, file);

describe('mergePayments', () => {
  it('leaves a single file as it is (no labels)', () => {
    const m = mergePayments([{ label: 'a.csv', parse: parse('date,amount,reference,id\n2026-11-01,10,A1,T1\n2026-11-02,5,x,\n', 'a.csv') }]);
    expect(m.payments.map((p) => p.source)).toEqual([undefined, undefined]);
    expect(m.overlaps).toEqual([]);
    expect(m.withoutId).toBe(1);
  });

  it('drops rows whose transaction id, date and amount are already in an earlier file', () => {
    const a = parse('date,amount,reference,id\n2026-11-01,10,A1,T1\n2026-11-02,-1,fee,T2\n2026-11-03,5,B1,T3\n', 'a.csv');
    const b = parse('date,amount,reference,id\n2026-11-03,5,B-1 (copy),T3\n2026-11-04,7,C1,T4\n2026-11-04,2,no id,\n', 'b.csv');
    const m = mergePayments([{ label: 'a.csv', parse: a }, { label: 'b.csv', parse: b }]);
    expect(m.payments.map((p) => `${p.source}:${p.row}`)).toEqual(['a.csv:2', 'a.csv:4', 'b.csv:3', 'b.csv:4']);
    expect(m.overlaps).toEqual([{ source: 'b.csv', row: 2, id: 'T3', keptSource: 'a.csv', keptRow: 4 }]);
    expect(m.skipped).toEqual([{ row: 3, amountCents: -100, source: 'a.csv' }]);
    expect(m.withoutId).toBe(1);
  });

  it('rejects a transaction id that comes back with a different amount or date', () => {
    const a = parse('date,amount,reference,id\n2026-11-01,10,A1,T1\n', 'a.csv');
    const amount = parse('date,amount,reference,id\n2026-11-01,10.01,A1,T1\n', 'b.csv');
    const date = parse('date,amount,reference,id\n2026-11-02,10,A1,T1\n', 'c.csv');
    expect(() => mergePayments([{ label: 'a.csv', parse: a }, { label: 'b.csv', parse: amount }])).toThrow(/b\.csv row 2: transaction id "T1" is also on a\.csv row 2 with a different date or amount/);
    expect(() => mergePayments([{ label: 'a.csv', parse: a }, { label: 'c.csv', parse: date }])).toThrow(/different date or amount/);
  });

  it('keeps equal rows without ids from both files (they cannot be told apart)', () => {
    const text = 'date,amount,reference\n2026-11-01,10,A1\n';
    const m = mergePayments([{ label: 'a.csv', parse: parse(text, 'a.csv') }, { label: 'b.csv', parse: parse(text, 'b.csv') }]);
    expect(m.payments).toHaveLength(2);
    expect(m.withoutId).toBe(2);
    const rec = reconcile(invoices('A1:10'), m.payments);
    expect(rec.invoices[0]).toMatchObject({ status: 'overpaid', paymentRows: ['a.csv:2', 'b.csv:2'] });
    expect(rec.payments[1]).toMatchObject({ source: 'b.csv', row: 2, possibleDuplicate: true });
  });

  it('orders same-time payments by file, then row', () => {
    const a = parse('date,amount,reference,id\n2026-11-01,6,A1,T1\n', 'a.csv');
    const b = parse('date,amount,reference,id\n2026-11-01,6,A1,T2\n', 'b.csv');
    const rec = reconcile(invoices('A1:10'), mergePayments([{ label: 'b.csv', parse: b }, { label: 'a.csv', parse: a }]).payments);
    expect(rec.payments.map((p) => p.source)).toEqual(['b.csv', 'a.csv']);
    expect(rec.payments[1].excessCents).toBe(200);
  });
});
