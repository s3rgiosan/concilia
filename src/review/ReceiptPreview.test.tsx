// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiptUrl } from "../lib/tauri";
import { makeReceipt } from "../test/fixtures";
import { ReceiptPreview } from "./ReceiptPreview";
import { isImage, receiptTitle } from "./receipts";

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
    expect(screen.getByTitle("Preview of acme.pdf").getAttribute("src")).toBe("receipt://localhost/2030/03/receipts/acme.pdf#navpanes=0");
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

describe("ReceiptPreview with a delay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const frameSource = () => screen.getByTitle(/^Preview of /).getAttribute("src");

  it("shows the first receipt at once", () => {
    render(<ReceiptPreview receipt={makeReceipt("a.pdf")} delayMs={120} />);
    expect(frameSource()).toContain("a.pdf");
  });

  it("loads a new receipt only after it has stayed for the delay", () => {
    const { rerender } = render(<ReceiptPreview receipt={makeReceipt("a.pdf")} delayMs={120} />);
    for (const name of ["b.pdf", "c.pdf", "d.pdf"]) {
      rerender(<ReceiptPreview receipt={makeReceipt(name)} delayMs={120} />);
      act(() => {
        vi.advanceTimersByTime(50);
      });
      expect(frameSource()).toContain("a.pdf");
    }
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(frameSource()).toContain("d.pdf");
  });

  it("says there is no preview at once", () => {
    const { rerender } = render(<ReceiptPreview receipt={makeReceipt("a.pdf")} delayMs={120} />);
    rerender(<ReceiptPreview receipt={makeReceipt("b.pdf", { rel_path: null })} delayMs={120} />);
    expect(screen.getByText("No Preview")).toBeTruthy();
    expect(screen.queryByTitle(/^Preview of /)).toBeNull();
  });
});

describe("ReceiptPreview suspended", () => {
  it("leaves the frame out while the same file shows elsewhere", () => {
    const receipt = makeReceipt("a.pdf");
    const { rerender, container } = render(<ReceiptPreview receipt={receipt} suspended />);
    expect(screen.queryByTitle(/^Preview of /)).toBeNull();
    expect(container.querySelector(".receipt-preview")).toBeTruthy();
    rerender(<ReceiptPreview receipt={receipt} />);
    expect(screen.getByTitle("Preview of a.pdf")).toBeTruthy();
  });
});

describe("receipt names", () => {
  it("names a receipt by vendor, else by file", () => {
    expect(receiptTitle(makeReceipt("acme.pdf", { vendor: "ACME" }))).toBe("ACME");
    expect(receiptTitle(makeReceipt("acme.pdf", { vendor: null }))).toBe("acme.pdf");
  });

  it("tells images from PDFs", () => {
    expect(isImage("a.png")).toBe(true);
    expect(isImage("a.jpeg")).toBe(true);
    expect(isImage("a.pdf")).toBe(false);
  });
});
