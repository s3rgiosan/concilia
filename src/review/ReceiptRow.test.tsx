// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeReceipt } from "../test/fixtures";
import { ReceiptRow, type ReceiptAction } from "./ReceiptRow";

afterEach(() => {
  cleanup();
});

function renderRow(props: Partial<Parameters<typeof ReceiptRow>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <ul>
      <ReceiptRow receipt={makeReceipt("acme.pdf", { vendor: "ACME" })} mismatch={false} selected={false} onSelect={onSelect} actions={[]} {...props} />
    </ul>,
  );
  return { onSelect, row: screen.getByRole("listitem") };
}

describe("ReceiptRow", () => {
  it("shows the vendor, file, date, reason and amount", () => {
    const { row } = renderRow({ reason: "Amount match" });
    const main = screen.getByRole("button", { pressed: false });
    expect(main.textContent).toBe("ACMEacme.pdf2030-03-05Amount match");
    expect(row.querySelector(".receipt__amount")?.textContent).toBe("€10.00");
  });

  it("shows the file name in place of a missing vendor", () => {
    const { row } = renderRow({ receipt: makeReceipt("globex.pdf") });
    expect(row.querySelector(".receipt__vendor")?.textContent).toBe("globex.pdf");
    expect(row.querySelector(".receipt__file")).toBeNull();
  });

  it("says when the date is unknown", () => {
    renderRow({ receipt: makeReceipt("acme.pdf", { date: null }) });
    expect(screen.getByText("Date unknown")).toBeTruthy();
  });

  it("formats the amount in its currency", () => {
    const { row } = renderRow({ receipt: makeReceipt("acme.pdf", { amount_cents: 2000, currency: "USD" }) });
    expect(row.querySelector(".receipt__amount")?.textContent).toBe("US$20.00");
  });

  it("hides a missing amount", () => {
    const { row } = renderRow({ receipt: makeReceipt("acme.pdf", { amount_cents: null }) });
    expect(row.querySelector(".receipt__amount")).toBeNull();
  });

  it("marks a mismatched amount", () => {
    const { row } = renderRow({ mismatch: true });
    expect(row.querySelector(".receipt__amount")?.classList.contains("receipt__amount--mismatch")).toBe(true);
  });

  it("labels low confidence", () => {
    renderRow({ receipt: makeReceipt("acme.pdf", { confidence: "low" }) });
    expect(screen.getByText("low confidence")).toBeTruthy();
  });

  it("does not label high or unknown confidence", () => {
    renderRow();
    expect(screen.queryByText("low confidence")).toBeNull();
    cleanup();
    renderRow({ receipt: makeReceipt("acme.pdf", { confidence: null }) });
    expect(screen.queryByText("low confidence")).toBeNull();
  });

  it("selects the receipt", () => {
    const { onSelect } = renderRow();
    fireEvent.click(screen.getByRole("button", { pressed: false }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("marks the selected receipt", () => {
    const { row } = renderRow({ selected: true });
    expect(row.classList.contains("receipt--selected")).toBe(true);
    expect(screen.getByRole("button", { pressed: true })).toBeTruthy();
  });

  it("runs its actions", () => {
    const accept = vi.fn();
    const actions: ReceiptAction[] = [
      { id: "accept", label: "Accept", icon: "check", tone: "accept", onClick: accept },
      { id: "rescan", label: "Rescan", icon: "refresh", onClick: vi.fn(), disabled: true, spinning: true },
    ];
    renderRow({ actions });
    const button = screen.getByRole("button", { name: "Accept" });
    expect(button.classList.contains("icon--accept")).toBe(true);
    fireEvent.click(button);
    expect(accept).toHaveBeenCalledTimes(1);
    const rescan = screen.getByRole("button", { name: "Rescan" }) as HTMLButtonElement;
    expect(rescan.disabled).toBe(true);
    expect(rescan.querySelector(".spin")).not.toBeNull();
  });
});
