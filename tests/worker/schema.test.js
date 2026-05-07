const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Dynamic import for ESM module
let schema;
async function load() {
  if (!schema) {
    schema = await import('../../worker/lib/schema.mjs');
  }
  return schema;
}

describe('ddmmyyyyToISO', () => {
  it('converts DD/MM/YYYY to YYYY-MM-DD', async () => {
    const { ddmmyyyyToISO } = await load();
    assert.equal(ddmmyyyyToISO('15/01/2025'), '2025-01-15');
    assert.equal(ddmmyyyyToISO('01/12/2024'), '2024-12-01');
    assert.equal(ddmmyyyyToISO('31/07/2023'), '2023-07-31');
  });

  it('throws on invalid format', async () => {
    const { ddmmyyyyToISO } = await load();
    assert.throws(() => ddmmyyyyToISO('2025-01-15'));
    assert.throws(() => ddmmyyyyToISO('1/1/2025'));
    assert.throws(() => ddmmyyyyToISO(''));
    assert.throws(() => ddmmyyyyToISO(null));
  });
});

describe('euroToCents', () => {
  it('converts JS number to cents', async () => {
    const { euroToCents } = await load();
    assert.equal(euroToCents(-45.99), -4599);
    assert.equal(euroToCents(50), 5000);
    assert.equal(euroToCents(0), 0);
    assert.equal(euroToCents(1234.56), 123456);
  });

  it('converts European decimal string to cents', async () => {
    const { euroToCents } = await load();
    assert.equal(euroToCents('1.234,56'), 123456);
    assert.equal(euroToCents('-45,99'), -4599);
    assert.equal(euroToCents('50,00'), 5000);
  });

  it('handles edge cases', async () => {
    const { euroToCents } = await load();
    assert.equal(euroToCents(''), 0);
    assert.equal(euroToCents(null), 0);
    assert.equal(euroToCents(0.1 + 0.2), 30); // floating point
  });
});

describe('makeTransactionId', () => {
  it('generates deterministic ID', async () => {
    const { makeTransactionId } = await load();
    assert.equal(
      makeTransactionId(1, '2025-01-15', -4599),
      'tx-001-2025-01-15--4599',
    );
    assert.equal(
      makeTransactionId(42, '2024-12-01', 5000),
      'tx-042-2024-12-01-5000',
    );
  });

  it('zero-pads index to 3 digits', async () => {
    const { makeTransactionId } = await load();
    assert.match(makeTransactionId(1, '2025-01-01', 0), /^tx-001-/);
    assert.match(makeTransactionId(100, '2025-01-01', 0), /^tx-100-/);
  });
});

describe('normalizeTransaction', () => {
  it('converts parser output to canonical schema', async () => {
    const { normalizeTransaction } = await load();
    const raw = { date: '15/01/2025', description: 'COMPRA LOJA', amount: -45.99 };
    const result = normalizeTransaction(raw, 1);

    assert.equal(result.id, 'tx-001-2025-01-15--4599');
    assert.equal(result.date, '2025-01-15');
    assert.equal(result.description, 'COMPRA LOJA');
    assert.equal(result.amount_cents, -4599);
    assert.equal(result.abs_cents, 4599);
    assert.equal(result.status, 'UNMATCHED');
  });

  it('defaults description to Unknown', async () => {
    const { normalizeTransaction } = await load();
    const raw = { date: '01/01/2025', description: '', amount: 10 };
    assert.equal(normalizeTransaction(raw, 1).description, 'Unknown');
  });

  it('handles positive (credit) amounts', async () => {
    const { normalizeTransaction } = await load();
    const raw = { date: '01/01/2025', description: 'DEPOSIT', amount: 100.5 };
    const result = normalizeTransaction(raw, 1);
    assert.equal(result.amount_cents, 10050);
    assert.equal(result.abs_cents, 10050);
  });
});
