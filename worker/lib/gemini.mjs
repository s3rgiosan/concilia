/**
 * Google Gemini AI provider for receipt extraction (Vertex AI).
 *
 * Exports GeminiProvider class, RECEIPT_PROMPT, and parseJsonFromText.
 * Zero npm dependencies — uses native fetch and node:crypto for JWT auth.
 */

import { createSign } from 'node:crypto';
import { readFileSync, openSync, writeSync, closeSync, constants as fsConstants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { euroToCents } from './schema.mjs';

/**
 * Prompt for receipt amount and currency extraction.
 */
export const RECEIPT_PROMPT = `Extract the total amount, vendor name, and issue date from this receipt or invoice.

RULES:
1. Find the FINAL TOTAL AMOUNT PAYABLE (the amount the customer paid or owes).
2. IGNORE subtotals, line item prices, unit prices, quantities, and amounts before discount.
3. Look for Portuguese keywords: "Total", "Total da Fatura", "Valor a Pagar", "Total Pago", "Total Recebido", "Valor Recebido", "Valor Pago", "Total Docum.", "Valor Total", "Montante Total".
4. Look for English keywords: "Total", "Total Paid", "Amount Paid", "Total Due", "Grand Total".
5. The total is usually in bold or larger font near the bottom of the document.
6. Use the final amount after all taxes, discounts, and fees are applied.
7. If a currency symbol (€, $, £) or code (EUR, USD, GBP) is shown, extract it. If no currency is shown, assume EUR.
8. Extract the vendor/merchant/company name (who issued the receipt).
9. Extract the issue or payment date as ISO 8601 (YYYY-MM-DD). Look for English ("Date", "Issue date", "Invoice date", "Receipt date", "Payment date", "Paid on") and Portuguese ("Data", "Data de emissão", "Data do documento", "Data de pagamento") keywords. Prefer the issue/invoice date over due dates. If multiple dates exist (e.g. invoice + due), use the issue/payment date. If no date is readable, return null.

Return ONLY valid JSON: {"amount":99.99,"currency":"EUR","vendor":"Company Name","date":"2025-11-14"}
If unreadable, return {"error":"unreadable"}`;


/**
 * Parse a JSON object containing { amount, currency } from AI response text.
 * Handles clean JSON, markdown-wrapped JSON, error responses, and non-numeric amounts.
 *
 * @param {string} text - Raw AI response text
 * @returns {{ amount_cents: number, confidence: string, currency: string | null } | null}
 */
export function parseJsonFromText(text) {
  if (!text || typeof text !== 'string') return null;

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    try {
      data = JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }

  if (data.error) return null;
  if (typeof data.amount !== 'number') return null;

  const amountCents = euroToCents(data.amount);

  const SYMBOL_MAP = { '$': 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', 'R$': 'BRL' };
  let currency = null;
  if (typeof data.currency === 'string') {
    const raw = data.currency.trim();
    currency = SYMBOL_MAP[raw] ?? (raw.length === 3 ? raw.toUpperCase() : null);
  }

  const vendor = typeof data.vendor === 'string' && data.vendor.trim().length > 0
    ? data.vendor.trim()
    : null;

  let date = null;
  if (typeof data.date === 'string') {
    const trimmed = data.date.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed) && !Number.isNaN(Date.parse(trimmed))) {
      date = trimmed;
    }
  }

  return { amount_cents: Math.abs(amountCents), confidence: 'high', currency, vendor, date };
}

/**
 * Base64url encode a buffer or string (no padding).
 */
function base64url(input) {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64url');
}

/**
 * Create a signed JWT for Google OAuth2 service account auth.
 *
 * @param {object} serviceAccount - Parsed service account JSON key
 * @returns {string} Signed JWT assertion
 */
export function createSignedJwt(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
  }));
  const signInput = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(signInput);
  const signature = sign.sign(serviceAccount.private_key, 'base64url');
  return `${signInput}.${signature}`;
}

/**
 * Exchange a signed JWT for a Google OAuth2 access token.
 *
 * @param {string} jwt - Signed JWT assertion
 * @returns {Promise<string>} Access token
 */
async function getAccessToken(jwt) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new Error(`OAuth2 token exchange failed (${res.status}): ${errBody}`);
  }
  const json = await res.json();
  return json.access_token;
}

/**
 * Google Gemini provider — Vertex AI API with service account auth.
 */
export class GeminiProvider {
  /**
   * @param {object} config
   * @param {object} config.serviceAccount - Parsed service account JSON key
   * @param {string} config.project - GCP project ID
   * @param {string} [config.location] - GCP region (default: europe-west1)
   * @param {string} [config.model] - Model ID (default: gemini-2.5-flash)
   */
  constructor(config) {
    if (!config.serviceAccount) {
      throw new Error('Gemini provider requires service account key (set AI_GEMINI_SA_KEY)');
    }
    if (!config.project) {
      throw new Error('Gemini provider requires GCP project ID (set AI_GEMINI_PROJECT)');
    }
    this.serviceAccount = config.serviceAccount;
    this.project = config.project;
    this.location = config.location || 'europe-west1';
    this.model = config.model || 'gemini-2.5-flash';
    this._accessToken = null;
    this._tokenExpiry = 0;
  }

  async _getToken() {
    const now = Date.now();
    // In-process cache
    if (this._accessToken && now < this._tokenExpiry - 300000) {
      return this._accessToken;
    }
    // File-based cache — survives across child process spawns. Sanitize the
    // key id (hex/alnum only) to prevent path traversal via a malformed SA key.
    const rawId = String(this.serviceAccount.private_key_id || '');
    const safeId = rawId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128) || 'default';
    const cacheFile = join(tmpdir(), `concilia-token-${safeId}.json`);
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
      if (cached.client_email === this.serviceAccount.client_email && cached.expiry > now + 300000) {
        this._accessToken = cached.token;
        this._tokenExpiry = cached.expiry;
        return this._accessToken;
      }
    } catch { /* cache missing or invalid */ }

    const jwt = createSignedJwt(this.serviceAccount);
    this._accessToken = await getAccessToken(jwt);
    this._tokenExpiry = now + 3600000;
    try {
      // Open with explicit mode so the file is 0o600 from the moment it
      // exists on disk (no chmod-after-write race window).
      const fd = openSync(
        cacheFile,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
        0o600,
      );
      try {
        writeSync(fd, JSON.stringify({
          token: this._accessToken,
          expiry: this._tokenExpiry,
          client_email: this.serviceAccount.client_email,
        }));
      } finally {
        closeSync(fd);
      }
    } catch { /* non-fatal */ }
    return this._accessToken;
  }

  async _call(parts) {
    const token = await this._getToken();
    const url = `https://${this.location}-aiplatform.googleapis.com/v1beta1/projects/${this.project}/locations/${this.location}/publishers/google/models/${this.model}:generateContent`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: 1024 },
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      console.error(`[gemini] HTTP ${res.status}: ${errBody}`);
      return null;
    }
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      const finishReason = json.candidates?.[0]?.finishReason;
      console.error(`[gemini] empty response — finishReason: ${finishReason ?? 'none'}, promptFeedback: ${JSON.stringify(json.promptFeedback ?? {})}`);
    }
    return text || '';
  }

  _buildContent(prompt, payload) {
    const parts = [];
    parts.push({ text: payload.text ? prompt + '\n\nReceipt text:\n' + payload.text : prompt });
    if (payload.imageBase64) {
      parts.push({
        inline_data: {
          mime_type: payload.mimeType || 'image/png',
          data: payload.imageBase64,
        },
      });
    }
    return parts;
  }

  async extract(prompt, payload) {
    // First attempt
    const text = await this._call(this._buildContent(prompt, payload));
    if (text === null) return null;

    const result = parseJsonFromText(text);
    if (result) return result;

    // Log failed response for debugging
    console.error(`[gemini] Failed to parse response, retrying: ${text}`);

    // Retry with a focused prompt (keeps context for Portuguese receipts)
    const retryPrompt = 'What is the final total amount, vendor name, and issue date on this receipt or invoice? Look for "Total", "Valor a Pagar", "Total Pago", "Total Recebido", "Valor Recebido", or "Montante Total". If currency symbol (€, $, £) is shown, extract it. If none, assume EUR. Date as YYYY-MM-DD or null if missing. Reply with ONLY: {"amount":99.99,"currency":"EUR","vendor":"Company Name","date":"2025-11-14"}';
    const retryText = await this._call(this._buildContent(retryPrompt, payload));
    if (retryText === null) return null;

    const retryResult = parseJsonFromText(retryText);
    if (!retryResult) {
      console.error(`[gemini] Retry also failed: ${retryText}`);
    }
    return retryResult;
  }
}
