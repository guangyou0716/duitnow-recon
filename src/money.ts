import { InputError } from './errors.js';

/**
 * Parses a money amount into integer cents without floating point.
 * Accepts an optional "RM"/"MYR" prefix, thousands separators ("1,234.50"), and up to two decimals.
 * A leading minus or surrounding parentheses mean a negative amount.
 */
export function parseCents(raw: string, where: string): number {
  let text = raw.trim();
  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1).trim();
  }
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1).trim();
  }
  text = text.replace(/^(RM|MYR)\s*/i, '');
  if (text.startsWith('-')) {
    negative = !negative;
    text = text.slice(1).trim();
  }
  const match = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new InputError(`${where}: "${raw}" is not an amount (use 1234.50, 1,234.50 or RM 1,234.50; at most 2 decimals).`);
  }
  const whole = Number(match[1].replace(/,/g, ''));
  const cents = whole * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) {
    throw new InputError(`${where}: "${raw}" is too large.`);
  }
  return negative ? -cents : cents;
}

/** Formats integer cents as "1,234.50" (with a leading minus when negative). */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** Formats integer cents as a plain decimal "1234.50" for JSON and CSV. */
export function plainCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
