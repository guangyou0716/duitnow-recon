import { parseCsv } from './csv.js';
import { InputError } from './errors.js';
import { parseCents } from './money.js';

export interface Invoice {
  /** The reference as written in the file. */
  ref: string;
  /** The reference with case and separators removed, used for matching. */
  key: string;
  amountCents: number;
  /** Optional extra columns kept for the report. */
  customer?: string;
  dueDate?: string;
  /** 1-based data row number (header is row 1, so the first invoice is row 2). */
  row: number;
}

export interface Payment {
  /** Date as YYYY-MM-DD (time, if any, kept in `time`). */
  date: string;
  time?: string;
  amountCents: number;
  reference: string;
  payer?: string;
  id?: string;
  row: number;
  /** Which payments file the row came from; set only when several payments files are merged. */
  source?: string;
}

export interface InvoiceColumns {
  ref?: string;
  amount?: string;
  customer?: string;
  dueDate?: string;
}

export interface PaymentColumns {
  date?: string;
  amount?: string;
  reference?: string;
  payer?: string;
  id?: string;
}

/** Upper-case and drop everything that is not a letter or digit: "inv-0012" and "INV 0012" both become "INV0012". */
export function referenceKey(text: string): string {
  return text.normalize('NFKC').toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function header(rows: string[][], file: string): Map<string, number> {
  if (rows.length === 0) {
    throw new InputError(`${file}: the file is empty.`);
  }
  const map = new Map<string, number>();
  rows[0].forEach((name, i) => {
    const key = name.trim().toLowerCase();
    if (map.has(key)) {
      throw new InputError(`${file}: column "${name.trim()}" appears twice in the header.`);
    }
    map.set(key, i);
  });
  return map;
}

function column(map: Map<string, number>, name: string, file: string, flag: string): number {
  const index = map.get(name.trim().toLowerCase());
  if (index === undefined) {
    throw new InputError(`${file}: no "${name}" column (found: ${[...map.keys()].join(', ')}). Set it with ${flag}.`);
  }
  return index;
}

function optionalColumn(map: Map<string, number>, name: string | undefined, fallback: string, file: string, flag: string): number | undefined {
  if (name !== undefined) {
    return column(map, name, file, flag);
  }
  return map.get(fallback);
}

const cell = (row: string[], index: number | undefined) => (index === undefined ? undefined : (row[index] ?? '').trim());

export function parseInvoices(text: string, file = 'invoices', cols: InvoiceColumns = {}): Invoice[] {
  const rows = parseCsv(text);
  const map = header(rows, file);
  const refCol = column(map, cols.ref ?? 'ref', file, '--invoice-ref');
  const amountCol = column(map, cols.amount ?? 'amount', file, '--invoice-amount');
  const customerCol = optionalColumn(map, cols.customer, 'customer', file, '--invoice-customer');
  const dueCol = optionalColumn(map, cols.dueDate, 'due_date', file, '--invoice-due');
  const invoices: Invoice[] = [];
  const seen = new Map<string, Invoice>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const where = `${file} row ${r + 1}`;
    const ref = cell(row, refCol) ?? '';
    const key = referenceKey(ref);
    if (key === '') {
      throw new InputError(`${where}: the invoice reference is empty.`);
    }
    const amountCents = parseCents(cell(row, amountCol) ?? '', where);
    if (amountCents <= 0) {
      throw new InputError(`${where}: the invoice amount must be more than zero.`);
    }
    const earlier = seen.get(key);
    if (earlier) {
      throw new InputError(`${where}: reference "${ref}" is the same as "${earlier.ref}" on row ${earlier.row} (case and separators are ignored).`);
    }
    const invoice: Invoice = { ref, key, amountCents, row: r + 1 };
    const customer = cell(row, customerCol);
    if (customer) invoice.customer = customer;
    const due = cell(row, dueCol);
    if (due) invoice.dueDate = parseDate(due, where).date;
    seen.set(key, invoice);
    invoices.push(invoice);
  }
  if (invoices.length === 0) {
    throw new InputError(`${file}: no invoice rows.`);
  }
  return invoices;
}

/**
 * Dates: ISO "2026-11-12" (optionally followed by a time, "T" or space separated) or day-first "12/11/2026"
 * (also "12-11-2026" and "12.11.2026"), optionally followed by a time. Month-first dates are not supported.
 */
export function parseDate(raw: string, where: string): { date: string; time?: string } {
  const text = raw.trim();
  let y: number, m: number, d: number, rest: string;
  let match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](.+))?$/.exec(text);
  if (match) {
    [y, m, d, rest] = [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''];
  } else {
    match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ]+(.+))?$/.exec(text);
    if (!match) {
      throw new InputError(`${where}: "${raw}" is not a date (use 2026-11-12 or day-first 12/11/2026).`);
    }
    [d, m, y, rest] = [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ''];
  }
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new InputError(`${where}: "${raw}" is not a real calendar date.`);
  }
  const date = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  // Pad a one-digit hour ("9:05" -> "09:05") so times on the same day sort correctly as text.
  const time = rest.trim().replace(/^(\d)(?=:)/, '0$1');
  return time ? { date, time } : { date };
}

export interface SkippedRow {
  row: number;
  amountCents: number;
  /** Set only when several payments files are merged. */
  source?: string;
}

export interface PaymentParse {
  payments: Payment[];
  /** Data rows with an amount of zero or below (debits, reversals) that were left out. */
  skipped: SkippedRow[];
}

export function parsePayments(text: string, file = 'payments', cols: PaymentColumns = {}): PaymentParse {
  const rows = parseCsv(text);
  const map = header(rows, file);
  const dateCol = column(map, cols.date ?? 'date', file, '--payment-date');
  const amountCol = column(map, cols.amount ?? 'amount', file, '--payment-amount');
  const refCol = column(map, cols.reference ?? 'reference', file, '--payment-reference');
  const payerCol = optionalColumn(map, cols.payer, 'payer', file, '--payment-payer');
  const idCol = optionalColumn(map, cols.id, 'id', file, '--payment-id');
  const payments: Payment[] = [];
  const skipped: SkippedRow[] = [];
  const ids = new Map<string, number>();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const where = `${file} row ${r + 1}`;
    const { date, time } = parseDate(cell(row, dateCol) ?? '', where);
    const amountCents = parseCents(cell(row, amountCol) ?? '', where);
    if (amountCents <= 0) {
      skipped.push({ row: r + 1, amountCents });
      continue;
    }
    const payment: Payment = { date, amountCents, reference: cell(row, refCol) ?? '', row: r + 1 };
    if (time) payment.time = time;
    const payer = cell(row, payerCol);
    if (payer) payment.payer = payer;
    const id = cell(row, idCol);
    if (id) {
      const earlier = ids.get(id);
      if (earlier !== undefined) {
        throw new InputError(`${where}: transaction id "${id}" already appears on row ${earlier} (is the statement exported twice?).`);
      }
      ids.set(id, r + 1);
      payment.id = id;
    }
    payments.push(payment);
  }
  return { payments, skipped };
}

/** A payment row left out because an earlier file already has the same transaction id, date and amount. */
export interface OverlapRow {
  source: string;
  row: number;
  id: string;
  keptSource: string;
  keptRow: number;
}

export interface MergedPayments extends PaymentParse {
  /** Rows dropped as overlap between files (same transaction id, date and amount as a row in an earlier file). */
  overlaps: OverlapRow[];
  /** Payments without a transaction id; overlap between files cannot be checked for them. */
  withoutId: number;
}

/**
 * Merges payments from several files (for example two statement exports whose date ranges overlap). Each file is
 * parsed on its own first, so a repeated transaction id inside one file is still an input error. A row whose
 * transaction id already appeared in an earlier file is dropped as overlap when the date and amount are the same,
 * and is an input error when they differ. Rows without a transaction id are always kept.
 * With a single file nothing is labelled, so the result is the same as parsePayments.
 */
export function mergePayments(files: { label: string; parse: PaymentParse }[]): MergedPayments {
  if (files.length === 1) {
    const { payments, skipped } = files[0].parse;
    return { payments, skipped, overlaps: [], withoutId: payments.filter((p) => !p.id).length };
  }
  const payments: Payment[] = [];
  const skipped: SkippedRow[] = [];
  const overlaps: OverlapRow[] = [];
  const byId = new Map<string, Payment>();
  let withoutId = 0;
  for (const { label, parse } of files) {
    for (const s of parse.skipped) skipped.push({ ...s, source: label });
    const added: Payment[] = [];
    for (const p of parse.payments) {
      const payment: Payment = { ...p, source: label };
      if (!payment.id) {
        withoutId++;
        payments.push(payment);
        continue;
      }
      const earlier = byId.get(payment.id);
      if (earlier) {
        if (earlier.date !== payment.date || earlier.amountCents !== payment.amountCents) {
          throw new InputError(`${label} row ${payment.row}: transaction id "${payment.id}" is also on ${earlier.source} row ${earlier.row} with a different date or amount.`);
        }
        overlaps.push({ source: label, row: payment.row, id: payment.id, keptSource: earlier.source!, keptRow: earlier.row });
        continue;
      }
      added.push(payment);
      payments.push(payment);
    }
    // Register after the whole file so ids are only compared against earlier files.
    for (const p of added) byId.set(p.id!, p);
  }
  return { payments, skipped, overlaps, withoutId };
}
