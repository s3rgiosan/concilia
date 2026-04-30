const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// parsers/utils.mjs and parsers/cgd.mjs cannot be imported directly because
// pdfjs-dist is installed in parsers/ (container context), not in the root.
// We test the parsing algorithms (regex, amount extraction, date conversion)
// by replicating the exact patterns from the source and verifying them.

/**
 * Replicates parseEuropeanDecimal from parsers/utils.mjs (lines 56-60).
 * Tested here because the parser module cannot be imported without pdfjs-dist.
 */
function parseEuropeanDecimal(value) {
  if (!value || (typeof value === 'string' && value.trim() === '')) return 0;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().replace(/\./g, '').replace(',', '.');
  return parseFloat(normalized);
}

// --- parseEuropeanDecimal ---

describe('parseEuropeanDecimal', () => {
  it('parses simple European decimal', () => {
    assert.equal(parseEuropeanDecimal('45,99'), 45.99);
    assert.equal(parseEuropeanDecimal('0,50'), 0.5);
    assert.equal(parseEuropeanDecimal('1,00'), 1);
  });

  it('parses with thousands separator', () => {
    assert.equal(parseEuropeanDecimal('1.234,56'), 1234.56);
    assert.equal(parseEuropeanDecimal('12.345.678,90'), 12345678.9);
  });

  it('parses negative amounts', () => {
    assert.equal(parseEuropeanDecimal('-45,99'), -45.99);
    assert.equal(parseEuropeanDecimal('-1.234,56'), -1234.56);
  });

  it('handles zero', () => {
    assert.equal(parseEuropeanDecimal('0,00'), 0);
  });

  it('handles empty/null/whitespace', () => {
    assert.equal(parseEuropeanDecimal(''), 0);
    assert.equal(parseEuropeanDecimal(null), 0);
    assert.equal(parseEuropeanDecimal('  '), 0);
  });

  it('passes through numbers', () => {
    assert.equal(parseEuropeanDecimal(45.99), 45.99);
    assert.equal(parseEuropeanDecimal(-10), -10);
    assert.equal(parseEuropeanDecimal(0), 0);
  });

  it('handles whitespace around value', () => {
    assert.equal(parseEuropeanDecimal('  45,99  '), 45.99);
  });
});

// --- CGD parser algorithm ---
// Tests the exact regex patterns and extraction logic from parsers/cgd.mjs.
// CGD transaction lines: "- - YYYY-MM-DD DESCRIPTION AMOUNT BALANCE"

const DATE_REGEX = /^-\s+-\s+(\d{4}-\d{2}-\d{2})\s+/;
const AMOUNT_PATTERN = /-?[\d.]+,\d{2}/g;

/**
 * Replicates the CGD parse loop logic for a single line.
 * Returns a transaction object or null if the line doesn't match.
 */
function parseCgdLine(line) {
  const dateMatch = line.match(DATE_REGEX);
  if (!dateMatch) return null;

  const isoDate = dateMatch[1];
  const amounts = [...line.matchAll(AMOUNT_PATTERN)];
  if (amounts.length < 2) return null;

  const amountMatch = amounts[amounts.length - 2];
  const descStart = dateMatch[0].length;
  const descEnd = amountMatch.index;
  const description = line.slice(descStart, descEnd).replace(/\s+/g, ' ').trim();

  if (!description) return null;

  const parsedAmount = parseEuropeanDecimal(amountMatch[0]);
  const [year, month, day] = isoDate.split('-');
  const date = `${day}/${month}/${year}`;

  return { date, description, amount: parsedAmount };
}

describe('CGD parser line matching', () => {
  it('parses a standard debit transaction line', () => {
    const tx = parseCgdLine('- - 2025-01-15 COMPRA LOJA ABC 45,99 1.234,56');
    assert.deepEqual(tx, {
      date: '15/01/2025',
      description: 'COMPRA LOJA ABC',
      amount: 45.99,
    });
  });

  it('parses a negative (debit) amount line', () => {
    const tx = parseCgdLine('- - 2025-02-10 PAGAMENTO SERVIÇO -123,45 5.678,90');
    assert.ok(tx);
    assert.equal(tx.date, '10/02/2025');
    assert.equal(tx.description, 'PAGAMENTO SERVIÇO');
    assert.equal(tx.amount, -123.45);
  });

  it('parses a credit (positive) amount line', () => {
    const tx = parseCgdLine('- - 2025-03-01 TRANSFERÊNCIA RECEBIDA 500,00 6.178,90');
    assert.ok(tx);
    assert.equal(tx.amount, 500);
    assert.equal(tx.description, 'TRANSFERÊNCIA RECEBIDA');
  });

  it('skips lines that do not match transaction format', () => {
    const nonTransactionLines = [
      'SALDO ANTERIOR 1.234,56',
      '2025-01-15 COMPRA LOJA 45,99',
      'Some random text',
      '',
      '- 2025-01-15 Missing second dash',
    ];

    for (const line of nonTransactionLines) {
      assert.equal(parseCgdLine(line), null, `should not match: "${line}"`);
    }
  });

  it('skips lines with fewer than 2 amounts', () => {
    const tx = parseCgdLine('- - 2025-01-15 SOME ENTRY WITHOUT AMOUNTS');
    assert.equal(tx, null);
  });

  it('handles large amounts with multiple thousands separators', () => {
    const tx = parseCgdLine('- - 2025-06-15 PAGAMENTO GRANDE 12.345,67 99.999.999,99');
    assert.ok(tx);
    assert.equal(tx.amount, 12345.67);
  });

  it('handles line with extra whitespace between dashes', () => {
    const tx = parseCgdLine('-   -   2025-04-20   COMPRA TESTE   99,99   500,00');
    assert.ok(tx);
    assert.equal(tx.date, '20/04/2025');
    assert.equal(tx.amount, 99.99);
  });

  it('extracts description with whitespace normalization', () => {
    const tx = parseCgdLine('- - 2025-01-15 COMPRA   LOJA    ABC 45,99 1.234,56');
    assert.ok(tx);
    assert.equal(tx.description, 'COMPRA LOJA ABC');
  });

  it('handles line with 3+ amounts (picks second-to-last)', () => {
    const tx = parseCgdLine('- - 2025-01-15 MULTI AMOUNT 10,00 45,99 1.234,56');
    assert.ok(tx);
    assert.equal(tx.amount, 45.99, 'should pick second-to-last amount');
  });

  it('returns null for line with empty description', () => {
    // Date followed immediately by amounts (no description text between)
    const tx = parseCgdLine('- - 2025-01-15 45,99 1.234,56');
    // Description would be empty after trimming
    assert.equal(tx, null);
  });
});
