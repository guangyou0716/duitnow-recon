import { referenceKey } from './input.js';
import type { Invoice, Payment } from './input.js';
import type { Aging } from './aging.js';
import { daysPastDue } from './aging.js';

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
  /**
   * Set only when aging is added (see addAging) and the invoice still owes money and has a due date: whole days
   * past the due date (0 = due that day, negative = not yet due).
   */
  daysOverdue?: number;
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
  /**
   * Only for ambiguous and unmatched payments with a payer name: invoices that still owe money and whose customer
   * name looks like the payer (see namesMatch). A hint for a person to check; it never allocates the payment.
   * Invoices still owing exactly the payment amount come first, then input order.
   */
  payerHints?: string[];
}

export interface ReconcileOptions {
  /** Match payments without a usable reference by unique amount (default true). */
  amountMatch?: boolean;
  /**
   * Only for the amount fallback: pair a payment with an invoice only when the invoice's due date is at most this
   * many days before or after the payment date. Invoices without a due date are then never matched by amount.
   * Leave unset for no date limit.
   */
  amountWindowDays?: number;
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
  counts: Record<InvoiceStatus, number> & { unmatchedPayments: number; ambiguousPayments: number; amountMatches: number; possibleDuplicates: number; payerHints: number };
  totals: Totals;
  /** Outstanding amounts by age; present only when aging was added (see addAging). */
  aging?: Aging;
  /** The date window used for the amount fallback, in days; present only when one was set. */
  amountWindowDays?: number;
}

/** Legal-form and filler words left out when comparing payer and customer names. */
const NAME_FILLER = new Set(['SDN', 'BHD', 'BERHAD', 'PLT', 'LLP', 'LTD', 'LIMITED', 'INC', 'CO', 'COMPANY', 'CORP', 'THE', 'AND', 'M', 'SB']);

/**
 * Words of a payer or customer name for comparison: case, full-width forms and punctuation ignored,
 * "S/B", "(M)", "Sdn Bhd", "Berhad", "PLT" and similar legal-form words left out.
 */
export function nameWords(name: string): string[] {
  return name
    .normalize('NFKC')
    .toUpperCase()
    .replace(/\bS\s*\/\s*B\b/gu, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w !== '' && !NAME_FILLER.has(w));
}

/**
 * True when two names look like the same party: the same words in the same order, or one is the start of the other
 * (bank exports often cut payer names short), where the shorter one has at least two words and its last word may
 * itself be cut short. A single word must match a single word exactly, so "TAN" alone never matches "TAN AH KOW".
 */
export function namesMatch(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.length === 1) return long.length === 1 && short[0] === long[0];
  for (let i = 0; i < short.length - 1; i++) if (short[i] !== long[i]) return false;
  const last = short.length - 1;
  return long[last].startsWith(short[last]);
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
  if (options.amountWindowDays !== undefined && !(Number.isInteger(options.amountWindowDays) && options.amountWindowDays >= 0)) {
    throw new RangeError('amountWindowDays must be a whole number of days, 0 or more');
  }
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

  // Pass 2: unreferenced payments matched by amount, only when the pairing is unique both ways (within the date
  // window when one is set).
  const window = options.amountWindowDays;
  const openByAmount = new Map<number, Invoice[]>();
  for (const inv of invoices) {
    if (received.get(inv) !== 0) continue;
    const list = openByAmount.get(inv.amountCents);
    if (list) list.push(inv);
    else openByAmount.set(inv.amountCents, [inv]);
  }
  // With a window: per amount, the invoices that have a due date sorted by due day, so each payment's candidates
  // are one contiguous slice found by binary search (input order kept inside the slice for stable output).
  const dueDay = (isoDate: string) => daysPastDue('1970-01-01', isoDate);
  const datedByAmount = new Map<number, { day: number; inv: Invoice; i: number }[]>();
  if (window !== undefined) {
    for (const [amount, list] of openByAmount) {
      const dated = list.flatMap((inv, i) => (inv.dueDate === undefined ? [] : [{ day: dueDay(inv.dueDate), inv, i }]));
      dated.sort((a, b) => a.day - b.day || a.i - b.i);
      datedByAmount.set(amount, dated);
    }
  }
  const firstAtOrAfter = (xs: { day: number }[], day: number) => {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid].day < day) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const candidatesOf = new Map<Payment, Invoice[]>();
  const claims = new Map<Invoice, number>();
  for (const p of unreferenced) {
    let candidates: Invoice[];
    if (window === undefined) {
      candidates = openByAmount.get(p.amountCents) ?? [];
    } else {
      const dated = datedByAmount.get(p.amountCents) ?? [];
      const day = dueDay(p.date);
      candidates = dated.slice(firstAtOrAfter(dated, day - window), firstAtOrAfter(dated, day + window + 1)).sort((a, b) => a.i - b.i).map((x) => x.inv);
    }
    candidatesOf.set(p, candidates);
    for (const inv of candidates) claims.set(inv, (claims.get(inv) ?? 0) + 1);
  }
  for (const p of unreferenced) {
    const r = base(p);
    results.set(p, r);
    if (!amountMatch) continue;
    const candidates = candidatesOf.get(p)!;
    if (candidates.length === 1 && claims.get(candidates[0]) === 1) {
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
  addPayerHints(invoices, invoiceResults, paymentResults);

  const counts = { paid: 0, partial: 0, overpaid: 0, unpaid: 0, unmatchedPayments: 0, ambiguousPayments: 0, amountMatches: 0, possibleDuplicates: 0, payerHints: 0 };
  for (const inv of invoiceResults) counts[inv.status]++;
  for (const p of paymentResults) {
    if (p.status === 'unmatched') counts.unmatchedPayments++;
    if (p.status === 'ambiguous') counts.ambiguousPayments++;
    if (p.method === 'amount') counts.amountMatches++;
    if (p.possibleDuplicate) counts.possibleDuplicates++;
    if (p.payerHints) counts.payerHints++;
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
  const rec: Reconciliation = { invoices: invoiceResults, payments: paymentResults, counts, totals };
  if (window !== undefined && amountMatch) rec.amountWindowDays = window;
  return rec;
}

type NameCandidate = { words: string[]; res: InvoiceResult; i: number };

/**
 * Sets payerHints on ambiguous and unmatched payments that have a payer name. Customers with one name word are
 * looked up exactly; customers with more words are grouped by first word and sorted by second word, so a payer only
 * meets customers whose second word starts with the payer's (binary search) or is a start of it (direct lookups).
 * namesMatch then decides. Results are cached per payer name.
 */
function addPayerHints(invoices: Invoice[], invoiceResults: InvoiceResult[], payments: PaymentResult[]): void {
  const single = new Map<string, NameCandidate[]>();
  const multi = new Map<string, { sorted: NameCandidate[]; bySecond: Map<string, NameCandidate[]> }>();
  invoiceResults.forEach((res, i) => {
    const customer = invoices[i].customer;
    if (customer === undefined || res.differenceCents >= 0) return;
    const words = nameWords(customer);
    if (words.length === 0) return;
    const c = { words, res, i };
    if (words.length === 1) {
      const list = single.get(words[0]);
      if (list) list.push(c);
      else single.set(words[0], [c]);
      return;
    }
    let group = multi.get(words[0]);
    if (!group) multi.set(words[0], (group = { sorted: [], bySecond: new Map() }));
    group.sorted.push(c);
    const list = group.bySecond.get(words[1]);
    if (list) list.push(c);
    else group.bySecond.set(words[1], [c]);
  });
  for (const group of multi.values()) group.sorted.sort((a, b) => (a.words[1] < b.words[1] ? -1 : a.words[1] > b.words[1] ? 1 : 0));

  const candidates = (words: string[]): NameCandidate[] => {
    if (words.length === 1) return single.get(words[0]) ?? [];
    const group = multi.get(words[0]);
    if (!group) return [];
    const second = words[1];
    const found: NameCandidate[] = [];
    let lo = 0;
    let hi = group.sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (group.sorted[mid].words[1] < second) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < group.sorted.length && group.sorted[k].words[1].startsWith(second); k++) found.push(group.sorted[k]);
    for (let len = 1; len < second.length; len++) found.push(...(group.bySecond.get(second.slice(0, len)) ?? []));
    return found;
  };

  const cache = new Map<string, NameCandidate[]>();
  for (const p of payments) {
    if (p.status === 'matched' || p.payer === undefined) continue;
    const words = nameWords(p.payer);
    if (words.length === 0) continue;
    const key = words.join(' ');
    let hits = cache.get(key);
    if (!hits) {
      hits = candidates(words).filter((c) => namesMatch(words, c.words));
      cache.set(key, hits);
    }
    if (hits.length === 0) continue;
    const exact = (c: NameCandidate) => (-c.res.differenceCents === p.amountCents ? 0 : 1);
    p.payerHints = [...hits].sort((a, b) => exact(a) - exact(b) || a.i - b.i).map((c) => c.res.ref);
  }
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
