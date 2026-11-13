# Bank Statement Parser Contributor Guide

How to add a bank statement parser to Concilia. Parsers are deterministic Rust code, no AI. Follow the steps and open a PR.

## How a statement is read

```text
statement PDF
  │  poppler `pdftotext -layout` (src-tauri/src/poppler.rs), column spacing kept
  ▼
Bank::parse_text(text)                      src-tauri/src/bank/mod.rs
  │  dispatches to the bank's parser, e.g. cgd::parse_text
  ▼
Vec<RawTransaction> { date: "DD/MM/YYYY", description, amount_cents }
  │
  ▼
normalize_statements / append_statements    src-tauri/src/bank/mod.rs
  │  ISO dates, abs_cents, deterministic ids (tx-NNN-YYYY-MM-DD-…), duplicate rows dropped
  ▼
transactions.json → matcher
```

The parser only turns text into rows. Text extraction, ids, duplicates and matching happen elsewhere.

## Files to touch

| # | File | Change |
|---|---|---|
| 1 | `src-tauri/src/bank/<bank>.rs` | New parser with `pub fn parse_text(text: &str) -> Vec<RawTransaction>` and unit tests |
| 2 | `src-tauri/src/bank/mod.rs` | `pub mod <bank>;`, a `Bank` variant, a `FromStr` arm and a `parse_text` arm |
| 3 | `src/lib/statements.ts` | One entry in `BANKS` |

Nothing else changes: the pipeline, the commands and the matcher work with any `Bank`.

## Parser contract

```rust
use crate::model::RawTransaction;

/// Parses every transaction row in the statement text.
pub fn parse_text(text: &str) -> Vec<RawTransaction>
```

- **Input**: the whole statement as `pdftotext -layout` prints it, pages separated by form feeds, lines by `\n`.
- **Output**: one `RawTransaction` per transaction row, in statement order. Skip headers, totals and balance lines.
- **`date`**: `DD/MM/YYYY`. Use the posting date when the statement shows several.
- **`description`**: trimmed, runs of whitespace collapsed to one space. The matcher compares it with receipt vendors and file names.
- **`amount_cents`**: signed integer cents, negative for a debit. Use `crate::schema::euro_str_to_cents` for `1.234,56` amounts.
- No ids and no status: normalization adds them.
- Return an empty `Vec` for text that is not this bank's statement. Do not panic.

## Step 1: write the parser

Copy `src-tauri/src/bank/cgd.rs` as the reference. Its shape:

```rust
//! Parser for <Bank> statements, from `pdftotext -layout` output.

use std::sync::LazyLock;

use regex::Regex;

use crate::model::RawTransaction;
use crate::schema::euro_str_to_cents;

static TX_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(\d{2})/(\d{2})/(\d{4})\s+(.+?)\s+(-?[0-9.]+,[0-9]{2})\s*$")
        .expect("line pattern compiles")
});

fn parse_line(line: &str) -> Option<RawTransaction> {
    let c = TX_LINE.captures(line)?;
    let description = c[4].split_whitespace().collect::<Vec<_>>().join(" ");
    Some(RawTransaction {
        date: format!("{}/{}/{}", &c[1], &c[2], &c[3]),
        description,
        amount_cents: euro_str_to_cents(&c[5]).ok()?,
    })
}

/// Parses every transaction row in the statement text.
pub fn parse_text(text: &str) -> Vec<RawTransaction> {
    text.split('\n').filter_map(parse_line).collect()
}
```

To see the text your parser gets, run `pdftotext -layout statement.pdf -` on a statement of your own. Keep that output out of the repository.

## Step 2: register the bank

In `src-tauri/src/bank/mod.rs`:

```rust
pub mod cgd;
pub mod yourbank;                        // ← add

pub enum Bank {
    Cgd,
    YourBank,                            // ← add; serializes as "yourbank"
}

// FromStr
"cgd" => Ok(Bank::Cgd),
"yourbank" => Ok(Bank::YourBank),        // ← add

// Bank::parse_text
Bank::Cgd => cgd::parse_text(text),
Bank::YourBank => yourbank::parse_text(text),   // ← add
```

The key is the lowercase variant name. Keep it short and alphanumeric.

## Step 3: add the bank to the app

In `src/lib/statements.ts`:

```ts
export const BANKS = [
  { value: "cgd", label: "CGD" },
  { value: "yourbank", label: "Your Bank" },   // ← add
];
```

`value` must equal the key from step 2. `label` names the bank in the app. With two or more banks, each statement row gets a bank pop-up.

## Step 4: tests

Put unit tests in a `#[cfg(test)] mod tests` at the bottom of the parser, as `cgd.rs` does: a standard row, a credit, thousands separators, collapsed whitespace, and lines that are not rows.

**Fabricate every value.** Never copy text, names, amounts or dates from a real statement into a test, a fixture or a commit, even if they look generic. Use names such as `ACME CORP` and `EXAMPLE FEE`, round amounts, and dates such as 2030. Keep only the layout: column widths, separators and date format.

For an end-to-end check through poppler, `src-tauri/tests/common/mod.rs` has `pdf_with_lines`, which builds a one-page PDF from text lines.

```bash
cd src-tauri
cargo test bank::
cargo test
cargo fmt --check && cargo clippy --all-targets -- -D warnings
cd .. && npm test
```

## Checklist

- [ ] `src-tauri/src/bank/<bank>.rs` with `parse_text` and unit tests
- [ ] `Bank` variant, `FromStr` arm and `parse_text` arm in `bank/mod.rs`
- [ ] `BANKS` entry in `src/lib/statements.ts`
- [ ] Every test value fabricated
- [ ] `cargo test`, `cargo clippy` and `npm test` pass
- [ ] The bank added to **Supported Banks** in `README.md`
