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
    expect(lines[0]).toBe('ref,customer,due_date,amount,received,difference,status,method,payment_rows');
    expect(lines[1]).toBe('INV-1001,Kedai Runcit Ali,2026-11-05,1250.00,2500.00,1250.00,overpaid,reference,2 5');
    expect(lines).toHaveLength(9);
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
    expect(err).toContain('Give two files');
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

  it('prints help', () => {
    expect(main(['--help'])).toBe(0);
    expect(out).toContain('Usage: duitnow-recon <invoices.csv> <payments.csv>');
  });
});
