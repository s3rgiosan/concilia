// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiptUrl } from "../lib/tauri";
import { makeReceipt } from "../test/fixtures";
import { ReceiptPreview } from "./ReceiptPreview";
import { fileName, isImage, receiptTitle } from "./receipts";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  receiptUrl: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(receiptUrl).mockImplementation((path) => `receipt://localhost/${path}`);
});

afterEach(cleanup);

describe("ReceiptPreview", () => {
  it("frames a PDF without the sidebar", () => {
    render(<ReceiptPreview receipt={makeReceipt("acme.pdf")} />);
    expect(screen.getByTitle("acme.pdf").getAttribute("src")).toBe("receipt://localhost/2030/03/receipts/acme.pdf#navpanes=0");
  });

  it("shows an image", () => {
    render(<ReceiptPreview receipt={makeReceipt("acme.JPG")} />);
    expect(screen.getByRole("img", { name: "acme.JPG" }).getAttribute("src")).toBe("receipt://localhost/2030/03/receipts/acme.JPG");
  });

  it("says there is no preview without a path", () => {
    render(<ReceiptPreview receipt={makeReceipt("acme.pdf", { rel_path: null })} />);
    expect(screen.getByText("No Preview")).toBeTruthy();
    cleanup();
    render(<ReceiptPreview receipt={null} />);
    expect(screen.getByText("No Preview")).toBeTruthy();
  });
});

describe("receipt names", () => {
  it("names a receipt by vendor, else by file", () => {
    expect(fileName("/receipts/2030/03/receipts/acme.pdf")).toBe("acme.pdf");
    expect(receiptTitle(makeReceipt("acme.pdf", { vendor: "ACME" }))).toBe("ACME");
    expect(receiptTitle(makeReceipt("acme.pdf", { vendor: null }))).toBe("acme.pdf");
  });

  it("tells images from PDFs", () => {
    expect(isImage("a.png")).toBe(true);
    expect(isImage("a.jpeg")).toBe(true);
    expect(isImage("a.pdf")).toBe(false);
  });
});
