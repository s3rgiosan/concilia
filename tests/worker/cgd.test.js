const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// parsers/utils.mjs and parsers/cgd.mjs cannot be imported directly because
// pdfjs-dist is installed in parsers/, not in the root. We test the parsing
// algorithms (regex, amount extraction, date conversion) by replicating the
// exact patterns from the source and verifying them.

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
// Tests the line regex from parsers/cgd.mjs (poppler -layout output).
// Format: "<spaces><DataMov> <DataValor> <description>...<amount> <balance>"

const TX_LINE_RE = /^\s*(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s+(-?[\d.]+,\d{2})\s+(-?[\d.]+,\d{2})\s*$/;

function parseCgdLine(line) {
  const m = line.match(TX_LINE_RE);
  if (!m) return null;
  const [, dataMov, , rawDescription, rawAmount] = m;
  const description = rawDescription.replace(/\s+/g, ' ').trim();
  if (!description) return null;
  const [year, month, day] = dataMov.split('-');
  const date = `${day}/${month}/${year}`;
  const amount = parseEuropeanDecimal(rawAmount);
  return { date, description, amount };
}

describe('CGD parser line matching', () => {
  it('parses a standard debit transaction line', () => {
    const tx = parseCgdLine('  2025-01-15 2025-01-15 COMPRA LOJA ABC                    45,99    1.234,56');
    assert.deepEqual(tx, {
      date: '15/01/2025',
      description: 'COMPRA LOJA ABC',
      amount: 45.99,
    });
  });

  it('uses Data Mov (first date) when it differs from Data Valor', () => {
    // Posting date later than value date — common for fee reversals / scheduled debits
    const tx = parseCgdLine('  2025-04-10 2025-04-05 EXAMPLE FEE                     10,00      500,00');
    assert.equal(tx.date, '10/04/2025', 'should use Data Mov, not Data Valor');
    assert.equal(tx.description, 'EXAMPLE FEE');
    assert.equal(tx.amount, 10);
  });

  it('parses a negative (debit) amount line', () => {
    const tx = parseCgdLine('  2025-02-10 2025-02-10 PAGAMENTO SERVIÇO        -123,45    5.678,90');
    assert.ok(tx);
    assert.equal(tx.date, '10/02/2025');
    assert.equal(tx.description, 'PAGAMENTO SERVIÇO');
    assert.equal(tx.amount, -123.45);
  });

  it('parses a credit (positive) amount line', () => {
    const tx = parseCgdLine('  2025-03-01 2025-03-01 TRANSFERÊNCIA RECEBIDA        500,00    6.178,90');
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
      '- - 2025-01-15 OLD FORMAT 45,99 1.234,56',
    ];

    for (const line of nonTransactionLines) {
      assert.equal(parseCgdLine(line), null, `should not match: "${line}"`);
    }
  });

  it('handles large amounts with multiple thousands separators', () => {
    const tx = parseCgdLine('  2025-06-15 2025-06-15 PAGAMENTO GRANDE        12.345,67   99.999.999,99');
    assert.ok(tx);
    assert.equal(tx.amount, 12345.67);
  });

  it('extracts description with whitespace normalization', () => {
    const tx = parseCgdLine('  2025-01-15 2025-01-15 COMPRA   LOJA    ABC        45,99    1.234,56');
    assert.ok(tx);
    assert.equal(tx.description, 'COMPRA LOJA ABC');
  });
});
