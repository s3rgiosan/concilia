#!/usr/bin/env node
// Writes golden fixtures for the Rust port: fabricated inputs run through the Node worker
// libraries, saved with their outputs under src-tauri/tests/fixtures/golden/.
//
// Usage: node scripts/golden/dump.mjs

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { matchTransactions } from '../../worker/lib/matcher.mjs';
import { isBankFee } from '../../worker/lib/bank-fees.mjs';
import { euroToCents, ddmmyyyyToISO, makeTransactionId } from '../../worker/lib/schema.mjs';
import { parseJsonFromText } from '../../worker/lib/gemini.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const outDir = join(root, 'src-tauri', 'tests', 'fixtures', 'golden');

// mulberry32: small seeded PRNG so the fixtures are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = rng(20300301);
const pick = (list) => list[Math.floor(rand() * list.length)];
const chance = (p) => rand() < p;
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const VENDORS = ['ACME', 'Acme Corp', 'Globex', 'Initech', 'Umbrella Lda', 'Example Café', 'Contoso', 'Northwind', 'Vandelay', 'Hooli'];
const DESC_WORDS = ['ACME', 'GLOBEX', 'INITECH', 'UMBRELLA', 'CAFE', 'CONTOSO', 'NORTHWIND', 'VANDELAY', 'HOOLI', 'COMPRA', 'PAGAMENTO', 'LOJA', 'ONLINE', 'SERVICOS', 'MBWAY', 'DD'];
const FEES = ['COMISSAO MANUTENCAO', 'IMPOSTO DE SELO', 'EXAMPLE FEE', 'JUROS DEVEDORES', 'ATM WITHDRAWAL'];
const FILE_WORDS = ['acme', 'globex', 'initech', 'umbrella', 'cafe', 'contoso', 'northwind', 'vandelay', 'hooli', 'fatura', 'invoice', 'recibo', 'receipt', 'servicos'];
const CURRENCIES = ['EUR', 'EUR', 'EUR', 'EUR', 'USD', 'GBP', null];
const AMOUNTS = [500, 1000, 1250, 1999, 2500, 4599, 5000, 10000, 12345];

function isoDate(day) {
  const d = new Date(Date.UTC(2030, 2, 1) + day * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function scenario(index) {
  // A narrow amount pool makes several receipts share an amount, which exercises tie-breaking.
  const amounts = chance(0.4) ? AMOUNTS.slice(0, 3) : AMOUNTS;
  const txCount = int(1, 8);
  const receiptCount = int(0, 10);
  const transactions = [];
  for (let i = 0; i < txCount; i++) {
    const description = chance(0.12)
      ? pick(FEES)
      : Array.from({ length: int(1, 3) }, () => pick(DESC_WORDS)).join(' ');
    const cents = -pick(amounts) + (chance(0.15) ? int(-60, 60) : 0);
    const date = isoDate(int(0, 40));
    transactions.push({
      id: makeTransactionId(i + 1, date, cents),
      date,
      description,
      amount_cents: cents,
      abs_cents: Math.abs(cents),
      status: 'UNMATCHED',
    });
  }
  const receipts = [];
  for (let i = 0; i < receiptCount; i++) {
    const words = Array.from({ length: int(1, 2) }, () => pick(FILE_WORDS)).join('_');
    const ext = pick(['pdf', 'pdf', 'jpg', 'png']);
    const currency = pick(CURRENCIES);
    let amount = chance(0.08) ? null : pick(amounts);
    if (amount !== null && currency !== 'EUR' && chance(0.6)) amount += int(-800, 800);
    receipts.push({
      file: `/receipts/2030/03/receipts/${chance(0.2) ? 'sub/' : ''}${words}-${index}-${i}.${ext}`,
      amount_cents: amount,
      confidence: amount === null ? null : 'high',
      currency,
      vendor: chance(0.7) ? pick(VENDORS) : null,
      date: chance(0.75) ? isoDate(int(-20, 70)) : null,
      provider_used: amount === null ? 'error' : 'gemini',
    });
  }
  const rules = [];
  if (chance(0.15)) {
    rules.push({ id: `rule-${index}`, receiptVendor: pick(VENDORS).split(' ')[0], transactionDescription: pick(DESC_WORDS) });
  }
  return { transactions, receipts, rules };
}

function write(name, cases) {
  // One case per line keeps the files compact and their diffs readable.
  writeFileSync(join(outDir, `${name}.json`), `[\n${cases.map((c) => JSON.stringify(c)).join(',\n')}\n]\n`);
  console.log(`${name}: ${cases.length} cases`);
}

// Matcher.
const matcherCases = [];
for (let i = 0; i < 400; i++) {
  const input = scenario(i);
  const expected = matchTransactions(input.transactions, input.receipts, input.rules);
  matcherCases.push({ input, expected });
}
write('matcher', matcherCases);

// Bank fees.
const feeInputs = [
  ...FEES, ...DESC_WORDS,
  'COMISSÃO DE DÉBITO', 'provisão', 'MANUTENÇÃO CONTA', 'TAXA MANUT', 'ANNUAL CARD CHARGE', 'ANNUAL SOFTWARE LICENSE CHARGE',
  'WIRE BANK TRANSFER', 'WIRE ÇÃO TRANSFER', 'ÃFEEÃ', 'COFFEE', 'FEES', 'ATMOSPHERE', 'STAMP-DUTY', 'ACCOUNT_MAINTENANCE',
  'SEGURO_AUTO', 'DESPESAS CONTABILIDADE', 'OVERDRAFT', 'Interest', 'interessante', '',
];
for (let i = 0; i < 80; i++) {
  feeInputs.push(Array.from({ length: int(1, 4) }, () => pick([...DESC_WORDS, ...FEES.flatMap((f) => f.split(' ')), 'É', 'ção', '_', '-'])).join(pick([' ', '', '-'])));
}
write('bank_fees', feeInputs.map((input) => ({ input, expected: isBankFee(input) })));

// Schema.
const euroNumbers = [0, 0.1 + 0.2, -45.99, 1234.56, 1.005, -1.005, 0.025, -0.025, 2.675, 99999.995];
for (let i = 0; i < 100; i++) euroNumbers.push(Math.round((rand() * 2000 - 1000) * 1000) / 1000);
write('euros_to_cents', euroNumbers.map((input) => ({ input, expected: euroToCents(input) })));
const euroStrings = ['1.234,56', '-45,99', '50,00', '0,00', '12.345.678,90', '0,50', '  45,99  ', '10', '10,5'];
for (let i = 0; i < 100; i++) {
  const cents = int(-9_999_999, 9_999_999);
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  euroStrings.push(`${cents < 0 ? '-' : ''}${whole},${String(abs % 100).padStart(2, '0')}`);
}
write('euro_str_to_cents', euroStrings.map((input) => ({ input, expected: euroToCents(input) })));
const dates = ['15/01/2030', '01/12/2029', '31/07/2028', '2030-01-15', '1/1/2030', '', '15/01/30'];
write('ddmmyyyy_to_iso', dates.map((input) => {
  try { return { input, expected: ddmmyyyyToISO(input) }; } catch { return { input, expected: null }; }
}));

// Gemini reply parsing.
const replies = [
  '{"amount": 12.50, "currency": "EUR"}', '{"amount": 12.50}', '```json\n{"amount": 45.99, "currency": "USD"}\n```',
  'The total is {"amount": 10.00, "currency": "GBP"}', '{"error": "unreadable"}', '{"amount": "twelve"}', '',
  '{"amount": 0}', '{"amount": -12.50, "currency": "EUR"}', '{"amount": 10.00, "currency": "eur"}', '{"amount": 10.00, "currency": "EURO"}',
  '{"amount": 10.00, "date": "2030-11-14"}', '{"amount": 10.00, "date": "14/11/2030"}', '{"amount": 10.00, "date": "2030-13-99"}',
  '{"amount": 10.00, "date": "2030-02-30"}', '{"amount": 10.00, "date": "2030-02-32"}', '{"amount": 1, "currency": "€"}',
  '{"amount": 1, "currency": "R$"}', '{"amount": 1, "currency": " usd "}', '{"amount": 1, "vendor": "  ACME CORP  "}',
  '{"amount": 1, "vendor": "   "}', '{"amount": 1, "vendor": 42}', '{"error": "", "amount": 3}', '{"error": 0, "amount": 3}',
  '{"error": false, "amount": 3}', 'text {"amount": 1} and {"amount": 2} more', '{"amount": 1e2}', '{"amount": 19.999}',
  '[{"amount": 1}]', '{"amount": null}', '{"amount": 7.005, "currency": "jpy", "vendor": "Example Café", "date": " 2030-03-01 "}',
];
write('gemini_parse', replies.map((input) => ({ input, expected: parseJsonFromText(input) })));
