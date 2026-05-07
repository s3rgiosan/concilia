const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

async function load() {
  return import('../../worker/lib/gemini.mjs');
}

// Minimal fake service account for constructor tests
const fakeSA = {
  type: 'service_account',
  project_id: 'test-project',
  private_key_id: 'key-id',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB\naFDrBz9vFqU4n8dMIuGMcFfzA9CGnH9dKEIBOkMFmHvLl0M2P+QfNxHWuMfF3fAj\nNEAfMEke5sPGBDgDAoGBALp1rqkpCEE4VHzL0BPgF3TfJaS5aMuS+jkNtPPQxA+5\nfKqF5rP8nMbLBIE3MBbQp3t/XHmVxDkz8K6eDtRvYlEcG+L5MHn+8vKPCMIu4Vl\nC+xMbBFano/bEKfN+pxB3zN7R5JvK+I7sDNJmPF5K3FJOmQ+9kY3L5kN5O5y2F8\nH-----END RSA PRIVATE KEY-----\n',
  client_email: 'test@test-project.iam.gserviceaccount.com',
  client_id: '123456789',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
};

describe('gemini', () => {
  describe('parseJsonFromText', () => {
    it('parses clean JSON with amount and currency', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": 12.50, "currency": "EUR"}');
      assert.deepStrictEqual(result, { amount_cents: 1250, confidence: 'high', currency: 'EUR', vendor: null, date: null });
    });

    it('parses clean JSON with amount only (no currency)', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": 12.50}');
      assert.deepStrictEqual(result, { amount_cents: 1250, confidence: 'high', currency: null, vendor: null, date: null });
    });

    it('parses wrapped JSON (markdown code block)', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('```json\n{"amount": 45.99, "currency": "USD"}\n```');
      assert.deepStrictEqual(result, { amount_cents: 4599, confidence: 'high', currency: 'USD', vendor: null, date: null });
    });

    it('parses JSON with prefix text', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('The total is {"amount": 10.00, "currency": "GBP"}');
      assert.deepStrictEqual(result, { amount_cents: 1000, confidence: 'high', currency: 'GBP', vendor: null, date: null });
    });

    it('returns null for error response', async () => {
      const { parseJsonFromText } = await load();
      assert.strictEqual(parseJsonFromText('{"error": "unreadable"}'), null);
    });

    it('returns null for non-numeric amount', async () => {
      const { parseJsonFromText } = await load();
      assert.strictEqual(parseJsonFromText('{"amount": "twelve"}'), null);
    });

    it('returns null for empty string', async () => {
      const { parseJsonFromText } = await load();
      assert.strictEqual(parseJsonFromText(''), null);
    });

    it('returns null for null input', async () => {
      const { parseJsonFromText } = await load();
      assert.strictEqual(parseJsonFromText(null), null);
    });

    it('returns zero amount_cents for zero amount (free items / fully discounted)', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": 0}');
      assert.strictEqual(result?.amount_cents, 0);
      assert.strictEqual(result?.confidence, 'high');
    });

    it('converts negative amounts to positive via Math.abs', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": -12.50, "currency": "EUR"}');
      assert.deepStrictEqual(result, { amount_cents: 1250, confidence: 'high', currency: 'EUR', vendor: null, date: null });
    });

    it('converts large negative amounts to positive', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": -99.99}');
      assert.deepStrictEqual(result, { amount_cents: 9999, confidence: 'high', currency: null, vendor: null, date: null });
    });

    it('normalizes currency to uppercase', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": 10.00, "currency": "eur"}');
      assert.deepStrictEqual(result, { amount_cents: 1000, confidence: 'high', currency: 'EUR', vendor: null, date: null });
    });

    it('returns null currency for invalid currency string', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": 10.00, "currency": "EURO"}');
      assert.deepStrictEqual(result, { amount_cents: 1000, confidence: 'high', currency: null, vendor: null, date: null });
    });

    it('parses ISO 8601 date', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": 10.00, "date": "2025-11-14"}');
      assert.equal(result.date, '2025-11-14');
    });

    it('returns null for non-ISO date format', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": 10.00, "date": "14/11/2025"}');
      assert.equal(result.date, null);
    });

    it('returns null for invalid calendar date', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": 10.00, "date": "2025-13-99"}');
      assert.equal(result.date, null);
    });

    it('returns null when date is missing', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": 10.00}');
      assert.equal(result.date, null);
    });

    it('returns null for null date value', async () => {
      const { parseJsonFromText } = await load();
      const result = parseJsonFromText('{"amount": 10.00, "date": null}');
      assert.equal(result.date, null);
    });
  });

  describe('GeminiProvider constructor', () => {
    it('throws if serviceAccount is missing', async () => {
      const { GeminiProvider } = await load();
      assert.throws(
        () => new GeminiProvider({ project: 'p' }),
        (err) => {
          assert.match(err.message, /service account/i);
          return true;
        },
      );
    });

    it('throws if project is missing', async () => {
      const { GeminiProvider } = await load();
      assert.throws(
        () => new GeminiProvider({ serviceAccount: fakeSA }),
        (err) => {
          assert.match(err.message, /project/i);
          return true;
        },
      );
    });

    it('creates valid instance with required config', async () => {
      const { GeminiProvider } = await load();
      const provider = new GeminiProvider({ serviceAccount: fakeSA, project: 'test-project' });
      assert.ok(typeof provider.extract === 'function');
      assert.strictEqual(provider.model, 'gemini-2.5-flash');
      assert.strictEqual(provider.location, 'europe-west1');
    });

    it('uses custom model and location when provided', async () => {
      const { GeminiProvider } = await load();
      const provider = new GeminiProvider({
        serviceAccount: fakeSA,
        project: 'test-project',
        location: 'us-central1',
        model: 'gemini-2.5-pro',
      });
      assert.strictEqual(provider.model, 'gemini-2.5-pro');
      assert.strictEqual(provider.location, 'us-central1');
    });
  });

  describe('createSignedJwt', () => {
    it('creates a JWT with three base64url segments', async () => {
      const { createSignedJwt } = await load();
      // Use a real RSA key for JWT signing test
      const { generateKeyPairSync } = require('node:crypto');
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const pem = privateKey.export({ type: 'pkcs1', format: 'pem' });
      const sa = { ...fakeSA, private_key: pem };

      const jwt = createSignedJwt(sa);
      const parts = jwt.split('.');
      assert.strictEqual(parts.length, 3, 'JWT should have 3 parts');

      // Decode header
      const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
      assert.strictEqual(header.alg, 'RS256');
      assert.strictEqual(header.typ, 'JWT');

      // Decode payload
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      assert.strictEqual(payload.iss, fakeSA.client_email);
      assert.strictEqual(payload.scope, 'https://www.googleapis.com/auth/cloud-platform');
      assert.ok(payload.exp > payload.iat);
    });
  });

  describe('GeminiProvider.extract() with mocked fetch', () => {
    let originalFetch;

    beforeEach(() => {
      originalFetch = globalThis.fetch;
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    function createProvider() {
      const { GeminiProvider } = arguments[0];
      const provider = new GeminiProvider({ serviceAccount: fakeSA, project: 'test-project', location: 'europe-west1' });
      // Pre-set a cached token to skip real OAuth2 exchange
      provider._accessToken = 'mock-access-token';
      provider._tokenExpiry = Date.now() + 3600000;
      return provider;
    }

    it('sends text-only payload correctly', async () => {
      const mod = await load();
      let capturedBody, capturedHeaders, capturedUrl;
      globalThis.fetch = async (url, opts) => {
        capturedUrl = url;
        capturedBody = JSON.parse(opts.body);
        capturedHeaders = opts.headers;
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"amount": 18.00, "currency": "EUR"}' }] } }],
          }),
        };
      };
      const provider = createProvider(mod);
      const result = await provider.extract('Extract amount', { text: 'TOTAL: 18.00' });
      assert.ok(capturedUrl.startsWith('https://europe-west1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/europe-west1/publishers/google/models/gemini-2.5-flash:generateContent'));
      assert.strictEqual(capturedHeaders['Authorization'], 'Bearer mock-access-token');
      assert.strictEqual(capturedBody.generationConfig.maxOutputTokens, 1024);
      assert.ok(capturedBody.contents[0].parts[0].text.includes('TOTAL: 18.00'));
      assert.deepStrictEqual(result, { amount_cents: 1800, confidence: 'high', currency: 'EUR', vendor: null, date: null });
    });

    it('sends text+image payload correctly', async () => {
      const mod = await load();
      let capturedBody;
      globalThis.fetch = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"amount": 35.00, "currency": "USD"}' }] } }],
          }),
        };
      };
      const provider = createProvider(mod);
      const result = await provider.extract('Extract amount', { text: 'TOTAL: 35.00', imageBase64: 'imgdata', mimeType: 'image/jpeg' });
      const parts = capturedBody.contents[0].parts;
      assert.strictEqual(parts.length, 2);
      assert.ok(parts[0].text);
      assert.strictEqual(parts[1].inline_data.mime_type, 'image/jpeg');
      assert.strictEqual(parts[1].inline_data.data, 'imgdata');
      assert.deepStrictEqual(result, { amount_cents: 3500, confidence: 'high', currency: 'USD', vendor: null, date: null });
    });

    it('returns null on HTTP 401', async () => {
      const mod = await load();
      globalThis.fetch = async () => ({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });
      const provider = createProvider(mod);
      const result = await provider.extract('Extract amount', { text: 'TOTAL: 10.00' });
      assert.strictEqual(result, null);
    });

    it('returns null on HTTP 429', async () => {
      const mod = await load();
      globalThis.fetch = async () => ({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      });
      const provider = createProvider(mod);
      const result = await provider.extract('Extract amount', { text: 'TOTAL: 10.00' });
      assert.strictEqual(result, null);
    });

    it('includes AbortSignal timeout', async () => {
      const mod = await load();
      let capturedSignal;
      globalThis.fetch = async (url, opts) => {
        capturedSignal = opts.signal;
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: '{"amount": 1.00}' }] } }],
          }),
        };
      };
      const provider = createProvider(mod);
      await provider.extract('Extract amount', { text: 'test' });
      assert.ok(capturedSignal instanceof AbortSignal);
    });

    it('propagates network errors from fetch', async () => {
      const mod = await load();
      globalThis.fetch = async () => {
        throw new Error('Network failure');
      };
      const provider = createProvider(mod);
      await assert.rejects(
        () => provider.extract('Extract amount', { text: 'test' }),
        (err) => {
          assert.match(err.message, /Network failure/);
          return true;
        },
      );
    });

    it('returns null when AI response has no parseable amount', async () => {
      const mod = await load();
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: 'I cannot read this receipt' }] } }],
        }),
      });
      const provider = createProvider(mod);
      const result = await provider.extract('Extract amount', { text: 'blurry text' });
      assert.strictEqual(result, null);
    });
  });
});
