// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receiptUrl, type ReceiptMeta } from "../lib/tauri";
import { makeReceipt } from "../test/fixtures";
import { PreviewPane } from "./PreviewPane";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  receiptUrl: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(receiptUrl).mockImplementation((path) => `receipt://localhost/${path}`);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPane(receipt: ReceiptMeta | null) {
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const { container } = render(<PreviewPane receipt={receipt} onOpen={onOpen} onClose={onClose} />);
  return { onOpen, onClose, container };
}

describe("PreviewPane", () => {
  it("asks for a receipt when none is selected", () => {
    renderPane(null);
    const pane = screen.getByRole("complementary", { name: "Preview" });
    expect(pane.textContent).toBe("Select a receipt to preview it.");
    expect(receiptUrl).not.toHaveBeenCalled();
  });

  it("shows the empty state for a receipt without a preview path", () => {
    renderPane(makeReceipt("acme.pdf", { rel_path: null }));
    expect(screen.getByText("Select a receipt to preview it.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open in Preview" })).toBeNull();
  });

  it("frames a PDF", () => {
    const { container } = renderPane(makeReceipt("acme.pdf"));
    expect(receiptUrl).toHaveBeenCalledWith("2030/03/receipts/acme.pdf");
    const frame = screen.getByTitle("acme.pdf") as HTMLIFrameElement;
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("src")).toBe("receipt://localhost/2030/03/receipts/acme.pdf#navpanes=0");
    expect(container.querySelector("img")).toBeNull();
  });

  it.each(["globex.png", "hooli.jpg", "initech.JPEG"])("shows %s as an image", (name) => {
    const { container } = renderPane(makeReceipt(name));
    const image = screen.getByRole("img", { name }) as HTMLImageElement;
    expect(image.getAttribute("src")).toBe(`receipt://localhost/2030/03/receipts/${name}`);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("names the file", () => {
    const { container } = renderPane(makeReceipt("acme.pdf"));
    const name = container.querySelector(".preview__name");
    expect(name?.textContent).toBe("acme.pdf");
    expect(name?.getAttribute("title")).toBe("/receipts/2030/03/receipts/acme.pdf");
  });

  it("opens the receipt in Preview", () => {
    const receipt = makeReceipt("acme.pdf");
    const { onOpen } = renderPane(receipt);
    fireEvent.click(screen.getByRole("button", { name: "Open in Preview" }));
    expect(onOpen).toHaveBeenCalledWith(receipt);
  });

  it("closes", () => {
    const { onClose } = renderPane(makeReceipt("acme.pdf"));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
