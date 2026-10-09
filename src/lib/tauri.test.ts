import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
const convertFileSrc = vi.fn((path: string, protocol: string) => `${protocol}://localhost/${encodeURIComponent(path)}`);

vi.mock("@tauri-apps/api/core", () => ({ invoke, convertFileSrc }));

const { popplerStatus, receiptUrl } = await import("./tauri");

beforeEach(() => {
  invoke.mockReset();
});

describe("popplerStatus", () => {
  it("invokes the backend command", async () => {
    invoke.mockResolvedValue({ version: "1.0.0", bundled: true });
    await expect(popplerStatus()).resolves.toEqual({ version: "1.0.0", bundled: true });
    expect(invoke).toHaveBeenCalledWith("poppler_status");
  });
});

describe("receiptUrl", () => {
  it("encodes the period-relative path on the receipt scheme", () => {
    expect(receiptUrl("2030/03/receipts/acme.pdf")).toBe("receipt://localhost/2030%2F03%2Freceipts%2Facme.pdf");
    expect(convertFileSrc).toHaveBeenCalledWith("2030/03/receipts/acme.pdf", "receipt");
  });
});
