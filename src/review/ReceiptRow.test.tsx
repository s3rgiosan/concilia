// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeReceipt } from "../test/fixtures";
import { ReceiptRow } from "./ReceiptRow";

afterEach(cleanup);

function renderRow(props: Partial<Parameters<typeof ReceiptRow>[0]> = {}) {
  const handlers = { onFocus: vi.fn(), onRescan: vi.fn(), onOpen: vi.fn() };
  const { container } = render(
    <ul>
      <ReceiptRow receipt={makeReceipt("acme.pdf", { vendor: "ACME" })} focused={false} txAbsCents={null} rescanning={false} {...handlers} {...props} />
    </ul>,
  );
  return { container, ...handlers };
}

function menuButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Actions for / }) as HTMLButtonElement;
}

function pick(item: string) {
  fireEvent.click(menuButton());
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

describe("ReceiptRow", () => {
  it("shows the vendor, amount, date and file name", () => {
    const { container } = renderRow();
    expect(container.querySelector(".receipt-row__title")?.textContent).toBe("ACME");
    expect(container.querySelector(".receipt-row__amount")?.textContent).toBe("€10.00");
    expect(container.querySelector(".receipt-row__meta")?.textContent).toBe("5 Maracme.pdf");
  });

  it("gives the vendor and the file name a tooltip with the full text", () => {
    const { container } = renderRow({ receipt: makeReceipt("a-long-file-name-for-an-acme-receipt.pdf", { vendor: "ACME Industrial Supplies Limited" }) });
    expect(container.querySelector(".receipt-row__title")?.getAttribute("title")).toBe("ACME Industrial Supplies Limited");
    expect(container.querySelector(".receipt-row__file")?.getAttribute("title")).toBe("a-long-file-name-for-an-acme-receipt.pdf");
  });

  it("falls back to the file name and says what is unknown", () => {
    const { container } = renderRow({
      receipt: makeReceipt("scan.pdf", { vendor: null, amount_cents: null, date: null, confidence: "low" }),
    });
    expect(container.querySelector(".receipt-row__title")?.textContent).toBe("scan.pdf");
    expect(container.querySelector(".receipt-row__amount")).toBeNull();
    expect(container.querySelector(".receipt-row__meta")?.textContent).toBe("Date unknownunsure reading");
  });

  it("says when Gemini couldn't read it and reads it again from the row", () => {
    const unread = makeReceipt("scan.pdf", { vendor: null, amount_cents: null, confidence: null });
    const { onRescan } = renderRow({ receipt: unread });
    expect(screen.getByText("Couldn't read this receipt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Read scan.pdf Again" }));
    expect(onRescan).toHaveBeenCalledTimes(1);
    cleanup();
    renderRow({ receipt: unread, rescanning: true });
    expect((screen.getByRole("button", { name: "Read scan.pdf Again" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderRow({ receipt: unread, readOnly: true });
    expect(screen.getByText("Couldn't read this receipt")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Read scan.pdf Again" })).toBeNull();
    cleanup();
    renderRow();
    expect(screen.queryByText("Couldn't read this receipt")).toBeNull();
  });

  it("says how much the amount differs", () => {
    renderRow({ txAbsCents: 2500 });
    expect(screen.getByText("Differs by €15.00")).toBeTruthy();
    cleanup();
    renderRow({ receipt: makeReceipt("acme.pdf", { vendor: "ACME", currency: "USD" }), txAbsCents: 5000 });
    expect(screen.getByText("Differs by more than 10% (USD receipt)")).toBeTruthy();
  });

  it("focuses on click and shows it is focused", () => {
    const { onFocus } = renderRow();
    fireEvent.click(screen.getByRole("button", { pressed: false }));
    expect(onFocus).toHaveBeenCalledTimes(1);
    cleanup();
    const { container } = renderRow({ focused: true });
    expect(container.querySelector(".receipt-row--focused")).toBeTruthy();
  });

  it("marks the receipt in the preview with an eye, not a fill", () => {
    const { container } = renderRow({ focused: true });
    expect(container.querySelector(".receipt-row__marker .symbol--eye")).toBeTruthy();
    cleanup();
    const other = renderRow();
    expect(other.container.querySelector(".receipt-row__marker .symbol--eye")).toBeNull();
  });

  it("rescans and opens from its menu", () => {
    const { onRescan, onOpen } = renderRow();
    expect(menuButton().getAttribute("aria-label")).toBe("Actions for ACME");
    expect(menuButton().getAttribute("aria-haspopup")).toBe("menu");
    pick("Read Again");
    pick("Open");
    expect(onRescan).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("offers the same commands on a right click, showing the receipt first", () => {
    const { container, onFocus, onOpen } = renderRow();
    fireEvent.contextMenu(container.querySelector("li")!, { clientX: 10, clientY: 10 });
    expect(onFocus).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("disables the menu a receipt without a path cannot use", () => {
    renderRow({ receipt: makeReceipt("acme.pdf", { rel_path: null }) });
    expect(menuButton().disabled).toBe(true);
  });

  it("shows a spinner and disables Read Again while rescanning", () => {
    renderRow({ rescanning: true });
    expect(screen.getByRole("status", { name: "Reading…" })).toBeTruthy();
    fireEvent.click(menuButton());
    expect((screen.getByRole("menuitem", { name: "Read Again" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("cannot be read again when read-only", () => {
    renderRow({ readOnly: true });
    fireEvent.click(menuButton());
    expect((screen.getByRole("menuitem", { name: "Read Again" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("menuitem", { name: "Open" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("runs its decision button", () => {
    const onAssign = vi.fn();
    const receipt = makeReceipt("acme.pdf", { vendor: "ACME" });
    renderRow({ receipt, onAssign });
    expect(screen.getByText("Assign").textContent).toBe("Assign");
    fireEvent.click(screen.getByRole("button", { name: "Assign ACME" }));
    expect(onAssign).toHaveBeenCalledExactlyOnceWith(receipt);
  });
});
