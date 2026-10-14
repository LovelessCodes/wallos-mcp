import { describe, expect, it } from 'vitest';
import { parseMoney } from '../src/util/money.js';

describe('parseMoney', () => {
  it('passes numbers through', () => {
    expect(parseMoney(15.99)).toBe(15.99);
    expect(parseMoney(0)).toBe(0);
    expect(parseMoney(-4.5)).toBe(-4.5);
  });

  it('reads the thousands-separated strings Wallos returns for monthly cost', () => {
    // get_monthly_cost.php answers with number_format($total, 2), which groups
    // thousands: "88,242.55". That is not a number until it is parsed.
    expect(parseMoney('88,242.55')).toBe(88242.55);
    expect(parseMoney('1,234.56')).toBe(1234.56);
    expect(parseMoney('120.24')).toBe(120.24);
    expect(parseMoney('0.00')).toBe(0);
  });

  it('strips currency decoration from localised totals', () => {
    expect(parseMoney('€1,235')).toBe(1235);
    expect(parseMoney('$1,234.56')).toBe(1234.56);
    expect(parseMoney('¥88,243')).toBe(88243);
  });

  it('handles the European convention when the separators say so', () => {
    expect(parseMoney('1.234,56')).toBe(1234.56);
    expect(parseMoney('88.242,55')).toBe(88242.55);
  });

  it('treats a lone comma with two decimals as a decimal point', () => {
    expect(parseMoney('1234,56')).toBe(1234.56);
    expect(parseMoney('1,234,567')).toBe(1234567);
  });

  it('returns null for anything that is not money', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('   ')).toBeNull();
    expect(parseMoney('-')).toBeNull();
    expect(parseMoney('free')).toBeNull();
    expect(parseMoney(null)).toBeNull();
    expect(parseMoney(undefined)).toBeNull();
    expect(parseMoney({})).toBeNull();
    expect(parseMoney(Number.NaN)).toBeNull();
  });
});
