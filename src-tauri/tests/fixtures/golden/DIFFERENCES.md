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
