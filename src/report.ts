import { formatCents, plainCents } from './money.js';
import { findings, paymentLabel } from './reconcile.js';
import type { OverlapRow, SkippedRow } from './input.js';
import type { InvoiceResult, PaymentResult, Reconciliation } from './reconcile.js';

function table(head: string[], rows: string[][], right: number[] = []): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (right.includes(i) ? c.padStart(widths[i]) : c.padEnd(widths[i]))).join('  ').trimEnd();
  return [line(head), ...rows.map(line)];
}

const when = (p: PaymentResult) => (p.time ? `${p.date} ${p.time}` : p.date);

function ageNote(days: number | undefined): string {
  if (days === undefined) return '';
  if (days > 0) return `${days} day(s) overdue`;
  return days === 0 ? 'due today' : `due in ${-days} day(s)`;
}

function invoiceNote(inv: InvoiceResult): string {
  const parts: string[] = [];
  if (inv.status === 'partial') parts.push(`short ${formatCents(-inv.differenceCents)}`);
  else if (inv.status === 'overpaid') parts.push(`over ${formatCents(inv.differenceCents)}`);
  else if (inv.method === 'amount') parts.push('by amount only');
  if (ageNote(inv.daysOverdue)) parts.push(ageNote(inv.daysOverdue));
  return parts.join('; ');
}

const agingTitle = (rec: Reconciliation) =>
  `Outstanding by age (as of ${rec.aging!.asOf}${rec.aging!.asOfSource === 'latest payment' ? ', the latest payment date' : ''})`;
const agingRows = (rec: Reconciliation) => rec.aging!.rows.filter((r) => r.invoices > 0);

function hintNote(p: PaymentResult): string {
  if (!p.payerHints) return '';
  const shown = p.payerHints.slice(0, 3).join(', ');
  const more = p.payerHints.length > 3 ? ` +${p.payerHints.length - 3} more` : '';
  return `; payer looks like customer of ${shown}${more} (hint only)`;
}

function paymentNote(p: PaymentResult): string {
  if (p.status === 'ambiguous') return `same amount as ${p.candidates!.join(', ')}${hintNote(p)}`;
  if (p.status === 'unmatched') return `no invoice found${hintNote(p)}`;
  const parts = [`-> ${p.invoices.join(', ')}`];
  if (p.method === 'amount') parts.push('(by amount only)');
  if (p.possibleDuplicate) parts.push('(possible duplicate: already paid)');
  else if (p.excessCents > 0) parts.push(`(excess ${formatCents(p.excessCents)})`);
  return parts.join(' ');
}

/** What was left out of the input before matching. A plain number is the count of debit/zero rows (older form). */
export interface InputInfo {
  skipped?: SkippedRow[];
  overlaps?: OverlapRow[];
  /** Number of payments files; the "no transaction id" note is shown only when several were merged. */
  files?: number;
  withoutId?: number;
}

type Info = InputInfo & { skippedCount: number };
const info = (x: InputInfo | number | SkippedRow[]): Info =>
  typeof x === 'number' ? { skippedCount: x } : Array.isArray(x) ? { skipped: x, skippedCount: x.length } : { ...x, skippedCount: x.skipped?.length ?? 0 };

function paymentsLine(rec: Reconciliation, i: Info): string {
  const c = rec.counts;
  const extra: string[] = [];
  if (i.files && i.files > 1) extra.push(`from ${i.files} files`);
  if (i.skippedCount) extra.push(`${i.skippedCount} debit/zero row(s) left out`);
  if (i.overlaps?.length) extra.push(`${i.overlaps.length} overlapping row(s) left out (same transaction id in an earlier file)`);
  return `Payments: ${rec.payments.length} (${rec.payments.length - c.unmatchedPayments - c.ambiguousPayments} matched, ${c.ambiguousPayments} ambiguous, ${c.unmatchedPayments} unmatched)${extra.length ? `; ${extra.join('; ')}` : ''}`;
}

const idNote = (i: InputInfo) =>
  i.files && i.files > 1 && i.withoutId ? `Note: ${i.withoutId} payment(s) have no transaction id, so overlap between files could not be checked for them.` : '';

const windowNote = (rec: Reconciliation) =>
  rec.amountWindowDays === undefined ? '' : `Amount-only matching limited to invoices due within ${rec.amountWindowDays} day(s) of the payment date.`;

const needsAttention = (p: PaymentResult) => p.status !== 'matched' || p.method === 'amount' || p.possibleDuplicate || p.excessCents > 0;

export function textReport(rec: Reconciliation, input: InputInfo | number = 0): string {
  const { counts: c, totals: t } = rec;
  const i = info(input);
  const out: string[] = [];
  out.push(`Invoices: ${rec.invoices.length} (${c.paid} paid, ${c.partial} partial, ${c.overpaid} overpaid, ${c.unpaid} unpaid)`);
  out.push(paymentsLine(rec, i));
  if (idNote(i)) out.push(idNote(i));
  if (windowNote(rec)) out.push(windowNote(rec));
  out.push(`Invoiced ${formatCents(t.invoicedCents)}, received ${formatCents(t.receivedCents)}, outstanding ${formatCents(t.outstandingCents)}, overpaid ${formatCents(t.overpaidCents)}, not matched ${formatCents(t.unmatchedCents)}`);
  const open = rec.invoices.filter((i) => i.status !== 'paid' || i.method === 'amount');
  if (open.length) {
    out.push('', 'Invoices to check:');
    out.push(...table(['Ref', 'Amount', 'Received', 'Status', 'Note'],
      open.map((i) => [i.ref, formatCents(i.amountCents), formatCents(i.receivedCents), i.status, invoiceNote(i)]), [1, 2]).map((l) => `  ${l}`));
  }
  if (rec.aging && agingRows(rec).length) {
    out.push('', `${agingTitle(rec)}:`);
    out.push(...table(['Age', 'Invoices', 'Outstanding'],
      agingRows(rec).map((r) => [r.bucket, String(r.invoices), formatCents(r.outstandingCents)]), [1, 2]).map((l) => `  ${l}`));
  }
  const pays = rec.payments.filter(needsAttention);
  if (pays.length) {
    out.push('', 'Payments to check:');
    out.push(...table(['Row', 'Date', 'Amount', 'Reference', 'Result'],
      pays.map((p) => [String(paymentLabel(p)), when(p), formatCents(p.amountCents), p.reference, paymentNote(p)]), [0, 2]).map((l) => `  ${l}`));
  }
  const f = findings(rec);
  out.push('', f.length ? `Findings: ${f.join(', ')}` : 'Findings: none (every invoice paid exactly, every payment matched by reference)');
  return `${out.join('\n')}\n`;
}

const md = (s: string) => s.replace(/\|/g, '\\|');

export function markdownReport(rec: Reconciliation, input: InputInfo | number = 0): string {
  const { counts: c, totals: t } = rec;
  const i = info(input);
  const out: string[] = ['# Payment reconciliation', ''];
  out.push(`- Invoices: ${rec.invoices.length} (${c.paid} paid, ${c.partial} partial, ${c.overpaid} overpaid, ${c.unpaid} unpaid)`);
  out.push(`- ${paymentsLine(rec, i)}`);
  if (idNote(i)) out.push(`- ${idNote(i)}`);
  if (windowNote(rec)) out.push(`- ${windowNote(rec)}`);
  out.push(`- Invoiced ${formatCents(t.invoicedCents)}, received ${formatCents(t.receivedCents)}, outstanding ${formatCents(t.outstandingCents)}, overpaid ${formatCents(t.overpaidCents)}, not matched ${formatCents(t.unmatchedCents)}`);
  out.push('', '## Invoices', '', '| Ref | Amount | Received | Status | Note |', '| --- | ---: | ---: | --- | --- |');
  for (const inv of rec.invoices) out.push(`| ${md(inv.ref)} | ${formatCents(inv.amountCents)} | ${formatCents(inv.receivedCents)} | ${inv.status} | ${md(invoiceNote(inv))} |`);
  if (rec.aging && agingRows(rec).length) {
    out.push('', `## ${agingTitle(rec)}`, '', '| Age | Invoices | Outstanding |', '| --- | ---: | ---: |');
    for (const r of agingRows(rec)) out.push(`| ${r.bucket} | ${r.invoices} | ${formatCents(r.outstandingCents)} |`);
  }
  out.push('', '## Payments', '', '| Row | Date | Amount | Reference | Result |', '| ---: | --- | ---: | --- | --- |');
  for (const p of rec.payments) out.push(`| ${md(String(paymentLabel(p)))} | ${when(p)} | ${formatCents(p.amountCents)} | ${md(p.reference)} | ${md(paymentNote(p))} |`);
  const f = findings(rec);
  out.push('', `**Findings:** ${f.length ? f.join(', ') : 'none'}`);
  return `${out.join('\n')}\n`;
}

export function jsonReport(rec: Reconciliation, input: InputInfo | SkippedRow[] = []): string {
  const money = (cents: number) => plainCents(cents);
  const i = info(input);
  const multi = (i.files ?? 1) > 1;
  return `${JSON.stringify({
    counts: rec.counts,
    totals: Object.fromEntries(Object.entries(rec.totals).map(([k, v]) => [k.replace(/Cents$/, ''), money(v)])),
    invoices: rec.invoices.map(({ amountCents, receivedCents, differenceCents, ...rest }) => ({ ...rest, amount: money(amountCents), received: money(receivedCents), difference: money(differenceCents) })),
    payments: rec.payments.map(({ amountCents, excessCents, ...rest }) => ({ ...rest, amount: money(amountCents), excess: money(excessCents) })),
    skippedRows: (i.skipped ?? []).map(({ amountCents, ...rest }) => ({ ...rest, amount: money(amountCents) })),
    ...(rec.aging ? { aging: { ...rec.aging, rows: rec.aging.rows.map(({ outstandingCents, ...rest }) => ({ ...rest, outstanding: money(outstandingCents) })) } } : {}),
    ...(rec.amountWindowDays !== undefined ? { amountWindowDays: rec.amountWindowDays } : {}),
    ...(multi ? { files: i.files, overlapRows: i.overlaps ?? [], paymentsWithoutId: i.withoutId ?? 0 } : {}),
    findings: findings(rec),
  }, null, 2)}\n`;
}

const csvCell = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** One row per invoice, for a spreadsheet. With aging, a last column days_overdue (empty when not aged). */
export function csvReport(rec: Reconciliation): string {
  const aged = rec.aging !== undefined;
  const head = ['ref', 'customer', 'due_date', 'amount', 'received', 'difference', 'status', 'method', 'payment_rows', ...(aged ? ['days_overdue'] : [])];
  const rows = rec.invoices.map((i) => [i.ref, i.customer ?? '', i.dueDate ?? '', plainCents(i.amountCents), plainCents(i.receivedCents),
    plainCents(i.differenceCents), i.status, i.method ?? '', i.paymentRows.join(' '), ...(aged ? [i.daysOverdue === undefined ? '' : String(i.daysOverdue)] : [])]);
  return `${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n')}\n`;
}
