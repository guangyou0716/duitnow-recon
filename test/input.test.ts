import { describe, expect, it } from 'vitest';
import { parseDate, parseInvoices, parsePayments, referenceKey } from '../src/input.js';

describe('referenceKey', () => {
  it('ignores case and separators', () => {
    expect(referenceKey('inv-0012')).toBe('INV0012');
    expect(referenceKey(' INV 0012 ')).toBe('INV0012');
    expect(referenceKey('Inv_0012.')).toBe('INV0012');
    expect(referenceKey('ＩＮＶ１２')).toBe('INV12');
  });
});

describe('parseDate', () => {
  it('reads ISO and day-first dates with optional time', () => {
    expect(parseDate('2026-11-12', 'x')).toEqual({ date: '2026-11-12' });
    expect(parseDate('2026-11-12T08:30:00+08:00', 'x')).toEqual({ date: '2026-11-12', time: '08:30:00+08:00' });
    expect(parseDate('3/11/2026 10:15', 'x')).toEqual({ date: '2026-11-03', time: '10:15' });
    expect(parseDate('12.11.2026', 'x')).toEqual({ date: '2026-11-12' });
    expect(parseDate('12-11-2026', 'x')).toEqual({ date: '2026-11-12' });
    expect(parseDate('12/11/2026 9:05', 'x')).toEqual({ date: '2026-11-12', time: '09:05' });
  });
  it('rejects impossible and unknown dates', () => {
    expect(() => parseDate('31/02/2026', 'f row 3')).toThrow('f row 3: "31/02/2026" is not a real calendar date.');
    expect(() => parseDate('11/31/2026', 'x')).toThrow(/not a real calendar date/);
    expect(() => parseDate('Nov 12 2026', 'x')).toThrow(/is not a date/);
    expect(() => parseDate('', 'x')).toThrow(/is not a date/);
  });
});

describe('parseInvoices', () => {
  it('reads required and optional columns', () => {
    const inv = parseInvoices('Ref,Amount,Customer,Due_Date\nINV-1,"1,000.00",Ali,05/11/2026\nINV-2,5,,\n', 'inv.csv');
    expect(inv).toEqual([
      { ref: 'INV-1', key: 'INV1', amountCents: 100000, customer: 'Ali', dueDate: '2026-11-05', row: 2 },
      { ref: 'INV-2', key: 'INV2', amountCents: 500, row: 3 },
    ]);
  });
  it('uses custom column names', () => {
    const inv = parseInvoices('No,Total\nA1,10\n', 'f', { ref: 'No', amount: 'Total' });
    expect(inv[0]).toMatchObject({ ref: 'A1', amountCents: 1000 });
  });
  it('rejects duplicates after normalising, empty refs, bad amounts and missing columns', () => {
    expect(() => parseInvoices('ref,amount\nINV-1,1\ninv 1,2\n', 'f')).toThrow('f row 3: reference "inv 1" is the same as "INV-1" on row 2 (case and separators are ignored).');
    expect(() => parseInvoices('ref,amount\n -- ,1\n', 'f')).toThrow('f row 2: the invoice reference is empty.');
    expect(() => parseInvoices('ref,amount\nA,0\n', 'f')).toThrow('f row 2: the invoice amount must be more than zero.');
    expect(() => parseInvoices('ref,amount\nA,1.234\n', 'f')).toThrow(/f row 2: "1.234" is not an amount/);
    expect(() => parseInvoices('invoice,amount\nA,1\n', 'f')).toThrow('f: no "ref" column (found: invoice, amount). Set it with --invoice-ref.');
    expect(() => parseInvoices('ref,amount\n', 'f')).toThrow('f: no invoice rows.');
    expect(() => parseInvoices('', 'f')).toThrow('f: the file is empty.');
    expect(() => parseInvoices('ref,Ref,amount\nA,B,1\n', 'f')).toThrow('f: column "Ref" appears twice in the header.');
    expect(() => parseInvoices('ref,amount\nA,1\n', 'f', { customer: 'cust' })).toThrow(/no "cust" column.*--invoice-customer/);
  });
});

describe('parsePayments', () => {
  it('reads payments, leaves out debits and zero rows', () => {
    const { payments, skipped } = parsePayments('date,amount,reference,payer,id\n2026-11-01,10.00,INV-1,Ali,T1\n2026-11-02,-0.50,charge,,T2\n2026-11-03,0,,,T3\n', 'p');
    expect(payments).toEqual([{ date: '2026-11-01', amountCents: 1000, reference: 'INV-1', payer: 'Ali', id: 'T1', row: 2 }]);
    expect(skipped).toEqual([{ row: 3, amountCents: -50 }, { row: 4, amountCents: 0 }]);
  });
  it('rejects repeated transaction ids and bad dates', () => {
    expect(() => parsePayments('date,amount,reference,id\n2026-11-01,1,a,T1\n2026-11-02,2,b,T1\n', 'p')).toThrow('p row 3: transaction id "T1" already appears on row 2 (is the statement exported twice?).');
    expect(() => parsePayments('date,amount,reference\n2026-13-01,1,a\n', 'p')).toThrow('p row 2: "2026-13-01" is not a real calendar date.');
    expect(() => parsePayments('date,amount\n2026-11-01,1\n', 'p')).toThrow(/no "reference" column.*--payment-reference/);
  });
});
