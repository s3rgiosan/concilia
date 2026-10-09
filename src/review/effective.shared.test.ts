// Review cases shared with the backend's tests (src-tauri/tests/review.rs), so the pool shown
// here and the one Finalize sorts stay the same.
import { describe, expect, it } from "vitest";
import fixture from "../../src-tauri/tests/fixtures/review/cases.json";
import type { Draft, ReceiptMeta, Status, Transaction } from "../lib/tauri";
import { mergeDraft, unmatchedPool } from "./effective";

const transactions = fixture.result.transactions as Transaction[];
const unmatched = fixture.result.unmatchedReceipts as ReceiptMeta[];

describe("shared review cases", () => {
  for (const c of fixture.cases) {
    it(c.name, () => {
      const merged = mergeDraft(transactions, c.draft as unknown as Draft);
      for (const [id, status] of Object.entries(c.statuses)) {
        expect(merged.find((t) => t.id === id)?.status, id).toBe(status as Status);
      }
      const pool = unmatchedPool({ transactions, unmatched_receipts: unmatched }, merged).map((r) => r.file);
      expect(pool).toEqual(c.pool);
    });
  }
});
