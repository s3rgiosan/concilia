const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let mod;
async function load() {
  if (!mod) mod = await import('../../worker/lib/matcher.mjs');
  return mod;
}

function tx(id, date, description, amountCents) {
  return {
    id,
    date,
    description,
    amount_cents: amountCents,
    abs_cents: Math.abs(amountCents),
    status: 'UNMATCHED',
  };
}

function receipt(file, amountCents, date = null) {
  return { file, amount_cents: amountCents, confidence: 'high', provider_used: 'gemini', date };
}

describe('matchTransactions', () => {
  describe('amount match (single candidate)', () => {
    it('matches transaction to receipt with same abs amount', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA LOJA', -5000)],
        [receipt('/r/a.pdf', 5000)],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'MATCHED');
      assert.deepEqual(t.receipt_files, ['/r/a.pdf']);
      assert.equal(t.notes, 'amount_match');
    });

    it('tolerates ±5 cents difference', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [receipt('/r/a.pdf', 5005)],
      );
      assert.equal(result.transactions[0].status, 'MATCHED');
    });

    it('does not tolerate ±6 cents difference', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [receipt('/r/a.pdf', 5006)],
      );
      assert.equal(result.transactions[0].status, 'UNMATCHED');
    });
  });

  describe('ambiguous match (multiple candidates)', () => {
    it('marks as REVIEW when multiple receipts match', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [receipt('/r/a.pdf', 5000), receipt('/r/b.pdf', 5000)],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
      assert.equal(t.receipt_files.length, 2);
      assert.match(t.notes, /2 receipts/);
    });

    it('does not consume receipts for REVIEW items', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [
          tx('tx-001', '2024-12-15', 'COMPRA A', -5000),
          tx('tx-002', '2024-12-16', 'COMPRA B', -5000),
        ],
        [receipt('/r/a.pdf', 5000), receipt('/r/b.pdf', 5000)],
      );
      // Both should be REVIEW since there are 2 candidates for each
      assert.equal(result.transactions[0].status, 'REVIEW');
      assert.equal(result.transactions[1].status, 'REVIEW');
    });
  });

  describe('no match', () => {
    it('marks as UNMATCHED when no receipt fits', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [receipt('/r/a.pdf', 9900)],
      );
      assert.equal(result.transactions[0].status, 'UNMATCHED');
    });

    it('marks as UNMATCHED when no receipts at all', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [],
      );
      assert.equal(result.transactions[0].status, 'UNMATCHED');
    });
  });

  describe('bank fee detection', () => {
    it('auto-matches COMISSÃO as bank fee', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMISSÃO DE DÉBITO', -250)],
        [],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'MATCHED');
      assert.equal(t.notes, 'bank_fee');
    });

    it('auto-matches MONTHLY FEE as bank fee', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'MONTHLY FEE', -500)],
        [],
      );
      assert.equal(result.transactions[0].status, 'MATCHED');
      assert.equal(result.transactions[0].notes, 'bank_fee');
    });

    it('bank fee takes priority over amount match', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'JUROS CREDORES', -500)],
        [receipt('/r/a.pdf', 500)],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'MATCHED');
      assert.equal(t.notes, 'bank_fee');
      // Receipt should remain unused
      assert.equal(result.receiptsByStatus.matched.length, 0);
    });
  });

  describe('receipt consumption', () => {
    it('consumed receipt is not reused', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [
          tx('tx-001', '2024-12-15', 'COMPRA A', -5000),
          tx('tx-002', '2024-12-16', 'COMPRA B', -5000),
        ],
        [receipt('/r/a.pdf', 5000)],
      );
      assert.equal(result.transactions[0].status, 'MATCHED');
      assert.equal(result.transactions[1].status, 'UNMATCHED');
    });
  });

  describe('receipt sorting', () => {
    it('separates receipts into matched/review/unmatched', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [
          tx('tx-001', '2024-12-15', 'COMPRA A', -5000),
          tx('tx-002', '2024-12-16', 'COMPRA B', -3000),
        ],
        [
          receipt('/r/matched.pdf', 5000),
          receipt('/r/unmatched.pdf', 9900),
        ],
      );
      assert.deepEqual(result.receiptsByStatus.matched, ['/r/matched.pdf']);
      assert.deepEqual(result.receiptsByStatus.review, []);
      assert.deepEqual(result.receiptsByStatus.unmatched, ['/r/unmatched.pdf']);
    });

    it('puts review receipts in review bucket', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [receipt('/r/a.pdf', 5000), receipt('/r/b.pdf', 5000)],
      );
      assert.equal(result.receiptsByStatus.review.length, 2);
      assert.equal(result.receiptsByStatus.matched.length, 0);
    });
  });

  describe('null amount receipts', () => {
    it('treats receipts with null amount as unmatched', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [{ file: '/r/broken.pdf', amount_cents: null, confidence: null, provider_used: 'gemini' }],
      );
      assert.equal(result.transactions[0].status, 'UNMATCHED');
      assert.deepEqual(result.receiptsByStatus.unmatched, ['/r/broken.pdf']);
    });

    it('matches valid receipt when null-amount receipt appears first', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [
          { file: '/r/broken.pdf', amount_cents: null, confidence: null, provider_used: 'gemini' },
          receipt('/r/valid.pdf', 5000),
        ],
      );
      assert.equal(result.transactions[0].status, 'MATCHED');
      assert.deepEqual(result.transactions[0].receipt_files, ['/r/valid.pdf']);
      assert.deepEqual(result.receiptsByStatus.unmatched, ['/r/broken.pdf']);
    });
  });

  describe('receipt_meta in output', () => {
    it('includes receipt_meta for matched transactions', async () => {
      const { matchTransactions } = await load();
      const r = receipt('/r/a.pdf', 5000);
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA LOJA', -5000)],
        [r],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'MATCHED');
      assert.equal(t.receipt_meta.length, 1);
      assert.equal(t.receipt_meta[0].file, '/r/a.pdf');
      assert.equal(t.receipt_meta[0].amount_cents, 5000);
    });

    it('includes receipt_meta for REVIEW transactions', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [receipt('/r/a.pdf', 5000), receipt('/r/b.pdf', 5000)],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
      assert.equal(t.receipt_meta.length, 2);
    });

    it('has empty receipt_meta for bank fees', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMISSÃO DE DÉBITO', -250)],
        [],
      );
      assert.deepEqual(result.transactions[0].receipt_meta, []);
    });

    it('has empty receipt_meta for unmatched transactions', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [receipt('/r/a.pdf', 9900)],
      );
      assert.deepEqual(result.transactions[0].receipt_meta, []);
    });

    it('preserves extra receipt properties in receipt_meta', async () => {
      const { matchTransactions } = await load();
      const r = { file: '/r/a.pdf', amount_cents: 5000, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [r],
      );
      assert.equal(result.transactions[0].receipt_meta[0].currency, 'EUR');
    });

    it('USD receipt with exact amount goes to FX review (not amount match)', async () => {
      const { matchTransactions } = await load();
      // Name must overlap for FX pass to include the receipt
      const r = { file: '/r/Netlify invoice.pdf', amount_cents: 5000, confidence: 'high', provider_used: 'gemini', currency: 'USD' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'NETLIFY', -5000)],
        [r],
      );
      // USD receipts skip pass 2 (EUR only), matched in pass 3 (FX ±10%)
      assert.equal(result.transactions[0].status, 'REVIEW');
      assert.match(result.transactions[0].notes, /fx_match/);
    });

    it('EUR receipt matches by amount in pass 2', async () => {
      const { matchTransactions } = await load();
      const r = { file: '/r/a.pdf', amount_cents: 5000, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [r],
      );
      assert.equal(result.transactions[0].status, 'MATCHED');
      assert.equal(result.transactions[0].notes, 'amount_match');
    });
  });

  describe('unmatchedReceipts in output', () => {
    it('returns unmatched receipts as full objects', async () => {
      const { matchTransactions } = await load();
      const r = receipt('/r/unmatched.pdf', 9900);
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [r],
      );
      assert.equal(result.unmatchedReceipts.length, 1);
      assert.equal(result.unmatchedReceipts[0].file, '/r/unmatched.pdf');
      assert.equal(result.unmatchedReceipts[0].amount_cents, 9900);
    });

    it('returns empty array when all receipts matched', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [receipt('/r/a.pdf', 5000)],
      );
      assert.equal(result.unmatchedReceipts.length, 0);
    });

    it('excludes review receipts from unmatchedReceipts', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [receipt('/r/a.pdf', 5000), receipt('/r/b.pdf', 5000)],
      );
      // Both are in review, neither is in unmatched
      assert.equal(result.unmatchedReceipts.length, 0);
    });

    it('includes null-amount receipts in unmatchedReceipts', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [{ file: '/r/broken.pdf', amount_cents: null, confidence: null, provider_used: 'gemini' }],
      );
      assert.equal(result.unmatchedReceipts.length, 1);
      assert.equal(result.unmatchedReceipts[0].file, '/r/broken.pdf');
    });
  });

  describe('name disambiguation', () => {
    it('disambiguates multiple amount candidates by filename', async () => {
      const { matchTransactions } = await load();
      // Two EUR receipts with same amount, but only one filename matches the transaction
      const r1 = { file: '/r/Spotify Premium.pdf', amount_cents: 1700, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const r2 = { file: '/r/random-receipt.pdf', amount_cents: 1700, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'SPOTIFY PREMIUM', -1700)],
        [r1, r2],
      );
      const t = result.transactions[0];
      // Pass 1: name+amount finds Spotify → MATCHED
      assert.equal(t.status, 'MATCHED');
      assert.deepEqual(t.receipt_files, ['/r/Spotify Premium.pdf']);
      assert.equal(t.notes, 'name_amount_match');
    });

    it('falls back to REVIEW when no name disambiguates', async () => {
      const { matchTransactions } = await load();
      const r1 = { file: '/r/a.pdf', amount_cents: 1700, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const r2 = { file: '/r/b.pdf', amount_cents: 1700, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'SPOTIFY PREMIUM', -1700)],
        [r1, r2],
      );
      // Neither filename matches, so still REVIEW
      assert.equal(result.transactions[0].status, 'REVIEW');
    });

    it('EUR receipt matched in pass 2, non-EUR left for FX', async () => {
      const { matchTransactions } = await load();
      const eurReceipt = { file: '/r/eur.pdf', amount_cents: 1700, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const usdReceipt = { file: '/r/DigitalOcean.pdf', amount_cents: 1700, confidence: 'high', provider_used: 'gemini', currency: 'USD' };
      const result = matchTransactions(
        [
          tx('tx-001', '2024-12-15', 'SOME PURCHASE', -1700),   // matches EUR in pass 2
          tx('tx-002', '2024-12-16', 'DIGITALOCEAN', -1600),    // should FX match USD in pass 3
        ],
        [usdReceipt, eurReceipt],
      );
      assert.equal(result.transactions[0].status, 'MATCHED');
      assert.deepEqual(result.transactions[0].receipt_files, ['/r/eur.pdf']);
      assert.equal(result.transactions[1].status, 'REVIEW');
      assert.match(result.transactions[1].notes, /fx_match.*USD/);
    });

    it('disambiguates FX candidates by filename', async () => {
      const { matchTransactions } = await load();
      // Two non-EUR receipts within ±10%, but only one matches by name
      const r1 = { file: '/r/DigitalOcean Invoice.pdf', amount_cents: 4707, confidence: 'high', provider_used: 'gemini', currency: 'USD' };
      const r2 = { file: '/r/some-other.pdf', amount_cents: 4500, confidence: 'high', provider_used: 'gemini', currency: 'USD' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'DIGITALOCEAN', -4312)],
        [r1, r2],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
      // Should narrow to just the DigitalOcean receipt
      assert.equal(t.receipt_files.length, 1);
      assert.deepEqual(t.receipt_files, ['/r/DigitalOcean Invoice.pdf']);
      assert.match(t.notes, /fx_match.*USD/);
    });
  });

  describe('FX matching (pass 2)', () => {
    it('matches USD receipt to EUR transaction within ±10% as REVIEW when name overlaps', async () => {
      const { matchTransactions } = await load();
      // Transaction: €43.12 EUR, Receipt: $47.07 USD (~9% difference), vendor matches description
      const r = { file: '/r/invoice.pdf', amount_cents: 4707, confidence: 'high', provider_used: 'gemini', currency: 'USD', vendor: 'DigitalOcean' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'DIGITALOCEAN', -4312)],
        [r],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
      assert.deepEqual(t.receipt_files, ['/r/invoice.pdf']);
      assert.match(t.notes, /fx_match.*USD/);
    });

    it('does not FX match when no name overlap — receipt stays unmatched', async () => {
      const { matchTransactions } = await load();
      // Receipt vendor/filename has no relation to transaction description
      const r = { file: '/r/spinupwp-invoice.pdf', amount_cents: 1700, confidence: 'high', provider_used: 'gemini', currency: 'USD', vendor: 'SpinupWP' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'JORGE ALVES', -1650)],
        [r],
      );
      // No name overlap: spinupwp ≠ jorge alves → stays UNMATCHED
      assert.equal(result.transactions[0].status, 'UNMATCHED');
      assert.equal(result.receiptsByStatus.unmatched.length, 1);
    });

    it('does not FX match EUR receipts', async () => {
      const { matchTransactions } = await load();
      // EUR receipt with 8% difference — should NOT FX match (EUR-to-EUR is not FX)
      const r = { file: '/r/a.pdf', amount_cents: 5400, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [r],
      );
      assert.equal(result.transactions[0].status, 'UNMATCHED');
    });

    it('does not FX match receipts without currency', async () => {
      const { matchTransactions } = await load();
      const r = { file: '/r/a.pdf', amount_cents: 5400, confidence: 'high', provider_used: 'gemini' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [r],
      );
      assert.equal(result.transactions[0].status, 'UNMATCHED');
    });

    it('does not FX match when difference exceeds 10%', async () => {
      const { matchTransactions } = await load();
      // 15% difference — too far
      const r = { file: '/r/a.pdf', amount_cents: 5750, confidence: 'high', provider_used: 'gemini', currency: 'USD' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [r],
      );
      assert.equal(result.transactions[0].status, 'UNMATCHED');
    });

    it('prefers exact match over FX match', async () => {
      const { matchTransactions } = await load();
      const eurReceipt = { file: '/r/eur.pdf', amount_cents: 5000, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const usdReceipt = { file: '/r/usd.pdf', amount_cents: 5200, confidence: 'high', provider_used: 'gemini', currency: 'USD' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'COMPRA', -5000)],
        [eurReceipt, usdReceipt],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'MATCHED');
      assert.equal(t.notes, 'amount_match');
      assert.deepEqual(t.receipt_files, ['/r/eur.pdf']);
    });

    it('does not FX match already-consumed receipts', async () => {
      const { matchTransactions } = await load();
      // EUR receipt consumed in pass 2, should not be available for FX
      const eurR = { file: '/r/eur.pdf', amount_cents: 5000, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const result = matchTransactions(
        [
          tx('tx-001', '2024-12-15', 'COMPRA A', -5000),
          tx('tx-002', '2024-12-16', 'COMPRA B', -4800),
        ],
        [eurR],
      );
      assert.equal(result.transactions[0].status, 'MATCHED');
      assert.equal(result.transactions[1].status, 'UNMATCHED');
    });

    it('shows multiple FX candidates in notes when both have name overlap', async () => {
      const { matchTransactions } = await load();
      // Both receipts have vendor matching the transaction description
      const r1 = { file: '/r/a.pdf', amount_cents: 5200, confidence: 'high', provider_used: 'gemini', currency: 'USD', vendor: 'Amazon' };
      const r2 = { file: '/r/b.pdf', amount_cents: 5300, confidence: 'high', provider_used: 'gemini', currency: 'GBP', vendor: 'Amazon' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'AMAZON PURCHASE', -5000)],
        [r1, r2],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
      assert.equal(t.receipt_files.length, 2);
      assert.match(t.notes, /2 fx receipts/);
    });

    it('FX matched receipts go to review bucket', async () => {
      const { matchTransactions } = await load();
      const r = { file: '/r/DigitalOcean.pdf', amount_cents: 4707, confidence: 'high', provider_used: 'gemini', currency: 'USD' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'DIGITALOCEAN', -4312)],
        [r],
      );
      assert.ok(result.receiptsByStatus.review.includes('/r/DigitalOcean.pdf'));
      assert.equal(result.receiptsByStatus.matched.length, 0);
      assert.equal(result.receiptsByStatus.unmatched.length, 0);
    });
  });

  describe('filename matching (pass 3)', () => {
    it('matches receipt filename to transaction description', async () => {
      const { matchTransactions } = await load();
      // Transaction "DIGITALOCEAN" matches filename "DigitalOcean Invoice 2025 Oct.pdf"
      const r = { file: '/r/DigitalOcean Invoice 2025 Oct (14377852-530612035).pdf', amount_cents: 4707, confidence: 'high', provider_used: 'gemini', currency: 'USD' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'DIGITALOCEAN', -4086)],
        [r],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
      assert.match(t.notes, /filename_match/);
    });

    it('does not filename-match short words (< 4 chars)', async () => {
      const { matchTransactions } = await load();
      const r = { file: '/r/ABC report.pdf', amount_cents: 5000, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'ABC COMPRA', -9999)],
        [r],
      );
      // "ABC" is 3 chars, too short; "COMPRA" is a stop word
      assert.equal(result.transactions[0].status, 'UNMATCHED');
    });

    it('prefers name+amount match over filename-only match', async () => {
      const { matchTransactions } = await load();
      const r = { file: '/r/DigitalOcean.pdf', amount_cents: 4086, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'DIGITALOCEAN', -4086)],
        [r],
      );
      // Matched in pass 1 (name + amount) not pass 4 (filename only)
      assert.equal(result.transactions[0].status, 'MATCHED');
      assert.equal(result.transactions[0].notes, 'name_amount_match');
    });

    it('does not filename-match consumed receipts', async () => {
      const { matchTransactions } = await load();
      // EUR receipt consumed by amount in pass 2, then unavailable for filename match
      const r = { file: '/r/DigitalOcean.pdf', amount_cents: 4086, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const result = matchTransactions(
        [
          tx('tx-001', '2024-12-15', 'COMPRA QUALQUER', -4086),
          tx('tx-002', '2024-12-16', 'DIGITALOCEAN', -9999),
        ],
        [r],
      );
      assert.equal(result.transactions[0].status, 'MATCHED');
      assert.equal(result.transactions[1].status, 'UNMATCHED');
    });

    it('filename match receipts go to review bucket', async () => {
      const { matchTransactions } = await load();
      const r = { file: '/r/DigitalOcean Invoice.pdf', amount_cents: 4707, confidence: 'high', provider_used: 'gemini', currency: 'USD' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'DIGITALOCEAN', -4086)],
        [r],
      );
      assert.ok(result.receiptsByStatus.review.includes('/r/DigitalOcean Invoice.pdf'));
    });

    it('filename matches receipt outside FX tolerance', async () => {
      const { matchTransactions } = await load();
      // Receipt $47.07 USD, transaction €40.86 — 15% difference, outside FX ±10%
      // But filename matches transaction description
      const r = { file: '/r/DigitalOcean Invoice 2025 Oct.pdf', amount_cents: 4707, confidence: 'high', provider_used: 'gemini', currency: 'USD' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'DIGITALOCEAN', -4086)],
        [r],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
      assert.match(t.notes, /filename_match/);
    });

    it('filename matches receipt with null amount', async () => {
      const { matchTransactions } = await load();
      // Receipt extraction failed (null amount), but filename matches
      const r = { file: '/r/DigitalOcean Invoice.pdf', amount_cents: null, confidence: null, provider_used: 'gemini', currency: null };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'DIGITALOCEAN', -4086)],
        [r],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
      assert.match(t.notes, /filename_match/);
    });

    it('does not filename-match EUR receipt when amount differs beyond tolerance', async () => {
      const { matchTransactions } = await load();
      // EUR receipt €9.99, transaction €12.00 — name matches but amounts don't
      const r = { file: '/r/Spotify Premium Jan.pdf', amount_cents: 999, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'SPOTIFY PREMIUM', -1200)],
        [r],
      );
      // EUR mismatch: pass 4 should not promote this to REVIEW
      assert.equal(result.transactions[0].status, 'UNMATCHED');
    });

    it('filename-matches EUR receipt when amount is within tolerance', async () => {
      const { matchTransactions } = await load();
      // EUR receipt €9.99, transaction €10.00 — within ±5 cents and name matches
      const r = { file: '/r/Spotify Premium Jan.pdf', amount_cents: 999, confidence: 'high', provider_used: 'gemini', currency: 'EUR' };
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'SPOTIFY PREMIUM', -1000)],
        [r],
      );
      // Amount within tolerance, so pass 1 (name+amount) should catch it first
      assert.equal(result.transactions[0].status, 'MATCHED');
      assert.equal(result.transactions[0].notes, 'name_amount_match');
    });
  });

  describe('custom rules (Pass 0)', () => {
    it('matches via rule when vendor and description keywords match', async () => {
      const { matchTransactions } = await load();
      const rules = [{ id: '1', receiptVendor: 'fastmail', transactionDescription: 'paddle' }];
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'PADDLE.NET CHARGE', -1200)],
        [{ file: '/r/fastmail.pdf', amount_cents: 999, confidence: 'high', vendor: 'Fastmail Pty Ltd', provider_used: 'gemini' }],
        rules,
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'MATCHED');
      assert.ok(t.notes.startsWith('rule_match'));
    });

    it('does not apply rule when vendor keyword does not match', async () => {
      const { matchTransactions } = await load();
      const rules = [{ id: '1', receiptVendor: 'fastmail', transactionDescription: 'paddle' }];
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'PADDLE.NET CHARGE', -1200)],
        [{ file: '/r/other.pdf', amount_cents: 1200, confidence: 'high', vendor: 'Other Corp', provider_used: 'gemini' }],
        rules,
      );
      assert.equal(result.transactions[0].status, 'MATCHED');
      assert.equal(result.transactions[0].notes, 'amount_match');
    });

    it('matches via rule using filename when vendor is null', async () => {
      const { matchTransactions } = await load();
      const rules = [{ id: '1', receiptVendor: 'fastmail', transactionDescription: 'paddle' }];
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'PADDLE.NET CHARGE', -1200)],
        [{ file: '/r/fastmail_invoice.pdf', amount_cents: 999, confidence: 'high', vendor: null, provider_used: 'gemini' }],
        rules,
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'MATCHED');
      assert.ok(t.notes.startsWith('rule_match'));
    });

    it('matches via rule when receipt has null amount_cents', async () => {
      const { matchTransactions } = await load();
      const rules = [{ id: '1', receiptVendor: 'fastmail', transactionDescription: 'paddle' }];
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'PADDLE.NET CHARGE', -1200)],
        [{ file: '/r/fastmail.pdf', amount_cents: null, confidence: null, vendor: 'Fastmail Pty Ltd', provider_used: 'gemini' }],
        rules,
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'MATCHED');
      assert.ok(t.notes.startsWith('rule_match'));
    });

    it('rule takes priority over amount match', async () => {
      const { matchTransactions } = await load();
      const rules = [{ id: '1', receiptVendor: 'fastmail', transactionDescription: 'paddle' }];
      const receipts = [
        { file: '/r/fastmail.pdf', amount_cents: 999, confidence: 'high', vendor: 'Fastmail Pty Ltd', provider_used: 'gemini' },
        { file: '/r/exact.pdf', amount_cents: 1200, confidence: 'high', vendor: 'Someone Else', provider_used: 'gemini' },
      ];
      const result = matchTransactions(
        [tx('tx-001', '2024-12-15', 'PADDLE.NET CHARGE', -1200)],
        receipts,
        rules,
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'MATCHED');
      assert.ok(t.notes.startsWith('rule_match'));
      assert.deepEqual(t.receipt_files, ['/r/fastmail.pdf']);
    });
  });

  describe('date tiebreaker', () => {
    it('picks the closer-dated receipt when name+amount has 2 candidates', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2025-11-14', 'OPENAI SUBSCRIPTION', -2000)],
        [
          { file: '/r/openai-oct.pdf', amount_cents: 2000, confidence: 'high', vendor: 'OpenAI', date: '2025-10-14', provider_used: 'gemini' },
          { file: '/r/openai-nov.pdf', amount_cents: 2000, confidence: 'high', vendor: 'OpenAI', date: '2025-11-13', provider_used: 'gemini' },
        ],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'MATCHED');
      assert.deepEqual(t.receipt_files, ['/r/openai-nov.pdf']);
      assert.equal(t.notes, 'name_amount_date_match');
    });

    it('picks the closer-dated receipt when amount-only has 2 candidates', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2025-11-14', 'COMPRA', -2000)],
        [
          { file: '/r/a.pdf', amount_cents: 2000, confidence: 'high', vendor: null, date: '2025-09-01', provider_used: 'gemini' },
          { file: '/r/b.pdf', amount_cents: 2000, confidence: 'high', vendor: null, date: '2025-11-10', provider_used: 'gemini' },
        ],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'MATCHED');
      assert.deepEqual(t.receipt_files, ['/r/b.pdf']);
      assert.equal(t.notes, 'name_amount_date_match');
    });

    it('falls back to REVIEW when both candidates are outside the date window', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2025-11-14', 'OPENAI', -2000)],
        [
          { file: '/r/old.pdf', amount_cents: 2000, confidence: 'high', vendor: 'OpenAI', date: '2024-01-01', provider_used: 'gemini' },
          { file: '/r/older.pdf', amount_cents: 2000, confidence: 'high', vendor: 'OpenAI', date: '2023-06-01', provider_used: 'gemini' },
        ],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
      assert.deepEqual(t.receipt_files, ['/r/old.pdf', '/r/older.pdf']);
    });

    it('falls back to REVIEW when no candidate has a date', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2025-11-14', 'OPENAI', -2000)],
        [
          { file: '/r/a.pdf', amount_cents: 2000, confidence: 'high', vendor: 'OpenAI', date: null, provider_used: 'gemini' },
          { file: '/r/b.pdf', amount_cents: 2000, confidence: 'high', vendor: 'OpenAI', date: null, provider_used: 'gemini' },
        ],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
    });

    it('treats two candidates with identical date proximity as ambiguous (REVIEW)', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2025-11-14', 'OPENAI', -2000)],
        [
          { file: '/r/a.pdf', amount_cents: 2000, confidence: 'high', vendor: 'OpenAI', date: '2025-11-13', provider_used: 'gemini' },
          { file: '/r/b.pdf', amount_cents: 2000, confidence: 'high', vendor: 'OpenAI', date: '2025-11-15', provider_used: 'gemini' },
        ],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
    });

    it('orders REVIEW candidates by date proximity (closest first)', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions(
        [tx('tx-001', '2025-11-14', 'OPENAI', -2000)],
        [
          { file: '/r/far.pdf', amount_cents: 2000, confidence: 'high', vendor: 'OpenAI', date: '2024-01-01', provider_used: 'gemini' },
          { file: '/r/near.pdf', amount_cents: 2000, confidence: 'high', vendor: 'OpenAI', date: '2024-02-01', provider_used: 'gemini' },
        ],
      );
      const t = result.transactions[0];
      assert.equal(t.status, 'REVIEW');
      assert.equal(t.receipt_files[0], '/r/near.pdf');
    });
  });

  describe('empty inputs', () => {
    it('handles no transactions', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions([], [receipt('/r/a.pdf', 5000)]);
      assert.equal(result.transactions.length, 0);
      assert.deepEqual(result.receiptsByStatus.unmatched, ['/r/a.pdf']);
    });

    it('handles no transactions and no receipts', async () => {
      const { matchTransactions } = await load();
      const result = matchTransactions([], []);
      assert.equal(result.transactions.length, 0);
      assert.deepEqual(result.receiptsByStatus.matched, []);
    });
  });
});
