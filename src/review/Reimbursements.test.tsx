// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReceiptMeta } from "../lib/tauri";
import { makeReceipt } from "../test/fixtures";
import { Reimbursements } from "./Reimbursements";

const ACME = makeReceipt("acme.pdf", { vendor: "ACME", amount_cents: 1000 });
const GLOBEX = makeReceipt("globex.pdf", { vendor: "GLOBEX", amount_cents: 2500 });
const HOOLI = makeReceipt("hooli.pdf", { vendor: "HOOLI", amount_cents: null });

afterEach(() => {
  cleanup();
});

function renderList(receipts: ReceiptMeta[], { rescanning = new Set<string>(), selectedFile = null as string | null } = {}) {
  const onPreview = vi.fn();
  const onRescan = vi.fn();
  const { container } = render(
    <Reimbursements receipts={receipts} rescanning={rescanning} selectedFile={selectedFile} onPreview={onPreview} onRescan={onRescan} />,
  );
  return { onPreview, onRescan, container };
}

describe("Reimbursements", () => {
  it("renders nothing without receipts", () => {
    const { container } = renderList([]);
    expect(container.innerHTML).toBe("");
  });

  it("titles the list with its count and total", () => {
    renderList([ACME, GLOBEX, HOOLI]);
    const section = screen.getByRole("region", { name: "Reimbursements (3)" });
    expect(within(section).getByText("Total: €35.00")).toBeTruthy();
    expect(within(section).getByText("Receipts paid personally on company VAT — read-only.")).toBeTruthy();
    expect(within(section).getAllByRole("listitem")).toHaveLength(3);
  });

  it("lists receipts without match actions", () => {
    renderList([ACME]);
    expect(screen.getAllByRole("button", { name: "Rescan" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dispute" })).toBeNull();
  });

  it("rescans a receipt", () => {
    const { onRescan } = renderList([ACME, GLOBEX]);
    fireEvent.click(screen.getAllByRole("button", { name: "Rescan" })[1]);
    expect(onRescan).toHaveBeenCalledWith(GLOBEX);
  });

  it("disables rescan while it runs or without a preview path", () => {
    renderList([ACME, { ...GLOBEX, rel_path: null }, HOOLI], { rescanning: new Set([ACME.file]) });
    const disabled = screen.getAllByRole("button", { name: "Rescan" }).map((b) => (b as HTMLButtonElement).disabled);
    expect(disabled).toEqual([true, true, false]);
  });

  it("previews a receipt", () => {
    const { onPreview } = renderList([ACME, GLOBEX]);
    fireEvent.click(screen.getByText("GLOBEX"));
    expect(onPreview).toHaveBeenCalledWith(GLOBEX);
  });

  it("marks the selected receipt", () => {
    renderList([ACME, GLOBEX], { selectedFile: GLOBEX.file });
    expect(screen.getByRole("button", { pressed: true }).textContent).toContain("GLOBEX");
  });
});
