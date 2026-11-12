import { describe, expect, it } from 'vitest';
import { findings, findReferences, reconcile } from '../src/reconcile.js';
import { invoices, payments } from './helpers.js';

const keyed = (...refs: string[]) => new Map(invoices(...refs.map((r) => `${r}:1`)).map((i) => [i.key, i]));
const refsIn = (text: string, ...refs: string[]) => findReferences(text, keyed(...refs)).map((i) => i.ref);

describe('findReferences', () => {
  it('finds references regardless of case and separators', () => {
    expect(refsIn('Payment inv 1001', 'INV-1001')).toEqual(['INV-1001']);
    expect(refsIn('INV1001', 'INV-1001')).toEqual(['INV-1001']);
    expect(refsIn('ref:inv-1001.', 'INV-1001')).toEqual(['INV-1001']);
  });
  it('does not match a reference inside a longer one', () => {
    expect(refsIn('INV-12', 'INV-1')).toEqual([]);
    expect(refsIn('INV-1 and INV-12', 'INV-1', 'INV-12')).toEqual(['INV-1', 'INV-12']);
  });
  it('keeps order of appearance without repeats', () => {
    expect(refsIn('B/A/B', 'A1', 'B1').length).toBe(0);
    expect(refsIn('B1/A1, b1', 'A1', 'B1')).toEqual(['B1', 'A1']);
  });
  it('prefers a joined pair over a single word', () => {
    expect(refsIn('INV 12', 'INV12', '12')).toEqual(['INV12']);
    expect(refsIn('order 12', 'INV12', '12')).toEqual(['12']);
  });
});

describe('reconcile', () => {
  it('pays an invoice exactly by reference', () => {
    const rec = reconcile(invoices('INV-1:100'), payments(['2026-11-01', '100', 'inv1']));
    expect(rec.invoices[0]).toMatchObject({ status: 'paid', receivedCents: 10000, differenceCents: 0, method: 'reference', paymentRows: [2] });
    expect(rec.payments[0]).toMatchObject({ status: 'matched', method: 'reference', invoices: ['INV-1'], excessCents: 0, possibleDuplicate: false });
    expect(findings(rec)).toEqual([]);
  });

  it('sums several partial payments in date order', () => {
    const rec = reconcile(invoices('A:100'), payments(['2026-11-03', '60', 'A'], ['2026-11-01', '30', 'A']));
    expect(rec.invoices[0]).toMatchObject({ status: 'partial', receivedCents: 9000, differenceCents: -1000, paymentRows: [3, 2] });
    expect(rec.payments.map((p) => p.row)).toEqual([3, 2]);
    expect(rec.totals.outstandingCents).toBe(1000);
    expect(findings(rec)).toEqual(['1 partly paid invoice(s)']);
  });

  it('orders same-day payments by time, also with one-digit hours', () => {
    const rec = reconcile(invoices('A:100'), payments(['12/11/2026 10:15', '100', 'A'], ['12/11/2026 9:05', '100', 'A']));
    expect(rec.payments.map((p) => [p.row, p.possibleDuplicate])).toEqual([[3, false], [2, true]]);
  });

  it('splits one payment over several named invoices, extra to the last', () => {
    const rec = reconcile(invoices('A:100', 'B:50'), payments(['2026-11-01', '170', 'A B']));
    expect(rec.invoices.map((i) => [i.status, i.receivedCents])).toEqual([['paid', 10000], ['overpaid', 7000]]);
    expect(rec.payments[0]).toMatchObject({ invoices: ['A', 'B'], excessCents: 2000 });
    expect(rec.totals.overpaidCents).toBe(2000);
  });

  it('a short payment for several invoices fills them in the order named', () => {
    const rec = reconcile(invoices('A:100', 'B:50'), payments(['2026-11-01', '120', 'B, A']));
    expect(rec.invoices.map((i) => [i.ref, i.status, i.receivedCents])).toEqual([['A', 'partial', 7000], ['B', 'paid', 5000]]);
  });

  it('extra money skips invoices that were already paid', () => {
    const rec = reconcile(invoices('A:100', 'B:50'), payments(['2026-11-01', '100', 'A'], ['2026-11-02', '80', 'B A']));
    expect(rec.invoices.map((i) => i.receivedCents)).toEqual([10000, 8000]);
    expect(rec.payments[1]).toMatchObject({ excessCents: 3000, possibleDuplicate: false });
  });

  it('flags a second payment for an invoice already paid as a possible duplicate', () => {
    const rec = reconcile(invoices('A:100'), payments(['2026-11-01', '100', 'A'], ['2026-11-02', '100', 'A again']));
    expect(rec.invoices[0]).toMatchObject({ status: 'overpaid', differenceCents: 10000, paymentRows: [2, 3] });
    expect(rec.payments[1]).toMatchObject({ possibleDuplicate: true, excessCents: 10000 });
    expect(findings(rec)).toEqual(['1 overpaid invoice(s)', '1 possible duplicate payment(s)']);
  });

  it('matches by amount only when the pairing is unique both ways', () => {
    const rec = reconcile(invoices('A:100', 'B:55.50', 'C:55.50', 'D:20'), payments(
      ['2026-11-01', '100', 'no ref'],
      ['2026-11-01', '55.50', 'x'],
      ['2026-11-01', '20', 'y'],
      ['2026-11-02', '20', 'z'],
      ['2026-11-02', '7', 'nothing'],
    ));
    expect(rec.payments.map((p) => [p.status, p.method ?? '', p.invoices.join(), (p.candidates ?? []).join()])).toEqual([
      ['matched', 'amount', 'A', ''],
      ['ambiguous', '', '', 'B,C'],
      ['ambiguous', '', '', 'D'],
      ['ambiguous', '', '', 'D'],
      ['unmatched', '', '', ''],
    ]);
    expect(rec.invoices[0]).toMatchObject({ status: 'paid', method: 'amount' });
    expect(rec.counts).toMatchObject({ amountMatches: 1, ambiguousPayments: 3, unmatchedPayments: 1, unpaid: 3, paid: 1 });
    expect(rec.totals).toMatchObject({ allocatedCents: 10000, unmatchedCents: 10250 });
  });

  it('does not amount-match an invoice that already has money from a reference', () => {
    const rec = reconcile(invoices('A:100'), payments(['2026-11-01', '40', 'A'], ['2026-11-02', '100', 'other']));
    expect(rec.payments[1].status).toBe('unmatched');
  });

  it('can turn amount matching off', () => {
    const rec = reconcile(invoices('A:100'), payments(['2026-11-01', '100', 'no ref']), { amountMatch: false });
    expect(rec.payments[0].status).toBe('unmatched');
    expect(rec.invoices[0].status).toBe('unpaid');
  });

  it('keeps totals consistent', () => {
    const rec = reconcile(invoices('A:10', 'B:20', 'C:30'), payments(['2026-11-01', '15', 'A'], ['2026-11-01', '5', 'B'], ['2026-11-01', '1', '?']));
    const t = rec.totals;
    expect(t.receivedCents).toBe(t.allocatedCents + t.unmatchedCents);
    expect(t.invoicedCents - t.outstandingCents + t.overpaidCents).toBe(t.allocatedCents);
  });
});
