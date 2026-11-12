#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { InputError } from './errors.js';
import { parseInvoices, parsePayments } from './input.js';
import { findings, reconcile } from './reconcile.js';
import { csvReport, jsonReport, markdownReport, textReport } from './report.js';

const USAGE = `Usage: duitnow-recon <invoices.csv> <payments.csv> [options]

Matches incoming payments (a bank statement or DuitNow / transfer export saved as CSV) against the invoices you
expect to be paid, and reports what is paid, partly paid, overpaid, unpaid, and which payments match nothing.
Offline; reads two local files. Amounts are handled in exact cents.

invoices.csv: header with "ref" and "amount" columns; optional "customer" and "due_date".
payments.csv: header with "date", "amount" and "reference" columns; optional "payer" and "id" (transaction id,
  must be unique). Rows with an amount of zero or below (debits, reversals) are left out and counted.
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
  --json | --md | --csv     report format (default text; --csv gives one row per invoice)
  -h, --help                show this help

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
    if (positionals.length !== 2) {
      throw new InputError('Give two files: <invoices.csv> <payments.csv> (see --help).');
    }
    if ([values.json, values.md, values.csv].filter(Boolean).length > 1) {
      throw new InputError('Use only one of --json, --md, --csv.');
    }
    const [invoiceFile, paymentFile] = positionals;
    const invoices = parseInvoices(read(invoiceFile, 'invoices'), invoiceFile, {
      ref: values['invoice-ref'],
      amount: values['invoice-amount'],
      customer: values['invoice-customer'],
      dueDate: values['invoice-due'],
    });
    const { payments, skipped } = parsePayments(read(paymentFile, 'payments'), paymentFile, {
      date: values['payment-date'],
      amount: values['payment-amount'],
      reference: values['payment-reference'],
      payer: values['payment-payer'],
      id: values['payment-id'],
    });
    const rec = reconcile(invoices, payments, { amountMatch: !values['no-amount-match'] });
    process.stdout.write(
      values.json ? jsonReport(rec, skipped) : values.md ? markdownReport(rec, skipped.length) : values.csv ? csvReport(rec) : textReport(rec, skipped.length),
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
