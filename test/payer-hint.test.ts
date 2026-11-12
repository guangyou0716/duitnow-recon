import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { parseInvoices, parsePayments } from '../src/input.js';
import { findings, nameWords, namesMatch, reconcile } from '../src/reconcile.js';
import { jsonReport, markdownReport, textReport } from '../src/report.js';

const inv = (...rows: string[]) => parseInvoices(['ref,amount,customer', ...rows].join('\n'));
const pay = (...rows: string[]) => parsePayments(['date,amount,reference,payer', ...rows].join('\n')).payments;
const m = (a: string, b: string) => namesMatch(nameWords(a), nameWords(b));

describe('name comparison', () => {
  it('ignores case, punctuation and legal-form words', () => {
    expect(nameWords('Tan Ah Kow Trading Sdn. Bhd.')).toEqual(['TAN', 'AH', 'KOW', 'TRADING']);
    expect(nameWords('KEDAI EMAS LIM S/B')).toEqual(['KEDAI', 'EMAS', 'LIM']);
    expect(nameWords('Syarikat ABC (M) Berhad')).toEqual(['SYARIKAT', 'ABC']);
    expect(nameWords('Ｔａｎ  Ａｈ')).toEqual(['TAN', 'AH']);
    expect(nameWords('Sdn Bhd')).toEqual([]);
    expect(m('TAN AH KOW TRADING SDN BHD', 'Tan Ah Kow Trading Sdn. Bhd.')).toBe(true);
  });

  it('accepts a name cut short by the bank when at least two words remain', () => {
    expect(m('TAN AH KOW TRAD', 'Tan Ah Kow Trading Sdn Bhd')).toBe(true);
    expect(m('TAN AH KOW', 'Tan Ah Kow Trading')).toBe(true);
    expect(m('Tan Ah Kow Trading', 'TAN AH KO')).toBe(true);
  });

  it('never matches on one word alone, different words or a different order', () => {
    expect(m('TAN', 'Tan Ah Kow')).toBe(false);
    expect(m('TAN', 'TAN')).toBe(true);
    expect(m('TA', 'TAN')).toBe(false);
    expect(m('LIM AH KOW', 'Tan Ah Kow')).toBe(false);
    expect(m('KOW AH TAN', 'Tan Ah Kow')).toBe(false);
    expect(m('', 'Tan Ah Kow')).toBe(false);
    expect(m('Sdn Bhd', 'Sdn Bhd')).toBe(false);
  });
});

describe('payer hint', () => {
  it('names open invoices of the payer for an unmatched payment, without paying them', () => {
    const rec = reconcile(inv('A,100,Tan Ah Kow Trading Sdn Bhd', 'B,250,Lim Hardware', 'C,80,Tan Ah Kow Trading'), pay('2026-11-01,90,transfer,TAN AH KOW TRAD'));
    expect(rec.payments[0]).toMatchObject({ status: 'unmatched', invoices: [], payerHints: ['A', 'C'] });
    expect(rec.invoices.map((i) => i.status)).toEqual(['unpaid', 'unpaid', 'unpaid']);
    expect(rec.counts.payerHints).toBe(1);
    expect(rec.counts.unmatchedPayments).toBe(1);
    expect(findings(rec)).not.toContain(expect.stringMatching(/hint/));
  });

  it('puts invoices still owing exactly the payment amount first', () => {
    const rec = reconcile(inv('A,100,Tan Ah Kow', 'B,80,Tan Ah Kow', 'C,90,Tan Ah Kow'), pay('2026-11-01,80,x,TAN AH KOW'), { amountMatch: false });
    expect(rec.payments[0].payerHints).toEqual(['B', 'A', 'C']);
  });

  it('uses what is still owed, so a part-paid invoice can be first and a fully paid one is left out', () => {
    const rec = reconcile(
      inv('A,100,Tan Ah Kow', 'B,100,Tan Ah Kow', 'C,50,Tan Ah Kow'),
      pay('2026-11-01,60,A,TAN AH KOW', '2026-11-01,50,C,TAN AH KOW', '2026-11-02,40,no ref,TAN AH KOW'),
      { amountMatch: false },
    );
    expect(rec.payments[2].payerHints).toEqual(['A', 'B']);
  });

  it('adds a hint to ambiguous payments too, and leaves them ambiguous', () => {
    const rec = reconcile(inv('A,100,Lim Hardware', 'B,100,Tan Ah Kow'), pay('2026-11-01,100,no ref,TAN AH KOW'));
    expect(rec.payments[0]).toMatchObject({ status: 'ambiguous', candidates: ['A', 'B'], payerHints: ['B'] });
    expect(rec.invoices.map((i) => i.status)).toEqual(['unpaid', 'unpaid']);
  });

  it('gives no hint to matched payments, payments without payer, or when nothing looks alike', () => {
    const rec = reconcile(inv('A,100,Tan Ah Kow', 'B,70,Tan Ah Kow'), parsePayments(['date,amount,reference,payer', '2026-11-01,100,A,TAN AH KOW', '2026-11-01,5,x,', '2026-11-01,6,y,LIM AH KOW'].join('\n')).payments);
    expect(rec.payments.map((p) => p.payerHints)).toEqual([undefined, undefined, undefined]);
    expect(rec.counts.payerHints).toBe(0);
    const noCustomer = reconcile(parseInvoices('ref,amount\nA,100'), pay('2026-11-01,5,x,TAN AH KOW'));
    expect(noCustomer.payments[0].payerHints).toBeUndefined();
  });

  it('shows the hint in text, Markdown and JSON reports', () => {
    const rec = reconcile(inv('A,10,Tan Ah Kow', 'B,20,Tan Ah Kow', 'C,30,Tan Ah Kow', 'D,40,Tan Ah Kow'), pay('2026-11-01,5,x,TAN AH KOW'));
    expect(textReport(rec)).toContain('no invoice found; payer looks like customer of A, B, C +1 more (hint only)');
    expect(markdownReport(rec)).toContain('payer looks like customer of A, B, C +1 more (hint only)');
    const json = JSON.parse(jsonReport(rec));
    expect(json.payments[0].payerHints).toEqual(['A', 'B', 'C', 'D']);
    expect(json.counts.payerHints).toBe(1);
  });

  it('stays fast with many invoices and unmatched payments', () => {
    const invRows = Array.from({ length: 20000 }, (_, i) => `INV${i},${(i % 500) + 1},Customer ${i % 2000} Sdn Bhd`);
    const payRows = Array.from({ length: 5000 }, (_, i) => `2026-11-01,${(i % 700) + 1000},no ref,CUSTOMER ${i % 2000}`);
    const t = Date.now();
    const rec = reconcile(inv(...invRows), pay(...payRows));
    expect(Date.now() - t).toBeLessThan(5000);
    expect(rec.payments[0].payerHints).toHaveLength(10);
  });
});

describe('payer hint in the CLI', () => {
  let dir: string;
  let out: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recon-hint-'));
    out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  });
  afterEach(() => vi.restoreAllMocks());

  it('keeps the exit code of an unmatched payment and prints the hint', () => {
    writeFileSync(join(dir, 'inv.csv'), 'ref,amount,customer\nINV-1,140,Tan Ah Kow Trading Sdn Bhd\n');
    writeFileSync(join(dir, 'pay.csv'), 'date,amount,reference,payer\n2026-11-01,100,inv 1,TAN AH KOW\n2026-11-02,40,thanks,TAN AH KOW TRADING\n');
    expect(main([join(dir, 'inv.csv'), join(dir, 'pay.csv')])).toBe(1);
    expect(out).toContain('no invoice found; payer looks like customer of INV-1 (hint only)');
  });
});

describe('payer hint lookup', () => {
  it('finds customers whether the payer or the customer name is the one cut short', () => {
    const invoices = inv('A,10,Tan Ah Kow Trading', 'B,10,Tan A', 'C,10,Tan Ahmad Bin Ali', 'D,10,Tan', 'E,10,Tan Bee Lian', 'F,10,Tan Ah');
    const hints = (payer: string) => reconcile(invoices, pay(`2026-11-01,1,x,${payer}`), { amountMatch: false }).payments[0].payerHints;
    expect(hints('TAN AH KOW TRADING SDN BHD')).toEqual(['A', 'B', 'F']);
    expect(hints('TAN AH')).toEqual(['A', 'C', 'F']);
    expect(hints('TAN')).toEqual(['D']);
    expect(hints('TAN BEE')).toEqual(['E']);
    expect(hints('TAN C')).toBeUndefined();
  });
});
