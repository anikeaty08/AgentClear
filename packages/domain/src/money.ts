const DECIMAL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/;

export function decimalToBaseUnits(value: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RangeError('Token decimals must be an integer between 0 and 36.');
  }

  const match = DECIMAL_AMOUNT.exec(value);
  if (match === null) {
    throw new TypeError('Amount must be a non-negative decimal string without exponent notation.');
  }

  const [whole = '0', fraction = ''] = value.split('.');
  if (fraction.length > decimals) {
    throw new RangeError(`Amount has more than ${decimals} decimal places.`);
  }

  const combined = `${whole}${fraction.padEnd(decimals, '0')}`.replace(/^0+(?=\d)/, '');
  const baseUnits = BigInt(combined);
  if (baseUnits <= 0n) {
    throw new RangeError('Amount must be greater than zero.');
  }

  return baseUnits.toString();
}

