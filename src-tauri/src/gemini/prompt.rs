//! Prompts sent to Gemini with each receipt.

/// Asks for the total, currency, vendor and issue date as JSON.
pub const RECEIPT_PROMPT: &str = r#"Extract the total amount, vendor name, and issue date from this receipt or invoice.

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
If unreadable, return {"error":"unreadable"}"#;

/// A shorter prompt for a second attempt when the first reply had no usable JSON.
pub const RETRY_PROMPT: &str = r#"What is the final total amount, vendor name, and issue date on this receipt or invoice? Look for "Total", "Valor a Pagar", "Total Pago", "Total Recebido", "Valor Recebido", or "Montante Total". If currency symbol (€, $, £) is shown, extract it. If none, assume EUR. Date as YYYY-MM-DD or null if missing. Reply with ONLY: {"amount":99.99,"currency":"EUR","vendor":"Company Name","date":"2025-11-14"}"#;
