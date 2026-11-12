import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { root } from './helpers.js';

const inv = join(root, 'examples', 'invoices.csv');
const pay = join(root, 'examples', 'payments.csv');
let out = '';
let err = '';

beforeEach(() => {
  out = '';
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err += String(chunk);
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

const tmp = (name: string, text: string) => {
  const path = join(mkdtempSync(join(tmpdir(), 'recon-cli-')), name);
  writeFileSync(path, text);
  return path;
};

describe('cli', () => {
  it('reports the example (exit 1)', () => {
    expect(main([inv, pay])).toBe(1);
    expect(out).toContain('Invoices: 8 (3 paid, 1 partial, 1 overpaid, 3 unpaid)');
    expect(out).toContain('Payments: 7 (5 matched, 1 ambiguous, 1 unmatched); 1 debit/zero row(s) left out');
    expect(out).toContain('Invoiced 5,205.40, received 4,587.40, outstanding 2,060.00, overpaid 1,250.00, not matched 192.00');
    expect(out).toMatch(/INV-1003 +2,000.00 +1,000.00 +partial +short 1,000.00/);
    expect(out).toMatch(/INV-1005 +99.90 +99.90 +paid +by amount only/);
    expect(out).toMatch(/5 +2026-11-09 11:00 +1,250.00 +Payment inv 1001 +-> INV-1001 \(possible duplicate: already paid\)/);
    expect(out).toMatch(/8 +2026-11-11 12:00 +150.00 +yuran november +same amount as INV-1007, INV-1008/);
    expect(out).toMatch(/9 +2026-11-12 09:45 +42.00 +DuitNow transfer +no invoice found/);
    expect(out).toContain('Findings: 3 unpaid invoice(s), 1 partly paid invoice(s), 1 overpaid invoice(s), 1 possible duplicate payment(s), 1 ambiguous payment(s), 1 unmatched payment(s), 1 payment(s) matched by amount only (check them)');
    expect(out).not.toContain('INV-1002 ');
  });

  it('writes JSON with plain decimal amounts', () => {
    expect(main([inv, pay, '--json'])).toBe(1);
    const data = JSON.parse(out);
    expect(data.totals).toEqual({ invoiced: '5205.40', received: '4587.40', allocated: '4395.40', unmatched: '192.00', outstanding: '2060.00', overpaid: '1250.00' });
    expect(data.invoices.find((i: { ref: string }) => i.ref === 'INV-1002')).toMatchObject({ status: 'paid', amount: '480.50', received: '480.50', paymentRows: [3], customer: 'Syarikat Maju', dueDate: '2026-11-07' });
    expect(data.skippedRows).toEqual([{ row: 7, amount: '-0.50' }]);
    expect(data.payments).toHaveLength(7);
    expect(data.findings).toHaveLength(7);
  });

  it('writes Markdown and CSV', () => {
    expect(main([inv, pay, '--md'])).toBe(1);
    expect(out).toContain('| INV-1004 | 315.00 | 315.00 | paid |  |');
    expect(out).toContain('| 3 | 2026-11-06 09:02 | 795.50 | INV1002 / INV-1004 | -> INV-1002, INV-1004 |');
    out = '';
    expect(main([inv, pay, '--csv'])).toBe(1);
    const lines = out.trim().split('\n');
    expect(lines[0]).toBe('ref,customer,due_date,amount,received,difference,status,method,payment_rows,days_overdue');
    expect(lines[1]).toBe('INV-1001,Kedai Runcit Ali,2026-11-05,1250.00,2500.00,1250.00,overpaid,reference,2 5,');
    expect(lines[3]).toBe('INV-1003,Lim Hardware,2026-11-10,2000.00,1000.00,-1000.00,partial,reference,4,2');
    expect(lines).toHaveLength(9);
  });

  it('ages what is still owed, to the latest payment date by default', () => {
    expect(main([inv, pay])).toBe(1);
    expect(out).toMatch(/INV-1003 +2,000.00 +1,000.00 +partial +short 1,000.00; 2 day\(s\) overdue/);
    expect(out).toMatch(/INV-1006 +760.00 +0.00 +unpaid +due today/);
    expect(out).toMatch(/INV-1007 +150.00 +0.00 +unpaid +due in 3 day\(s\)/);
    expect(out).toContain('Outstanding by age (as of 2026-11-12, the latest payment date):');
    expect(out).toMatch(/not yet due +3 +1,060.00/);
    expect(out).toMatch(/1-30 days +1 +1,000.00/);
    expect(out).not.toMatch(/31-60 days/);
    out = '';
    expect(main([inv, pay, '--json', '--as-of', '31/12/2026'])).toBe(1);
    const data = JSON.parse(out);
    expect(data.aging.asOf).toBe('2026-12-31');
    expect(data.aging.asOfSource).toBe('option');
    expect(data.aging.rows.find((r: { bucket: string }) => r.bucket === '31-60 days')).toEqual({ bucket: '31-60 days', invoices: 4, outstanding: '2060.00' });
    expect(data.invoices.find((i: { ref: string }) => i.ref === 'INV-1003').daysOverdue).toBe(51);
    expect(data.invoices.find((i: { ref: string }) => i.ref === 'INV-1002').daysOverdue).toBeUndefined();
    out = '';
    expect(main([inv, pay, '--md'])).toBe(1);
    expect(out).toContain('## Outstanding by age (as of 2026-11-12, the latest payment date)');
    expect(out).toContain('| not yet due | 3 | 1,060.00 |');
  });

  it('leaves aging out when nothing owed has a due date, unless --as-of is given', () => {
    const i = tmp('i.csv', 'ref,amount\nA-1,10\nB-1,20\n');
    const p = tmp('p.csv', 'date,amount,reference\n2026-11-01,10,a1\n');
    expect(main([i, p])).toBe(1);
    expect(out).not.toContain('Outstanding by age');
    out = '';
    expect(main([i, p, '--csv'])).toBe(1);
    expect(out.split('\n')[0]).toBe('ref,customer,due_date,amount,received,difference,status,method,payment_rows');
    out = '';
    expect(main([i, p, '--as-of', '2026-11-30'])).toBe(1);
    expect(out).toContain('Outstanding by age (as of 2026-11-30):');
    expect(out).toMatch(/no due date +1 +20.00/);
  });

  it('rejects a bad --as-of', () => {
    expect(main([inv, pay, '--as-of', '2026-02-30'])).toBe(2);
    expect(err).toContain('--as-of: "2026-02-30" is not a real calendar date');
    err = '';
    expect(main([inv, pay, '--as-of', '2026-11-12 10:00'])).toBe(2);
    expect(err).toContain('--as-of: give a date only');
  });

  it('exits 0 when everything matches by reference', () => {
    const i = tmp('i.csv', 'ref,amount\nA-1,10\n');
    const p = tmp('p.csv', 'date,amount,reference\n2026-11-01,10,a1\n');
    expect(main([i, p])).toBe(0);
    expect(out).toContain('Findings: none');
  });

  it('honours custom columns and --no-amount-match', () => {
    const i = tmp('i.csv', 'No,Total\nA-1,10\n');
    const p = tmp('p.csv', 'Tarikh,Kredit,Butiran\n01/11/2026,10.00,transfer\n');
    const args = [i, p, '--invoice-ref', 'No', '--invoice-amount', 'Total', '--payment-date', 'Tarikh', '--payment-amount', 'Kredit', '--payment-reference', 'Butiran'];
    expect(main([...args, '--json'])).toBe(1);
    expect(JSON.parse(out).payments[0]).toMatchObject({ status: 'matched', method: 'amount' });
    out = '';
    expect(main([...args, '--json', '--no-amount-match'])).toBe(1);
    expect(JSON.parse(out).payments[0].status).toBe('unmatched');
  });

  it('exits 2 on input errors', () => {
    expect(main([inv])).toBe(2);
    expect(err).toContain('Give at least two files');
    err = '';
    expect(main([inv, pay, '--json', '--csv'])).toBe(2);
    expect(err).toContain('only one of');
    err = '';
    expect(main([inv, '/nonexistent/p.csv'])).toBe(2);
    expect(err).toContain('Cannot read payments /nonexistent/p.csv: ENOENT');
    err = '';
    expect(main([inv, pay, '--bogus'])).toBe(2);
    err = '';
    expect(main([inv, tmp('p.csv', 'date,amount,reference\n2026-11-01,1.005,x\n')])).toBe(2);
    expect(err).toMatch(/p\.csv row 2: "1.005" is not an amount/);
  });

  it('merges several payments files and leaves out the overlap', () => {
    const i = tmp('inv.csv', 'ref,amount\nA-1,10\nB-1,20\n');
    const p1 = tmp('oct.csv', 'date,amount,reference,id\n2026-10-30,10,a1,T1\n2026-11-01,5,b1,T2\n');
    const p2 = tmp('nov.csv', 'date,amount,reference,id\n2026-11-01,5,B1,T2\n2026-11-03,15,B-1 rest,T3\n2026-11-04,1,tip,\n');
    expect(main([i, p1, p2])).toBe(1);
    expect(out).toContain('Payments: 4 (3 matched, 0 ambiguous, 1 unmatched); from 2 files; 1 overlapping row(s) left out (same transaction id in an earlier file)');
    expect(out).toContain('Note: 1 payment(s) have no transaction id, so overlap between files could not be checked for them.');
    expect(out).toMatch(/nov\.csv:4 +2026-11-04 +1.00 +tip +no invoice found/);
    out = '';
    expect(main([i, p1, p2, '--json'])).toBe(1);
    const data = JSON.parse(out);
    expect(data.counts).toMatchObject({ paid: 2, unmatchedPayments: 1 });
    expect(data.invoices[1].paymentRows).toEqual(['oct.csv:3', 'nov.csv:3']);
    expect(data.overlapRows).toEqual([{ source: 'nov.csv', row: 2, id: 'T2', keptSource: 'oct.csv', keptRow: 3 }]);
    expect(data.files).toBe(2);
    expect(data.paymentsWithoutId).toBe(1);
    out = '';
    expect(main([i, p1, p2, '--md'])).toBe(1);
    expect(out).toContain('| nov.csv:4 | 2026-11-04 | 1.00 | tip | no invoice found |');
    out = '';
    expect(main([i, p1, p2, '--csv'])).toBe(1);
    expect(out).toContain('B-1,,,20.00,20.00,0.00,paid,reference,oct.csv:3 nov.csv:3');
  });

  it('keeps single-file JSON as before (no file fields)', () => {
    expect(main([inv, pay, '--json'])).toBe(1);
    const data = JSON.parse(out);
    expect(data).not.toHaveProperty('overlapRows');
    expect(data.payments[0]).not.toHaveProperty('source');
  });

  it('exits 2 on conflicting ids across files and on a file given twice', () => {
    const i = tmp('inv.csv', 'ref,amount\nA-1,10\n');
    const p1 = tmp('a.csv', 'date,amount,reference,id\n2026-11-01,10,a1,T1\n');
    const p2 = tmp('b.csv', 'date,amount,reference,id\n2026-11-01,9,a1,T1\n');
    expect(main([i, p1, p2])).toBe(2);
    expect(err).toContain('b.csv row 2: transaction id "T1" is also on a.csv row 2 with a different date or amount');
    err = '';
    expect(main([i, p1, p1])).toBe(2);
    expect(err).toContain('given twice');
  });

  it('prints help', () => {
    expect(main(['--help'])).toBe(0);
    expect(out).toContain('Usage: duitnow-recon <invoices.csv> <payments.csv>');
  });
});
