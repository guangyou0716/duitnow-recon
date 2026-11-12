import { referenceKey } from './input.js';
import type { Invoice, Payment } from './input.js';

export type MatchMethod = 'reference' | 'amount';

export type InvoiceStatus = 'paid' | 'partial' | 'overpaid' | 'unpaid';

export interface InvoiceResult {
  ref: string;
  row: number;
  customer?: string;
  dueDate?: string;
  amountCents: number;
  receivedCents: number;
  /** received - amount: negative = still owed, positive = paid too much. */
  differenceCents: number;
  status: InvoiceStatus;
  /**
   * Data rows of the payments that went to this invoice, in payment order. With several payments files each entry
   * is "file:row" instead of a row number.
   */
  paymentRows: (number | string)[];
  method?: MatchMethod;
}

export type PaymentStatus = 'matched' | 'ambiguous' | 'unmatched';

export interface PaymentResult {
  row: number;
  /** Payments file, set only when several files are merged. */
  source?: string;
  date: string;
  time?: string;
  id?: string;
  payer?: string;
  reference: string;
  amountCents: number;
  status: PaymentStatus;
  method?: MatchMethod;
  /** Invoice references this payment went to. */
  invoices: string[];
  /** For ambiguous payments: the open invoices with the same amount. */
  candidates?: string[];
  /** Part of the payment above what its invoices still owed. */
  excessCents: number;
  /** Every referenced invoice was already fully paid by an earlier payment. */
  possibleDuplicate: boolean;
}

export interface ReconcileOptions {
  /** Match payments without a usable reference by unique amount (default true). */
  amountMatch?: boolean;
}

export interface Totals {
  invoicedCents: number;
  receivedCents: number;
  allocatedCents: number;
  unmatchedCents: number;
  outstandingCents: number;
  overpaidCents: number;
}

export interface Reconciliation {
  invoices: InvoiceResult[];
  payments: PaymentResult[];
  counts: Record<InvoiceStatus, number> & { unmatchedPayments: number; ambiguousPayments: number; amountMatches: number; possibleDuplicates: number };
  totals: Totals;
}

const SPLIT = /[\s,;:/\\|#()[\]{}<>"']+/u;

/**
 * Finds invoice references inside a free-text payment reference, in order of appearance, without repeats.
 * The text is split into words (hyphens, dots and underscores stay inside a word); a word, or two neighbouring
 * words joined ("INV 0012"), matches an invoice when it equals the invoice reference with case and separators
 * ignored. Joined pairs win over single words, so "INV 12" goes to INV12 rather than to an invoice "12".
 */
export function findReferences(text: string, byKey: Map<string, Invoice>): Invoice[] {
  const words = text.split(SPLIT).map(referenceKey).filter((w) => w !== '');
  const found: Invoice[] = [];
  const add = (invoice: Invoice | undefined) => {
    if (invoice && !found.includes(invoice)) found.push(invoice);
    return invoice !== undefined;
  };
  for (let i = 0; i < words.length; ) {
    if (i + 1 < words.length && add(byKey.get(words[i] + words[i + 1]))) {
      i += 2;
    } else {
      add(byKey.get(words[i]));
      i += 1;
    }
  }
  return found;
}

/** How a payment is named in reports: its row number, or "file:row" when several files are merged. */
export const paymentLabel = (p: { row: number; source?: string }): number | string => (p.source === undefined ? p.row : `${p.source}:${p.row}`);

export function reconcile(invoices: Invoice[], payments: Payment[], options: ReconcileOptions = {}): Reconciliation {
  const amountMatch = options.amountMatch ?? true;
  const byKey = new Map(invoices.map((inv) => [inv.key, inv]));
  const received = new Map<Invoice, number>(invoices.map((inv) => [inv, 0]));
  const rowsOf = new Map<Invoice, (number | string)[]>(invoices.map((inv) => [inv, []]));
  const methodOf = new Map<Invoice, MatchMethod>();
  const results = new Map<Payment, PaymentResult>();
  // Date, then time, then input order (file order, then row).
  const order = new Map(payments.map((p, i) => [p, i]));
  const byDate = (a: Payment, b: Payment) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time ?? '') < (b.time ?? '') ? -1 : (a.time ?? '') > (b.time ?? '') ? 1 : order.get(a)! - order.get(b)!;
  const ordered = [...payments].sort(byDate);

  const base = (p: Payment): PaymentResult => {
    const r: PaymentResult = { row: p.row, date: p.date, reference: p.reference, amountCents: p.amountCents, status: 'unmatched', invoices: [], excessCents: 0, possibleDuplicate: false };
    if (p.source !== undefined) r.source = p.source;
    if (p.time) r.time = p.time;
    if (p.id) r.id = p.id;
    if (p.payer) r.payer = p.payer;
    return r;
  };
  const give = (inv: Invoice, p: Payment, cents: number, method: MatchMethod) => {
    received.set(inv, received.get(inv)! + cents);
    const rows = rowsOf.get(inv)!;
    const label = paymentLabel(p);
    if (!rows.includes(label)) rows.push(label);
    if (methodOf.get(inv) !== 'reference') methodOf.set(inv, method);
  };

  // Pass 1: payments that name one or more invoices, in date order.
  const unreferenced: Payment[] = [];
  for (const p of ordered) {
    const refs = findReferences(p.reference, byKey);
    if (refs.length === 0) {
      unreferenced.push(p);
      continue;
    }
    const r = base(p);
    r.status = 'matched';
    r.method = 'reference';
    r.invoices = refs.map((inv) => inv.ref);
    const owed = refs.map((inv) => Math.max(0, inv.amountCents - received.get(inv)!));
    r.possibleDuplicate = owed.every((o) => o === 0);
    let left = p.amountCents;
    refs.forEach((inv, i) => {
      const cents = Math.min(owed[i], left);
      left -= cents;
      if (cents > 0 || r.possibleDuplicate) give(inv, p, cents, 'reference');
    });
    if (left > 0) {
      // Extra money goes to the last named invoice that received something (or the first one if none did).
      let target = refs[0];
      refs.forEach((inv, i) => {
        if (owed[i] > 0) target = inv;
      });
      give(target, p, left, 'reference');
      r.excessCents = left;
    }
    results.set(p, r);
  }

  // Pass 2: unreferenced payments matched by amount, only when the pairing is unique both ways.
  const openByAmount = new Map<number, Invoice[]>();
  for (const inv of invoices) {
    if (received.get(inv) !== 0) continue;
    const list = openByAmount.get(inv.amountCents);
    if (list) list.push(inv);
    else openByAmount.set(inv.amountCents, [inv]);
  }
  const paymentsByAmount = new Map<number, number>();
  for (const p of unreferenced) paymentsByAmount.set(p.amountCents, (paymentsByAmount.get(p.amountCents) ?? 0) + 1);
  for (const p of unreferenced) {
    const r = base(p);
    results.set(p, r);
    if (!amountMatch) continue;
    const candidates = openByAmount.get(p.amountCents) ?? [];
    if (candidates.length === 1 && paymentsByAmount.get(p.amountCents) === 1) {
      r.status = 'matched';
      r.method = 'amount';
      r.invoices = [candidates[0].ref];
      give(candidates[0], p, p.amountCents, 'amount');
    } else if (candidates.length > 0) {
      r.status = 'ambiguous';
      r.candidates = candidates.map((inv) => inv.ref);
    }
  }

  const invoiceResults: InvoiceResult[] = invoices.map((inv) => {
    const got = received.get(inv)!;
    const diff = got - inv.amountCents;
    const status: InvoiceStatus = got === 0 ? 'unpaid' : diff === 0 ? 'paid' : diff < 0 ? 'partial' : 'overpaid';
    const res: InvoiceResult = { ref: inv.ref, row: inv.row, amountCents: inv.amountCents, receivedCents: got, differenceCents: diff, status, paymentRows: rowsOf.get(inv)! };
    if (inv.customer) res.customer = inv.customer;
    if (inv.dueDate) res.dueDate = inv.dueDate;
    const method = methodOf.get(inv);
    if (method) res.method = method;
    return res;
  });
  const paymentResults = ordered.map((p) => results.get(p)!);

  const counts = { paid: 0, partial: 0, overpaid: 0, unpaid: 0, unmatchedPayments: 0, ambiguousPayments: 0, amountMatches: 0, possibleDuplicates: 0 };
  for (const inv of invoiceResults) counts[inv.status]++;
  for (const p of paymentResults) {
    if (p.status === 'unmatched') counts.unmatchedPayments++;
    if (p.status === 'ambiguous') counts.ambiguousPayments++;
    if (p.method === 'amount') counts.amountMatches++;
    if (p.possibleDuplicate) counts.possibleDuplicates++;
  }
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const totals: Totals = {
    invoicedCents: sum(invoiceResults.map((i) => i.amountCents)),
    receivedCents: sum(paymentResults.map((p) => p.amountCents)),
    allocatedCents: sum(paymentResults.filter((p) => p.status === 'matched').map((p) => p.amountCents)),
    unmatchedCents: sum(paymentResults.filter((p) => p.status !== 'matched').map((p) => p.amountCents)),
    outstandingCents: sum(invoiceResults.map((i) => Math.max(0, -i.differenceCents))),
    overpaidCents: sum(invoiceResults.map((i) => Math.max(0, i.differenceCents))),
  };
  return { invoices: invoiceResults, payments: paymentResults, counts, totals };
}

/** Human-readable findings; an empty list means every invoice is paid exactly and every payment is matched. */
export function findings(rec: Reconciliation): string[] {
  const c = rec.counts;
  const out: string[] = [];
  if (c.unpaid) out.push(`${c.unpaid} unpaid invoice(s)`);
  if (c.partial) out.push(`${c.partial} partly paid invoice(s)`);
  if (c.overpaid) out.push(`${c.overpaid} overpaid invoice(s)`);
  if (c.possibleDuplicates) out.push(`${c.possibleDuplicates} possible duplicate payment(s)`);
  if (c.ambiguousPayments) out.push(`${c.ambiguousPayments} ambiguous payment(s)`);
  if (c.unmatchedPayments) out.push(`${c.unmatchedPayments} unmatched payment(s)`);
  if (c.amountMatches) out.push(`${c.amountMatches} payment(s) matched by amount only (check them)`);
  return out;
}
