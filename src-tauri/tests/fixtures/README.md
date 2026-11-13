# Test fixtures

All data here is fabricated.

- `golden/`: outputs of the original Node implementation for generated inputs, written by
  `scripts/golden/dump.mjs`.
- `golden/excel.json` holds the report's current wording, and `golden/gemini_parse.json` clears
  impossible calendar dates. `scripts/golden/dump.mjs` applies these changes from
  `golden/DIFFERENCES.md` to the Node output, so CI can check the fixtures are current.
