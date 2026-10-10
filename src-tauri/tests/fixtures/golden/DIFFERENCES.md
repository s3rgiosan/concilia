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
- **Finalize input.** Finalize derives the reviewed state from `match-result.json` and the
  saved draft, and only touches receipts inside the period's `receipts/` folder. Node took
  both lists from the review screen.
- **Report labels.** The Rust report words some sheet names and labels differently. The
  fixtures keep the Node wording; `tests/excel.rs` maps it to the current wording before
  comparing, and recomputes the width of any column whose labels changed. English: sheet
  `Validated` is `All Transactions`, sheet `Review` is `Needs Review`, the totals header
  `Label` is `Category`, and "FX" in notes reads "Foreign-currency". Portuguese: sheet
  `Validados` is `Todas as transações`, `Revisão` is `Por rever`, `Sem Associação` is
  `Sem associação`, the capitalised words in column headers are lower case ("Data da
  transação", "Ficheiro do recibo", …), "Regra de correspondência" is "Regra de associação",
  and "FX" in notes reads "moeda estrangeira".
