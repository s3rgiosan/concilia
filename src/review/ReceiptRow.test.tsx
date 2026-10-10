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
      <ReceiptRow receipt={makeReceipt("acme.pdf", { vendor: "ACME" })} focused={false} mismatch={null} rescanning={false} {...handlers} {...props} />
    </ul>,
  );
  return { container, ...handlers };
}

function pick(item: string) {
  const menu = screen.getByRole("combobox") as HTMLSelectElement;
  const option = Array.from(menu.options).find((o) => o.textContent === item)!;
  fireEvent.change(menu, { target: { value: option.value } });
}

describe("ReceiptRow", () => {
  it("shows the vendor, amount, date and file name", () => {
    const { container } = renderRow();
    expect(container.querySelector(".receipt-row__title")?.textContent).toBe("ACME");
    expect(container.querySelector(".receipt-row__amount")?.textContent).toBe("€10.00");
    expect(container.querySelector(".receipt-row__meta")?.textContent).toBe("5 Maracme.pdf");
  });

  it("falls back to the file name and says what is unknown", () => {
    const { container } = renderRow({
      receipt: makeReceipt("scan.pdf", { vendor: null, amount_cents: null, date: null, confidence: "low" }),
    });
    expect(container.querySelector(".receipt-row__title")?.textContent).toBe("scan.pdf");
    expect(container.querySelector(".receipt-row__amount")).toBeNull();
    expect(container.querySelector(".receipt-row__meta")?.textContent).toBe("Date unknownunsure reading");
  });

  it("says how much the amount differs", () => {
    renderRow({ mismatch: { kind: "amount", cents: 1500 } });
    expect(screen.getByText("Differs by €15.00")).toBeTruthy();
    cleanup();
    renderRow({ receipt: makeReceipt("acme.pdf", { vendor: "ACME", currency: "USD" }), mismatch: { kind: "fx" } });
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

  it("rescans and opens from its menu", () => {
    const { onRescan, onOpen } = renderRow();
    expect(screen.getByRole("combobox", { name: "Actions for ACME" })).toBeTruthy();
    pick("Read Again");
    pick("Open in Preview");
    expect(onRescan).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("disables the menu items a receipt without a path cannot run", () => {
    renderRow({ receipt: makeReceipt("acme.pdf", { rel_path: null }) });
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
  });

  it("shows a spinner and disables Read Again while rescanning", () => {
    renderRow({ rescanning: true });
    expect(screen.getByRole("status", { name: "Reading…" })).toBeTruthy();
    const menu = screen.getByRole("combobox") as HTMLSelectElement;
    expect(Array.from(menu.options).find((o) => o.textContent === "Read Again")?.disabled).toBe(true);
  });

  it("runs its decision button", () => {
    const onClick = vi.fn();
    renderRow({ action: { label: "Assign", accessibleName: "Assign ACME", onClick } });
    expect(screen.getByText("Assign").textContent).toBe("Assign");
    fireEvent.click(screen.getByRole("button", { name: "Assign ACME" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
