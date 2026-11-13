import { describe, expect, it } from "vitest";
import { makeReceipt } from "../test/fixtures";

describe("ReceiptMeta", () => {
  it("carries the identity of the file it was read from", () => {
    const receipt = makeReceipt("acme.pdf", { identity: { size: 1200, modified_secs: 1900000000, modified_nanos: 5 } });
    expect(receipt.identity?.size).toBe(1200);
    expect(makeReceipt("globex.pdf").identity).toBeUndefined();
  });
});
