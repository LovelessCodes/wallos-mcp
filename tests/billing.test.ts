import { describe, expect, it } from 'vitest';
import {
  addPeriods,
  CYCLE_DAYS,
  CYCLE_MONTHS,
  CYCLE_WEEKS,
  CYCLE_YEARS,
  deriveNextPayment,
  describeBilling,
  isIsoDate,
  parseBillingPeriod,
} from '../src/util/billing.js';

describe('parseBillingPeriod', () => {
  it('reads the usual names', () => {
    expect(parseBillingPeriod('monthly')).toEqual({ cycle: 3, frequency: 1 });
    expect(parseBillingPeriod('Quarterly')).toEqual({ cycle: 3, frequency: 3 });
    expect(parseBillingPeriod('yearly')).toEqual({ cycle: 4, frequency: 1 });
    expect(parseBillingPeriod('biweekly')).toEqual({ cycle: 2, frequency: 2 });
    expect(parseBillingPeriod('fortnightly')).toEqual({ cycle: 2, frequency: 2 });
    expect(parseBillingPeriod('semiannually')).toEqual({ cycle: 3, frequency: 6 });
  });

  it('reads "every N units"', () => {
    expect(parseBillingPeriod('every 3 months')).toEqual({ cycle: 3, frequency: 3 });
    expect(parseBillingPeriod('every 10 days')).toEqual({ cycle: 1, frequency: 10 });
    expect(parseBillingPeriod('Every  2  Weeks')).toEqual({ cycle: 2, frequency: 2 });
    expect(parseBillingPeriod('every 2 years')).toEqual({ cycle: 4, frequency: 2 });
  });

  it('rejects what it cannot read', () => {
    expect(parseBillingPeriod('')).toBeNull();
    expect(parseBillingPeriod('whenever')).toBeNull();
    expect(parseBillingPeriod('every 0 months')).toBeNull();
    expect(parseBillingPeriod('every months')).toBeNull();
  });
});

describe('describeBilling', () => {
  it('names the common intervals and falls back to a description', () => {
    expect(describeBilling(3, 1)).toBe('monthly');
    expect(describeBilling(3, 3)).toBe('quarterly');
    expect(describeBilling(2, 2)).toBe('biweekly');
    expect(describeBilling(1, 5)).toBe('every 5 days');
    expect(describeBilling(99, 2)).toBe('every 2 units (cycle 99)');
  });
});

describe('isIsoDate', () => {
  it('accepts real dates only', () => {
    expect(isIsoDate('2026-03-15')).toBe(true);
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-04-31')).toBe(false);
    expect(isIsoDate('15-03-2026')).toBe(false);
    expect(isIsoDate('2026-3-5')).toBe(false);
  });
});

describe('addPeriods', () => {
  it('adds days and weeks exactly', () => {
    expect(addPeriods('2026-03-15', CYCLE_DAYS, 10, 1)).toBe('2026-03-25');
    expect(addPeriods('2026-03-15', CYCLE_WEEKS, 2, 1)).toBe('2026-03-29');
  });

  it('counts months from the original day, clamping only where the month is short', () => {
    // Wallos bills a 31st subscription on the 30th in November and back to the
    // 31st in December, so the day of the month is not simply preserved.
    expect(addPeriods('2026-01-31', CYCLE_MONTHS, 1, 1)).toBe('2026-02-28');
    expect(addPeriods('2026-01-31', CYCLE_MONTHS, 1, 2)).toBe('2026-03-31');
    expect(addPeriods('2024-01-31', CYCLE_MONTHS, 1, 1)).toBe('2024-02-29');
    expect(addPeriods('2026-08-31', CYCLE_MONTHS, 1, 3)).toBe('2026-11-30');
  });

  it('adds years, including across a leap day', () => {
    expect(addPeriods('2024-02-29', CYCLE_YEARS, 1, 1)).toBe('2025-02-28');
    expect(addPeriods('2024-02-29', CYCLE_YEARS, 1, 4)).toBe('2028-02-29');
  });
});

describe('deriveNextPayment', () => {
  it('keeps a future start date as-is', () => {
    expect(deriveNextPayment('2026-06-01', { cycle: 3, frequency: 1 }, '2026-03-15')).toBe('2026-06-01');
  });

  it('advances a past start date into the future', () => {
    expect(deriveNextPayment('2024-01-15', { cycle: 3, frequency: 1 }, '2026-03-15')).toBe('2026-03-15');
    expect(deriveNextPayment('2026-02-20', { cycle: 3, frequency: 1 }, '2026-03-15')).toBe('2026-03-20');
  });

  it('treats today as due today rather than pushing it out a period', () => {
    expect(deriveNextPayment('2026-03-15', { cycle: 3, frequency: 1 }, '2026-03-15')).toBe('2026-03-15');
  });

  it('handles a start date on the 31st', () => {
    expect(deriveNextPayment('2026-01-31', { cycle: 3, frequency: 1 }, '2026-03-15')).toBe('2026-03-31');
    expect(deriveNextPayment('2026-01-31', { cycle: 3, frequency: 1 }, '2026-03-31')).toBe('2026-03-31');
  });

  it('handles daily and yearly periods', () => {
    expect(deriveNextPayment('2026-03-01', { cycle: 1, frequency: 1 }, '2026-03-15')).toBe('2026-03-15');
    expect(deriveNextPayment('2020-05-05', { cycle: 4, frequency: 1 }, '2026-03-15')).toBe('2026-05-05');
  });
});
