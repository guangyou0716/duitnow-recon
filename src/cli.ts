#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addAging, latestPaymentDate } from './aging.js';
import { InputError } from './errors.js';
import { mergePayments, parseDate, parseInvoices, parsePayments } from './input.js';
import { findings, reconcile } from './reconcile.js';
import { csvReport, jsonReport, markdownReport, textReport } from './report.js';

const USAGE = `Usage: duitnow-recon <invoices.csv> <payments.csv> [more-payments.csv ...] [options]

Matches incoming payments (a bank statement or DuitNow / transfer export saved as CSV) against the invoices you
expect to be paid, and reports what is paid, partly paid, overpaid, unpaid, and which payments match nothing.
Offline; reads local files only. Amounts are handled in exact cents.

invoices.csv: header with "ref" and "amount" columns; optional "customer" and "due_date".
payments.csv: header with "date", "amount" and "reference" columns; optional "payer" and "id" (transaction id,
  must be unique). Rows with an amount of zero or below (debits, reversals) are left out and counted.
Several payments files (same columns) are merged, e.g. two exports whose dates overlap: a row whose transaction id
  is already in an earlier file is left out as overlap when date and amount agree, and is an input error when they
  differ. Rows without an id are always kept. Reports then name payments as "file:row".
Amounts: 1234.50, 1,234.50 or RM 1,234.50. Dates: 2026-11-12 or day-first 12/11/2026, optionally with a time.

Matching:
  1. Reference: the payment reference text is searched for invoice references, ignoring case and separators
     ("inv 0012", "INV0012" and "INV-0012" all match invoice INV-0012). One payment may name several invoices;
     it pays them in the order named and any extra goes to the last one. Payments are applied in date order.
  2. Amount (unless --no-amount-match): a payment with no reference found is matched to an invoice that has no
     money yet when it is the only such invoice with that exact amount and the only such payment with that amount.
     Otherwise it is reported as ambiguous (same amount as several invoices) or unmatched.

Options:
  --invoice-ref <col>       invoice reference column (default ref)
  --invoice-amount <col>    invoice amount column (default amount)
  --invoice-customer <col>  customer column (default customer, used when present)
  --invoice-due <col>       due date column (default due_date, used when present)
  --payment-date <col>      payment date column (default date)
  --payment-amount <col>    payment amount column (default amount)
  --payment-reference <col> payment reference column (default reference)
  --payment-payer <col>     payer name column (default payer, used when present)
  --payment-id <col>        transaction id column (default id, used when present)
  --no-amount-match         only match by reference
  --as-of <date>            count overdue days to this date (default: the latest payment date)
  --json | --md | --csv     report format (default text; --csv gives one row per invoice)
  -h, --help                show this help

Aging: when an invoice that still owes money has a due date (or --as-of is given), what is still owed is grouped
  by days past due: not yet due, 1-30, 31-60, 61-90, over 90 days, no due date. A due date on the as-of day counts
  as not yet due. Paid and overpaid invoices are not aged. --csv then adds a days_overdue column.

Exit codes: 0 every invoice paid exactly and every payment matched by reference, 1 anything to check
(unpaid, partial, overpaid, possible duplicate, ambiguous, unmatched, matched by amount only), 2 input error.
`;

function read(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new InputError(`Cannot read ${what} ${path}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`);
  }
}

/** Short names for payments files in reports: the base name, or the path as given when two base names clash. */
export function fileLabels(files: string[]): string[] {
  const names = files.map((f) => basename(f));
  const clash = (n: string) => names.filter((x) => x === n).length > 1;
  if (new Set(files).size !== files.length) {
    throw new InputError('The same payments file is given twice.');
  }
  return files.map((f, i) => (clash(names[i]) ? f : names[i]));
}

export function main(argv: string[]): number {
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'invoice-ref': { type: 'string' },
        'invoice-amount': { type: 'string' },
        'invoice-customer': { type: 'string' },
        'invoice-due': { type: 'string' },
        'payment-date': { type: 'string' },
        'payment-amount': { type: 'string' },
        'payment-reference': { type: 'string' },
        'payment-payer': { type: 'string' },
        'payment-id': { type: 'string' },
        'no-amount-match': { type: 'boolean', default: false },
        'as-of': { type: 'string' },
        json: { type: 'boolean', default: false },
        md: { type: 'boolean', default: false },
        csv: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      process.stdout.write(USAGE);
      return 0;
    }
    if (positionals.length < 2) {
      throw new InputError('Give at least two files: <invoices.csv> <payments.csv> [more-payments.csv ...] (see --help).');
    }
    if ([values.json, values.md, values.csv].filter(Boolean).length > 1) {
      throw new InputError('Use only one of --json, --md, --csv.');
    }
    const [invoiceFile, ...paymentFiles] = positionals;
    const invoices = parseInvoices(read(invoiceFile, 'invoices'), invoiceFile, {
      ref: values['invoice-ref'],
      amount: values['invoice-amount'],
      customer: values['invoice-customer'],
      dueDate: values['invoice-due'],
    });
    const paymentColumns = {
      date: values['payment-date'],
      amount: values['payment-amount'],
      reference: values['payment-reference'],
      payer: values['payment-payer'],
      id: values['payment-id'],
    };
    const labels = fileLabels(paymentFiles);
    const merged = mergePayments(paymentFiles.map((file, i) => ({ label: labels[i], parse: parsePayments(read(file, 'payments'), file, paymentColumns) })));
    const asOfOption = values['as-of'] === undefined ? undefined : parseDate(values['as-of'], '--as-of');
    if (asOfOption?.time) {
      throw new InputError('--as-of: give a date only (2026-11-12 or 12/11/2026), without a time.');
    }
    let rec = reconcile(invoices, merged.payments, { amountMatch: !values['no-amount-match'] });
    const owedWithDue = rec.invoices.some((inv) => inv.differenceCents < 0 && inv.dueDate !== undefined);
    if (asOfOption) {
      rec = addAging(rec, asOfOption.date, 'option');
    } else if (owedWithDue) {
      const latest = latestPaymentDate(rec);
      if (latest) rec = addAging(rec, latest, 'latest payment');
    }
    const input = { skipped: merged.skipped, overlaps: merged.overlaps, files: paymentFiles.length, withoutId: merged.withoutId };
    process.stdout.write(
      values.json ? jsonReport(rec, input) : values.md ? markdownReport(rec, input) : values.csv ? csvReport(rec) : textReport(rec, input),
    );
    return findings(rec).length ? 1 : 0;
  } catch (e) {
    if (e instanceof InputError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')) {
      process.stderr.write(`duitnow-recon: ${(e as Error).message}\n`);
      return 2;
    }
    throw e;
  }
}

function isEntryPoint(): boolean {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
