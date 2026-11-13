# Test fixtures

All data here is fabricated.

- `golden/`: outputs of the original Node implementation for generated inputs, written by
  `scripts/golden/dump.mjs`.
- `golden/excel.json` holds the report's current wording, not the Node wording. Running
  `scripts/golden/dump.mjs` again restores the Node labels, so apply the wording changes in
  `golden/DIFFERENCES.md` to the new file.
