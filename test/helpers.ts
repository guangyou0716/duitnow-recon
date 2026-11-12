import { fileURLToPath } from 'node:url';
import { parseInvoices, parsePayments } from '../src/input.js';
import type { Invoice, Payment } from '../src/input.js';

export const root = fileURLToPath(new URL('..', import.meta.url));

/** invoices("A:10.00", "B:5") -> invoices A (1000 cents) and B (500 cents). */
export function invoices(...specs: string[]): Invoice[] {
  return parseInvoices(['ref,amount', ...specs.map((s) => s.replace(':', ','))].join('\n'));
}

/** payments(["2026-11-01", "10.00", "INV A"], ...) */
export function payments(...rows: [string, string, string][]): Payment[] {
  const csv = (s: string) => `"${s.replace(/"/g, '""')}"`;
  return parsePayments(['date,amount,reference', ...rows.map((r) => r.map(csv).join(','))].join('\n')).payments;
}
