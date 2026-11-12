import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { parseInvoices } from '../src/input.js';
import { findings, reconcile } from '../src/reconcile.js';
import { jsonReport, textReport } from '../src/report.js';
import { payments } from './helpers.js';

const due = (...rows: string[]) => parseInvoices(['ref,amount,due_date', ...rows].join('\n'));

describe('amount window', () => {
  it('without a window behaves as before: two invoices with the same amount stay ambiguous', () => {
    const rec = reconcile(due('A,100,2026-01-05', 'B,100,2026-11-05'), payments(['2026-11-06', '100', 'no ref']));
    expect(rec.payments[0]).toMatchObject({ status: 'ambiguous', candidates: ['A', 'B'] });
    expect(rec.amountWindowDays).toBeUndefined();
  });

  it('with a window picks the only same-amount invoice due near the payment date', () => {
    const rec = reconcile(due('A,100,2026-01-05', 'B,100,2026-11-05'), payments(['2026-11-06', '100', 'no ref']), { amountWindowDays: 14 });
    expect(rec.payments[0]).toMatchObject({ status: 'matched', method: 'amount', invoices: ['B'] });
    expect(rec.invoices.map((i) => i.status)).toEqual(['unpaid', 'paid']);
    expect(rec.amountWindowDays).toBe(14);
    expect(findings(rec)).toContain('1 payment(s) matched by amount only (check them)');
  });

  it('counts the window on both sides of the due date, edges included', () => {
    const inv = () => due('A,100,2026-11-10');
    expect(reconcile(inv(), payments(['2026-11-03', '100', 'x']), { amountWindowDays: 7 }).payments[0].status).toBe('matched');
    expect(reconcile(inv(), payments(['2026-11-17', '100', 'x']), { amountWindowDays: 7 }).payments[0].status).toBe('matched');
    expect(reconcile(inv(), payments(['2026-11-18', '100', 'x']), { amountWindowDays: 7 }).payments[0].status).toBe('unmatched');
    expect(reconcile(inv(), payments(['2026-11-10', '100', 'x']), { amountWindowDays: 0 }).payments[0].status).toBe('matched');
    expect(reconcile(inv(), payments(['2026-11-11', '100', 'x']), { amountWindowDays: 0 }).payments[0].status).toBe('unmatched');
  });

  it('never matches an invoice without a due date by amount when a window is set', () => {
    const rec = reconcile(due('A,100,'), payments(['2026-11-03', '100', 'x']), { amountWindowDays: 3650 });
    expect(rec.payments[0].status).toBe('unmatched');
    expect(rec.invoices[0].status).toBe('unpaid');
  });

  it('pairs two same-amount payments with two invoices when each window holds exactly one', () => {
    const rec = reconcile(due('Oct,250,2026-10-07', 'Nov,250,2026-11-07'), payments(['2026-10-08', '250', 'rent'], ['2026-11-08', '250', 'rent']), { amountWindowDays: 10 });
    expect(rec.payments.map((p) => p.invoices)).toEqual([['Oct'], ['Nov']]);
    expect(rec.counts).toMatchObject({ paid: 2, amountMatches: 2, ambiguousPayments: 0 });
    // Without the window the same input is ambiguous.
    expect(reconcile(due('Oct,250,2026-10-07', 'Nov,250,2026-11-07'), payments(['2026-10-08', '250', 'rent'], ['2026-11-08', '250', 'rent'])).counts.ambiguousPayments).toBe(2);
  });

  it('stays ambiguous when two payments reach the same invoice inside the window', () => {
    const rec = reconcile(due('A,100,2026-11-10'), payments(['2026-11-09', '100', 'x'], ['2026-11-11', '100', 'y']), { amountWindowDays: 5 });
    expect(rec.payments.map((p) => p.status)).toEqual(['ambiguous', 'ambiguous']);
    expect(rec.invoices[0].status).toBe('unpaid');
  });

  it('lists ambiguous candidates in invoice-file order, whatever their due dates', () => {
    const rec = reconcile(due('B,100,2026-11-10', 'Z9,100,2026-12-30', 'A,100,2026-11-08', 'N,100,'), payments(['2026-11-09', '100', 'x']), { amountWindowDays: 2 });
    expect(rec.payments[0]).toMatchObject({ status: 'ambiguous', candidates: ['B', 'A'] });
  });

  it('handles thousands of same-amount invoices quickly', () => {
    const rows: string[] = [];
    const pays: [string, string, string][] = [];
    for (let i = 0; i < 3000; i++) {
      const d = new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
      rows.push(`R${i},250,${d}`);
      pays.push([d, '250', 'rent']);
    }
    const t = Date.now();
    const rec = reconcile(due(...rows), payments(...pays), { amountWindowDays: 0 });
    expect(rec.counts).toMatchObject({ paid: 3000, amountMatches: 3000 });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('does not touch reference matches', () => {
    const rec = reconcile(due('A,100,2020-01-01'), payments(['2026-11-09', '100', 'A']), { amountWindowDays: 1 });
    expect(rec.payments[0]).toMatchObject({ status: 'matched', method: 'reference' });
  });

  it('rejects a negative or fractional window', () => {
    expect(() => reconcile(due('A,1,'), [], { amountWindowDays: -1 })).toThrow(RangeError);
    expect(() => reconcile(due('A,1,'), [], { amountWindowDays: 1.5 })).toThrow(RangeError);
  });

  it('names the window in text and JSON reports', () => {
    const rec = reconcile(due('A,100,2026-11-05'), payments(['2026-11-06', '100', 'x']), { amountWindowDays: 3 });
    expect(textReport(rec)).toContain('Amount-only matching limited to invoices due within 3 day(s) of the payment date.');
    expect(JSON.parse(jsonReport(rec)).amountWindowDays).toBe(3);
    expect(JSON.parse(jsonReport(reconcile(due('A,100,'), []))).amountWindowDays).toBeUndefined();
  });
});

describe('cli --amount-window', () => {
  let out = '';
  let err = '';
  beforeEach(() => {
    out = '';
    err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((c) => ((out += String(c)), true));
    vi.spyOn(process.stderr, 'write').mockImplementation((c) => ((err += String(c)), true));
  });
  afterEach(() => vi.restoreAllMocks());
  const tmp = (name: string, text: string) => {
    const path = join(mkdtempSync(join(tmpdir(), 'recon-window-')), name);
    writeFileSync(path, text);
    return path;
  };
  const inv = () => tmp('inv.csv', 'ref,amount,due_date\nA,100,2026-01-05\nB,100,2026-11-05\n');
  const pay = () => tmp('pay.csv', 'date,amount,reference\n2026-11-06,100,no ref\n');

  it('matches inside the window and reports it', () => {
    expect(main([inv(), pay(), '--amount-window', '14', '--json'])).toBe(1);
    const j = JSON.parse(out);
    expect(j.amountWindowDays).toBe(14);
    expect(j.payments[0]).toMatchObject({ status: 'matched', method: 'amount', invoices: ['B'] });
  });

  it('rejects bad values and combinations with exit 2', () => {
    expect(main([inv(), pay(), '--amount-window', '-3'])).toBe(2);
    expect(main([inv(), pay(), '--amount-window', '1.5'])).toBe(2);
    expect(main([inv(), pay(), '--amount-window', 'abc'])).toBe(2);
    expect(err).toContain('whole number of days');
    err = '';
    expect(main([inv(), pay(), '--amount-window', '3', '--no-amount-match'])).toBe(2);
    expect(err).toContain('not both');
    err = '';
    expect(main([tmp('i.csv', 'ref,amount\nA,100\n'), pay(), '--amount-window', '3'])).toBe(2);
    expect(err).toContain('needs invoice due dates');
  });
});
