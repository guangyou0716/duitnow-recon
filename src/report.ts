import { formatCents, plainCents } from './money.js';
import { findings } from './reconcile.js';
import type { InvoiceResult, PaymentResult, Reconciliation } from './reconcile.js';

function table(head: string[], rows: string[][], right: number[] = []): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (right.includes(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(head), ...rows.map(line)];
}

const when = (p: PaymentResult) => (p.time ? `${p.date} ${p.time}` : p.date);

function invoiceNote(inv: InvoiceResult): string {
  if (inv.status === 'partial') return `short ${formatCents(-inv.differenceCents)}`;
  if (inv.status === 'overpaid') return `over ${formatCents(inv.differenceCents)}`;
  return inv.method === 'amount' ? 'by amount only' : '';
}

function paymentNote(p: PaymentResult): string {
  if (p.status === 'ambiguous') return `same amount as ${p.candidates!.join(', ')}`;
  if (p.status === 'unmatched') return 'no invoice found';
  const parts = [`-> ${p.invoices.join(', ')}`];
  if (p.method === 'amount') parts.push('(by amount only)');
  if (p.possibleDuplicate) parts.push('(possible duplicate: already paid)');
  else if (p.excessCents > 0) parts.push(`(excess ${formatCents(p.excessCents)})`);
  return parts.join(' ');
}

const needsAttention = (p: PaymentResult) => p.status !== 'matched' || p.method === 'amount' || p.possibleDuplicate || p.excessCents > 0;

export function textReport(rec: Reconciliation, skipped = 0): string {
  const { counts: c, totals: t } = rec;
  const out: string[] = [];
  out.push(`Invoices: ${rec.invoices.length} (${c.paid} paid, ${c.partial} partial, ${c.overpaid} overpaid, ${c.unpaid} unpaid)`);
  out.push(`Payments: ${rec.payments.length} (${rec.payments.length - c.unmatchedPayments - c.ambiguousPayments} matched, ${c.ambiguousPayments} ambiguous, ${c.unmatchedPayments} unmatched)${skipped ? `; ${skipped} debit/zero row(s) left out` : ''}`);
  out.push(`Invoiced ${formatCents(t.invoicedCents)}, received ${formatCents(t.receivedCents)}, outstanding ${formatCents(t.outstandingCents)}, overpaid ${formatCents(t.overpaidCents)}, not matched ${formatCents(t.unmatchedCents)}`);
  const open = rec.invoices.filter((i) => i.status !== 'paid' || i.method === 'amount');
  if (open.length) {
    out.push('', 'Invoices to check:');
    out.push(...table(['Ref', 'Amount', 'Received', 'Status', 'Note'],
      open.map((i) => [i.ref, formatCents(i.amountCents), formatCents(i.receivedCents), i.status, invoiceNote(i)]), [1, 2]).map((l) => `  ${l}`));
  }
  const pays = rec.payments.filter(needsAttention);
  if (pays.length) {
    out.push('', 'Payments to check:');
    out.push(...table(['Row', 'Date', 'Amount', 'Reference', 'Result'],
      pays.map((p) => [String(p.row), when(p), formatCents(p.amountCents), p.reference, paymentNote(p)]), [0, 2]).map((l) => `  ${l}`));
  }
  const f = findings(rec);
  out.push('', f.length ? `Findings: ${f.join(', ')}` : 'Findings: none (every invoice paid exactly, every payment matched by reference)');
  return `${out.join('\n')}\n`;
}

const md = (s: string) => s.replace(/\|/g, '\\|');

export function markdownReport(rec: Reconciliation, skipped = 0): string {
  const { counts: c, totals: t } = rec;
  const out: string[] = ['# Payment reconciliation', ''];
  out.push(`- Invoices: ${rec.invoices.length} (${c.paid} paid, ${c.partial} partial, ${c.overpaid} overpaid, ${c.unpaid} unpaid)`);
  out.push(`- Payments: ${rec.payments.length} (${rec.payments.length - c.unmatchedPayments - c.ambiguousPayments} matched, ${c.ambiguousPayments} ambiguous, ${c.unmatchedPayments} unmatched)${skipped ? `; ${skipped} debit/zero row(s) left out` : ''}`);
  out.push(`- Invoiced ${formatCents(t.invoicedCents)}, received ${formatCents(t.receivedCents)}, outstanding ${formatCents(t.outstandingCents)}, overpaid ${formatCents(t.overpaidCents)}, not matched ${formatCents(t.unmatchedCents)}`);
  out.push('', '## Invoices', '', '| Ref | Amount | Received | Status | Note |', '| --- | ---: | ---: | --- | --- |');
  for (const i of rec.invoices) out.push(`| ${md(i.ref)} | ${formatCents(i.amountCents)} | ${formatCents(i.receivedCents)} | ${i.status} | ${md(invoiceNote(i))} |`);
  out.push('', '## Payments', '', '| Row | Date | Amount | Reference | Result |', '| ---: | --- | ---: | --- | --- |');
  for (const p of rec.payments) out.push(`| ${p.row} | ${when(p)} | ${formatCents(p.amountCents)} | ${md(p.reference)} | ${md(paymentNote(p))} |`);
  const f = findings(rec);
  out.push('', `**Findings:** ${f.length ? f.join(', ') : 'none'}`);
  return `${out.join('\n')}\n`;
}

export function jsonReport(rec: Reconciliation, skipped: { row: number; amountCents: number }[] = []): string {
  const money = (cents: number) => plainCents(cents);
  return `${JSON.stringify({
    counts: rec.counts,
    totals: Object.fromEntries(Object.entries(rec.totals).map(([k, v]) => [k.replace(/Cents$/, ''), money(v)])),
    invoices: rec.invoices.map(({ amountCents, receivedCents, differenceCents, ...rest }) => ({ ...rest, amount: money(amountCents), received: money(receivedCents), difference: money(differenceCents) })),
    payments: rec.payments.map(({ amountCents, excessCents, ...rest }) => ({ ...rest, amount: money(amountCents), excess: money(excessCents) })),
    skippedRows: skipped.map((s) => ({ row: s.row, amount: money(s.amountCents) })),
    findings: findings(rec),
  }, null, 2)}\n`;
}

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** One row per invoice, for a spreadsheet. */
export function csvReport(rec: Reconciliation): string {
  const head = ['ref', 'customer', 'due_date', 'amount', 'received', 'difference', 'status', 'method', 'payment_rows'];
  const rows = rec.invoices.map((i) => [i.ref, i.customer ?? '', i.dueDate ?? '', plainCents(i.amountCents), plainCents(i.receivedCents),
    plainCents(i.differenceCents), i.status, i.method ?? '', i.paymentRows.join(' ')]);
  return `${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}
