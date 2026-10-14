/**
 * Wallos returns money in two shapes: as numbers (subscription prices) and as
 * pre-formatted display strings (`get_monthly_cost.php` answers with
 * "88,242.55" for the raw figure and "€88,242" for the localised one). Both
 * need to survive a round trip through this server without pretending to be
 * more precise than they are.
 */
export function parseMoney(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const stripped = value.replace(/[^\d.,-]/g, '').trim();
  if (stripped === '' || stripped === '-') {
    return null;
  }

  const parsed = Number(normalizeNumericString(stripped));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Resolves the two conventions for decimal and thousands separators by trusting
 * whichever separator appears last, so "1,234.56" and "1.234,56" both land on
 * the same number.
 */
function normalizeNumericString(input: string): string {
  const lastDot = input.lastIndexOf('.');
  const lastComma = input.lastIndexOf(',');

  if (lastDot !== -1 && lastComma !== -1) {
    return lastComma > lastDot
      ? input.replace(/\./g, '').replace(',', '.')
      : input.replace(/,/g, '');
  }

  if (lastComma !== -1) {
    const decimals = input.length - lastComma - 1;
    const commaCount = input.split(',').length - 1;
    if (commaCount === 1 && decimals === 2) {
      return input.replace(',', '.');
    }
    return input.replace(/,/g, '');
  }

  return input;
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
