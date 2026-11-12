# duitnow-recon

Offline CLI that matches incoming payments (a bank statement or DuitNow / transfer export saved as CSV) against the
invoices you expect to be paid, and tells you what is **paid**, **partly paid**, **overpaid**, **unpaid**, which
payments are **possible duplicates**, and which payments match **nothing**. Amounts are exact integer cents.

Built for small Malaysian businesses that take DuitNow / IBG / bank transfers and reconcile them by hand in a
spreadsheet. No network, no API keys, no runtime dependencies; it reads two local CSV files.

## Usage

```sh
npm ci && npm run build
node dist/cli.js examples/invoices.csv examples/payments.csv          # text report
node dist/cli.js examples/invoices.csv examples/payments.csv --md     # Markdown
node dist/cli.js examples/invoices.csv examples/payments.csv --json   # JSON
node dist/cli.js examples/invoices.csv examples/payments.csv --csv    # one row per invoice, for a spreadsheet
node dist/cli.js invoices.csv oct.csv nov.csv                          # several payments files, overlap removed
node dist/cli.js invoices.csv payments.csv --as-of 2026-12-31          # age what is owed to a chosen date
```

Example output (from `examples/`):

```
Invoices: 8 (3 paid, 1 partial, 1 overpaid, 3 unpaid)
Payments: 7 (5 matched, 1 ambiguous, 1 unmatched); 1 debit/zero row(s) left out
Invoiced 5,205.40, received 4,587.40, outstanding 2,060.00, overpaid 1,250.00, not matched 192.00

Invoices to check:
  Ref         Amount  Received  Status    Note
  INV-1001  1,250.00  2,500.00  overpaid  over 1,250.00
  INV-1003  2,000.00  1,000.00  partial   short 1,000.00; 2 day(s) overdue
  INV-1005     99.90     99.90  paid      by amount only
  INV-1006    760.00      0.00  unpaid    due today
  ...
Outstanding by age (as of 2026-11-12, the latest payment date):
  Age          Invoices  Outstanding
  not yet due         3     1,060.00
  1-30 days           1     1,000.00

Payments to check:
  Row  Date                Amount  Reference         Result
    5  2026-11-09 11:00  1,250.00  Payment inv 1001  -> INV-1001 (possible duplicate: already paid)
    6  2026-11-10 08:30     99.90  servis motor      -> INV-1005 (by amount only)
    8  2026-11-11 12:00    150.00  yuran november    same amount as INV-1007, INV-1008
    9  2026-11-12 09:45     42.00  DuitNow transfer  no invoice found
```

## Input

**invoices.csv**: header with `ref` and `amount`; optional `customer` and `due_date`. References must be unique
(case and separators ignored, so `INV-1` and `inv 1` are the same reference).

**payments.csv**: header with `date`, `amount` and `reference`; optional `payer` and `id` (transaction id, must be
unique, which catches a statement pasted twice). Rows with an amount of zero or below (debits, bank charges,
reversals) are left out and counted.

**Several payments files** (same columns, for example two statement exports whose date ranges overlap) can be given
after the invoices file. A row whose transaction id is already in an earlier file is left out as overlap when its
date and amount are the same, and is an input error when they differ. Rows without a transaction id are always kept
(they cannot be told apart), and the report says how many there were. Reports then name payments as `file:row`
(`nov.csv:4`); JSON adds `files`, `overlapRows` and `paymentsWithoutId`.

Every column name can be changed with a flag (`--invoice-ref`, `--payment-reference`, ... see `--help`), so an
export can be used as is. Bank export layouts differ; this tool does not guess them.

- Amounts: `1234.50`, `1,234.50`, `RM 1,234.50`, `-10.00` or `(10.00)`; at most two decimals.
- Dates: `2026-11-12` or day-first `12/11/2026` (also `12-11-2026`, `12.11.2026`), optionally followed by a time.
  Month-first dates are not supported.

## How matching works

1. **Reference.** The payment's reference text is split into words and searched for invoice references, ignoring
   case and separators: `inv 0012`, `INV0012` and `INV-0012` all match invoice `INV-0012`, but `INV-12` never
   matches `INV-1`. A payment that names several invoices pays them in the order named; money left over goes to
   the last one (reported as excess / overpaid). A payment for an invoice that is already fully paid is flagged as a
   **possible duplicate**. Payments are applied in date (then time, then row) order.
2. **Amount** (turn off with `--no-amount-match`). A payment with no reference found is matched to an invoice with
   no money yet only when that invoice is the only open one with that exact amount **and** the payment is the only
   unreferenced payment with that amount. These matches are labelled "by amount only" and always count as something
   to check. Otherwise the payment is **ambiguous** (lists the invoices with the same amount) or **unmatched**.
3. **Date window for the amount fallback** (`--amount-window <days>`, optional). Only invoices whose `due_date` is
   at most that many days before or after the payment date count as candidates, and the pairing must still be
   unique both ways inside the window. This lets two monthly RM 250.00 payments go to the October and November
   invoices instead of both being ambiguous. Invoices without a due date are then never matched by amount; the
   option needs a due date column and cannot be combined with `--no-amount-match`. Reports name the window
   (JSON `amountWindowDays`). Reference matching is never limited by date.

Short numeric references (for example `1001`) can match unrelated numbers in a reference text; use prefixed
references (`INV-1001`) where you can.

## Aging of what is still owed

When an unpaid or partly paid invoice has a `due_date` (or `--as-of` is given), the report groups what is still
owed by days past due: **not yet due**, **1-30**, **31-60**, **61-90**, **over 90 days**, and **no due date**.
Days are counted to `--as-of` (a date, `2026-12-31` or `31/12/2026`), or by default to the latest payment date in
the input, so the same files always give the same report (with no payments at all, aging needs `--as-of`).
An invoice due on the as-of day counts as not yet due.
Paid and overpaid invoices are not aged; the buckets add up to the outstanding total.

The invoice notes say `N day(s) overdue`, `due today` or `due in N day(s)`; JSON adds `aging` (as-of date, its
source, every bucket with count and amount) and `daysOverdue` per aged invoice; `--csv` adds a last column
`days_overdue`. Aging never changes the exit code (unpaid and partial invoices already give exit 1).

## Exit codes

- `0`: every invoice paid exactly and every payment matched by reference
- `1`: something to check (unpaid, partial, overpaid, possible duplicate, ambiguous, unmatched, matched by amount)
- `2`: input error (message names the file and row)

## Development

```sh
npm ci
npm run check   # lint + typecheck + tests
npm run build && npm run smoke
```

CI runs the same on Node 20 and 22. The library is exported from `src/index.ts` (`parseInvoices`,
`parsePayments`, `reconcile`, report writers).

## Limits

- Matching rules only; it does not read PDFs or bank portals and does not call any payment API.
- No fuzzy name matching on payer names (planned as an optional hint, not an automatic match).
- Not accounting advice; check flagged rows by hand.

MIT licence.
