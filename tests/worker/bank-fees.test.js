const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

let mod;
async function load() {
  if (!mod) mod = await import('../../worker/lib/bank-fees.mjs');
  return mod;
}

describe('isBankFee', () => {
  describe('Portuguese patterns', () => {
    it('matches COMISSÃO', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('COMISSÃO DE DÉBITO'), true);
    });

    it('matches comissao (without accent)', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('COMISSAO DE MANUTENÇÃO'), true);
    });

    it('matches IMPOSTO DE SELO', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('IMPOSTO DE SELO'), true);
    });

    it('matches JUROS', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('JUROS CREDORES'), true);
    });

    it('matches TAXA DE MANUTENÇÃO', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('TAXA DE MANUTENCAO'), true);
    });

    it('matches MANUT CONTA', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('MANUT CONTA'), true);
    });

    it('matches ANUIDADE', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('ANUIDADE CARTAO'), true);
    });

    it('matches DESPESAS DE CONTA', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('DESPESAS DE CONTA'), true);
    });

    it('matches SEGURO', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('SEGURO CARTAO DEBITO'), true);
    });

    it('matches MULTA', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('MULTA ATRASO PAGAMENTO'), true);
    });

    it('matches PROVISÃO', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('PROVISAO MENSAL'), true);
    });
  });

  describe('English patterns', () => {
    it('matches FEE', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('MONTHLY FEE'), true);
    });

    it('does not match COFFEE (partial word)', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('COFFEE SHOP'), false);
    });

    it('matches COMMISSION', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('BANK COMMISSION'), true);
    });

    it('matches INTEREST', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('INTEREST CHARGE'), true);
    });

    it('matches ANNUAL CHARGE', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('ANNUAL CARD CHARGE'), true);
    });

    it('matches ACCOUNT MAINTENANCE', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('ACCOUNT MAINTENANCE FEE'), true);
    });

    it('matches STAMP DUTY', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('STAMP DUTY'), true);
    });

    it('matches OVERDRAFT', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('OVERDRAFT CHARGE'), true);
    });

    it('matches WIRE TRANSFER', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('WIRE TRANSFER FEE'), true);
    });

    it('matches ATM', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('ATM WITHDRAWAL FEE'), true);
    });
  });

  describe('non-matching', () => {
    it('does not match regular purchase', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee('COMPRA LOJA'), false);
    });

    it('does not match empty string', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee(''), false);
    });

    it('does not match null', async () => {
      const { isBankFee } = await load();
      assert.equal(isBankFee(null), false);
    });
  });
});
