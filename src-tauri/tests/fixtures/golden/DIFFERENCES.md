# Intended differences from the Node implementation

The golden fixtures record the Node worker's output for fabricated inputs. The Rust port
matches them except where it deliberately behaves differently, listed here. Inputs that would
show these differences are kept out of the fixtures.

- **European decimal strings with more than two decimals.** Node parses through a float, so
  `1,005` becomes 100 cents (`1.005 * 100` is `100.49999…`). Rust parses the digits and rounds
  half away from zero, giving 101. Statement amounts always have exactly two decimals.
- **Malformed amount strings.** Node turns `abc` into `NaN`; Rust returns an error.
- **Receipt dates other than `YYYY-MM-DD`.** Node's `Date.parse` accepts other formats when
  comparing dates; Rust treats them as undated. Stored receipt dates are always
  `YYYY-MM-DD`.
- **Impossible calendar dates.** Node's `Date.parse` rolls a day past the end of the month
  into the next month, so it keeps a receipt date such as `2030-02-30`. Rust reads it as no
  date. `scripts/golden/dump.mjs` clears such dates in the Gemini reply fixture.
- **A receipt with no `amount_cents` key.** Node tells a missing key from `null` in the
  filename pass; Rust reads both as no amount. Stored receipts always carry the key.
- **Sorting receipt paths.** Node compares UTF-16 code units, Rust compares bytes; they only
  differ for characters outside the Basic Multilingual Plane.
- **Finalize.** A file referenced more than once, or two files sharing a name, get one
  destination each with a numeric suffix on clashes, and existing files are never
  overwritten. Node could record paths that did not match the disk.
- **Receipts left out of a confirmed REVIEW.** When the user confirms a REVIEW transaction
  with one of its candidates, the other candidates return to the unmatched receipts, so the
  review screen can assign them and Finalize moves them to `_unmatched`. Node dropped them
  from the records and left them in `receipts/`.
- **REVIEW candidates that a later transaction takes.** Node left a receipt in a REVIEW
  transaction's candidates after a later transaction MATCHED it, so it sat in the matched and
  review lists at once. Rust removes it from the REVIEW candidates at the end of matching. The
  transaction stays REVIEW with the rest, or becomes UNMATCHED with empty notes when none is
  left, and a count at the start of its notes follows. `tests/golden.rs` applies the same change
  to Node's output before comparing.
- **Rule matches check the amount.** Node MATCHED a transaction to the one receipt sharing a
  rule's keywords, whatever its amount. Rust MATCHES it only when the receipt's amount fits:
  exactly for EUR or an unknown currency, within ±10% for a foreign currency. Several fitting
  receipts are REVIEW with `rule_match (vendor)`. When no receipt of any matching rule fits, the
  transaction is REVIEW with `rule_match_amount (vendor)` and every receipt sharing the first
  rule's keywords. A later rule with a fitting receipt wins over an earlier one without. The
  matcher fixtures keep the Node output; `tests/golden.rs` lists the indexes of the cases where
  Node settled a rule hit on a receipt that does not fit, and checks Rust's rule notes in
  those cases. It compares every other case in full.
- **Finalize input.** Finalize derives the reviewed state from `match-result.json` and the
  saved draft, and only touches receipts inside the period's `receipts/` folder. Node took
  both lists from the review screen.
- **Report labels.** The Rust report words some sheet names and labels differently. The
  Excel fixture holds the current wording, with the width of each column that changed
  recomputed from its longest cell. `scripts/golden/dump.mjs` applies this to the Node output,
  and `tests/excel.rs` compares it as it is. English: sheet
  `Validated` is `All Transactions`, sheet `Review` is `Needs Review`, the totals header
  `Label` is `Category`, and "FX" in notes reads "Foreign-currency". Portuguese: sheet
  `Validados` is `Todas as transações`, `Revisão` is `Por rever`, `Sem Associação` is
  `Sem associação`, the capitalised words in column headers are lower case ("Data da
  transação", "Ficheiro do recibo", …), "Regra de correspondência" is "Regra de associação",
  and "FX" in notes reads "moeda estrangeira".
- **No-receipt reasons in notes.** The report names a no-receipt transaction by its reason's
  name, which the user can change in Settings. With the shipped reasons, "Bank fee (auto)" reads
  "Bank Fee" and "No receipt" reads "Other"; in Portuguese, "Comissão bancária (auto)" reads
  "Comissão bancária" and "Sem recibo" reads "Outro".
