import type { InvoiceResult, Reconciliation } from './reconcile.js';

export type AgeBucket = 'not yet due' | '1-30 days' | '31-60 days' | '61-90 days' | 'over 90 days' | 'no due date';

export const AGE_BUCKETS: readonly AgeBucket[] = ['not yet due', '1-30 days', '31-60 days', '61-90 days', 'over 90 days', 'no due date'];

export interface AgeRow {
  bucket: AgeBucket;
  invoices: number;
  outstandingCents: number;
}

export interface Aging {
  /** Date the ages are counted to (YYYY-MM-DD). */
  asOf: string;
  /** Where asOf came from: the --as-of option, or the latest payment date in the input. */
  asOfSource: 'option' | 'latest payment';
  /** Every bucket, in order, including empty ones. Only unpaid and partly paid invoices are counted. */
  rows: AgeRow[];
}

const DAY_MS = 86_400_000;
const dayNumber = (isoDate: string) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / DAY_MS;
};

/** Whole days from the due date to asOf: 0 on the due date, negative before it. */
export const daysPastDue = (dueDate: string, asOf: string) => dayNumber(asOf) - dayNumber(dueDate);

export function ageBucket(daysOverdue: number | undefined): AgeBucket {
  if (daysOverdue === undefined) return 'no due date';
  if (daysOverdue <= 0) return 'not yet due';
  if (daysOverdue <= 30) return '1-30 days';
  if (daysOverdue <= 60) return '31-60 days';
  if (daysOverdue <= 90) return '61-90 days';
  return 'over 90 days';
}

const outstanding = (inv: InvoiceResult) => Math.max(0, -inv.differenceCents);

/**
 * Ages what is still owed (unpaid and partly paid invoices) by due date, counted to `asOf`. Sets `daysOverdue` on
 * every invoice that still owes money and has a due date (0 = due that day, negative = not yet due), and returns the
 * same reconciliation with `aging` added. Paid and overpaid invoices are not aged.
 */
export function addAging(rec: Reconciliation, asOf: string, asOfSource: Aging['asOfSource']): Reconciliation {
  const rows = new Map<AgeBucket, AgeRow>(AGE_BUCKETS.map((bucket) => [bucket, { bucket, invoices: 0, outstandingCents: 0 }]));
  const invoices = rec.invoices.map((inv) => {
    const owed = outstanding(inv);
    if (owed === 0) return inv;
    const aged: InvoiceResult = inv.dueDate === undefined ? inv : { ...inv, daysOverdue: daysPastDue(inv.dueDate, asOf) };
    const row = rows.get(ageBucket(aged.daysOverdue))!;
    row.invoices++;
    row.outstandingCents += owed;
    return aged;
  });
  return { ...rec, invoices, aging: { asOf, asOfSource, rows: [...rows.values()] } };
}

/** The latest payment date (YYYY-MM-DD), or undefined when there are no payments. */
export function latestPaymentDate(rec: Reconciliation): string | undefined {
  let latest: string | undefined;
  for (const p of rec.payments) if (latest === undefined || p.date > latest) latest = p.date;
  return latest;
}
