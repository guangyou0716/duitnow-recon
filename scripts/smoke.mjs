#!/usr/bin/env node
// End-to-end check of the built CLI (dist/cli.js), run directly and through a symlink like an npm bin.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const inv = join(root, 'examples', 'invoices.csv');
const pay = join(root, 'examples', 'payments.csv');
const fail = (message) => {
  console.error(`smoke: FAIL ${message}`);
  process.exit(1);
};
const run = (bin, args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

const dir = mkdtempSync(join(tmpdir(), 'recon-smoke-'));
const link = join(dir, 'duitnow-recon');
symlinkSync(cli, link);
for (const bin of [cli, link]) {
  const res = run(bin, [inv, pay, '--json']);
  const data = res.stdout ? JSON.parse(res.stdout) : {};
  const c = data.counts ?? {};
  if (res.status !== 1 || c.paid !== 3 || c.partial !== 1 || c.overpaid !== 1 || c.unpaid !== 3 || c.possibleDuplicates !== 1 || data.totals?.outstanding !== '2060.00') {
    fail(`example via ${bin}: status ${res.status} ${JSON.stringify(c)} ${res.stderr}`);
  }
}
console.log('smoke: ok example (direct and via symlink) 3 paid, 1 partial, 1 overpaid, 3 unpaid, 1 possible duplicate, exit 1');

// 20,000 invoices; 19,000 paid by reference (every 10th in two halves), 500 by unique amount, 500 unpaid.
const invRows = ['ref,amount'];
const payRows = ['date,amount,reference,id'];
let tx = 0;
for (let i = 0; i < 20000; i++) {
  const cents = 10000 + i; // unique amounts
  const amount = `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
  invRows.push(`INV-${String(i).padStart(6, '0')},${amount}`);
  const day = `2026-11-${String(1 + (i % 28)).padStart(2, '0')}`;
  if (i < 19000) {
    if (i % 10 === 0) {
      const half = Math.floor(cents / 2);
      payRows.push(`${day},${(half / 100).toFixed(2)},inv ${String(i).padStart(6, '0')} part 1,T${tx++}`);
      payRows.push(`${day},${((cents - half) / 100).toFixed(2)},INV${String(i).padStart(6, '0')} part 2,T${tx++}`);
    } else {
      payRows.push(`${day},${amount},Payment for INV-${String(i).padStart(6, '0')},T${tx++}`);
    }
  } else if (i < 19500) {
    payRows.push(`${day},${amount},DuitNow transfer,T${tx++}`);
  }
}
const bigInv = join(dir, 'inv.csv');
const bigPay = join(dir, 'pay.csv');
writeFileSync(bigInv, `${invRows.join('\n')}\n`);
writeFileSync(bigPay, `${payRows.join('\n')}\n`);
const started = Date.now();
const res = run(cli, [bigInv, bigPay, '--json']);
const data = res.stdout ? JSON.parse(res.stdout) : {};
const c = data.counts ?? {};
if (res.status !== 1 || c.paid !== 19500 || c.unpaid !== 500 || c.amountMatches !== 500 || c.unmatchedPayments !== 0 || c.partial !== 0 || data.totals?.unmatched !== '0.00') {
  fail(`large run: status ${res.status} ${JSON.stringify(c)} ${res.stderr}`);
}
console.log(`smoke: ok 20,000 invoices / ${payRows.length - 1} payments in ${Date.now() - started} ms (19,500 paid incl. 500 by amount, 500 unpaid)`);

// The same payments split into two exports that overlap by 2,000 rows: same result, overlap reported.
const body = payRows.slice(1);
const cut = Math.floor(body.length / 2);
const partA = join(dir, 'pay-a.csv');
const partB = join(dir, 'pay-b.csv');
writeFileSync(partA, `${[payRows[0], ...body.slice(0, cut + 1000)].join('\n')}\n`);
writeFileSync(partB, `${[payRows[0], ...body.slice(cut - 1000)].join('\n')}\n`);
const split = run(cli, [bigInv, partA, partB, '--json']);
const sd = split.stdout ? JSON.parse(split.stdout) : {};
if (split.status !== 1 || JSON.stringify(sd.counts) !== JSON.stringify(c) || JSON.stringify(sd.totals) !== JSON.stringify(data.totals) || sd.overlapRows?.length !== 2000) {
  fail(`split run: status ${split.status} ${JSON.stringify(sd.counts)} overlaps ${sd.overlapRows?.length} ${split.stderr}`);
}
console.log('smoke: ok same payments in two overlapping files -> same counts and totals, 2,000 overlapping rows left out');

const bad = run(cli, [inv]);
if (bad.status !== 2 || !bad.stderr.includes('Give at least two files')) {
  fail(`one file: status ${bad.status} ${bad.stderr}`);
}
console.log('smoke: ok one file -> exit 2');
