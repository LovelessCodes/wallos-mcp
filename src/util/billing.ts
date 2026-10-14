import { WallosConfigError } from '../errors.js';

/** Wallos stores a repeat interval as a cycle unit plus a frequency. */
export const CYCLE_DAYS = 1;
export const CYCLE_WEEKS = 2;
export const CYCLE_MONTHS = 3;
export const CYCLE_YEARS = 4;

export type Cycle = 1 | 2 | 3 | 4;

export interface Billing {
  cycle: Cycle;
  frequency: number;
}

const NAMED_PERIODS: Record<string, Billing> = {
  daily: { cycle: CYCLE_DAYS, frequency: 1 },
  day: { cycle: CYCLE_DAYS, frequency: 1 },
  weekly: { cycle: CYCLE_WEEKS, frequency: 1 },
  week: { cycle: CYCLE_WEEKS, frequency: 1 },
  biweekly: { cycle: CYCLE_WEEKS, frequency: 2 },
  fortnightly: { cycle: CYCLE_WEEKS, frequency: 2 },
  monthly: { cycle: CYCLE_MONTHS, frequency: 1 },
  month: { cycle: CYCLE_MONTHS, frequency: 1 },
  bimonthly: { cycle: CYCLE_MONTHS, frequency: 2 },
  quarterly: { cycle: CYCLE_MONTHS, frequency: 3 },
  quarter: { cycle: CYCLE_MONTHS, frequency: 3 },
  semiannually: { cycle: CYCLE_MONTHS, frequency: 6 },
  'semi-annually': { cycle: CYCLE_MONTHS, frequency: 6 },
  biannually: { cycle: CYCLE_MONTHS, frequency: 6 },
  yearly: { cycle: CYCLE_YEARS, frequency: 1 },
  annually: { cycle: CYCLE_YEARS, frequency: 1 },
  annual: { cycle: CYCLE_YEARS, frequency: 1 },
  year: { cycle: CYCLE_YEARS, frequency: 1 },
};

const UNIT_TO_CYCLE: Record<string, Cycle> = {
  day: CYCLE_DAYS,
  days: CYCLE_DAYS,
  week: CYCLE_WEEKS,
  weeks: CYCLE_WEEKS,
  month: CYCLE_MONTHS,
  months: CYCLE_MONTHS,
  year: CYCLE_YEARS,
  years: CYCLE_YEARS,
};

const EVERY = /^every\s+(\d+)\s*([a-z]+)$/i;

/**
 * Accepts a human description of a billing period and returns the cycle and
 * frequency Wallos wants. `monthly`, `quarterly`, `biweekly`, `every 3 months`
 * and the raw Wallos pair all end up in the same place.
 */
export function parseBillingPeriod(input: string): Billing | null {
  const normalized = input.trim().toLowerCase().replace(/\s+/g, ' ');
  if (normalized === '') return null;

  const named = NAMED_PERIODS[normalized];
  if (named !== undefined) return named;

  const every = EVERY.exec(normalized);
  if (every !== null) {
    const count = Number(every[1]);
    const unit = every[2] ?? '';
    const cycle = UNIT_TO_CYCLE[unit];
    if (cycle !== undefined && Number.isInteger(count) && count > 0) {
      return { cycle, frequency: count };
    }
  }

  return null;
}

export function describeBilling(cycle: number, frequency: number): string {
  switch (cycle) {
    case CYCLE_DAYS:
      return frequency === 1 ? 'daily' : `every ${frequency} days`;
    case CYCLE_WEEKS:
      if (frequency === 1) return 'weekly';
      if (frequency === 2) return 'biweekly';
      return `every ${frequency} weeks`;
    case CYCLE_MONTHS:
      if (frequency === 1) return 'monthly';
      if (frequency === 3) return 'quarterly';
      if (frequency === 6) return 'semiannually';
      return `every ${frequency} months`;
    case CYCLE_YEARS:
      return frequency === 1 ? 'yearly' : `every ${frequency} years`;
    default:
      return `every ${frequency} units (cycle ${cycle})`;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real calendar date in YYYY-MM-DD form. Wallos rejects anything else. */
export function isIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function todayIso(now: Date = new Date()): string {
  return toIsoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
}

function parseIso(value: string): Date {
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Adds whole periods, counting from the original day of the month so a
 * subscription that started on the 31st stays on the 31st in long months and
 * clamps only where the month is too short.
 */
export function addPeriods(iso: string, cycle: Cycle, frequency: number, times: number): string {
  const base = parseIso(iso);

  if (cycle === CYCLE_DAYS) {
    return toIsoDate(new Date(base.getTime() + times * frequency * 86_400_000));
  }

  if (cycle === CYCLE_WEEKS) {
    return toIsoDate(new Date(base.getTime() + times * frequency * 7 * 86_400_000));
  }

  const monthsToAdd = cycle === CYCLE_MONTHS ? times * frequency : times * frequency * 12;
  const dayOfMonth = base.getUTCDate();
  const target = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + monthsToAdd, 1));
  const lastDayOfTargetMonth = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(dayOfMonth, lastDayOfTargetMonth));
  return toIsoDate(target);
}

/**
 * Wallos wants a `next_payment` and a subscription whose next payment is behind
 * us is wrong data, so when the caller does not supply one it is derived by
 * advancing the start date whole periods until it lands on or after today.
 */
export function deriveNextPayment(
  startIso: string,
  billing: Billing,
  fromIso: string = todayIso(),
): string {
  let candidate = startIso;
  let periods = 0;
  const limit = 5000;

  while (candidate < fromIso) {
    periods += 1;
    if (periods > limit) {
      throw new WallosConfigError(
        `Could not derive a next payment date from ${startIso} with ${describeBilling(billing.cycle, billing.frequency)}.`,
      );
    }
    candidate = addPeriods(startIso, billing.cycle, billing.frequency, periods);
  }

  return candidate;
}
