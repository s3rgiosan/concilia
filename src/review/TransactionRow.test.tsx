// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReceiptMeta, Transaction } from "../lib/tauri";
import { makeReceipt, makeTransaction } from "../test/fixtures";
import { TransactionRow, type RowHandlers } from "./TransactionRow";

const ACME = makeReceipt("acme.pdf", { vendor: "ACME" });
const GLOBEX = makeReceipt("globex.pdf", { vendor: "GLOBEX", amount_cents: 2000 });
const HOOLI = makeReceipt("hooli.pdf", { vendor: "HOOLI", amount_cents: 1100 });
const INITECH = makeReceipt("initech.pdf", { vendor: "INITECH", amount_cents: null });

afterEach(() => {
  cleanup();
});

function handlers() {
  return {
    onConfirm: vi.fn<RowHandlers["onConfirm"]>(),
    onUnmatch: vi.fn<RowHandlers["onUnmatch"]>(),
    onAssign: vi.fn<RowHandlers["onAssign"]>(),
    onNoReceipt: vi.fn<RowHandlers["onNoReceipt"]>(),
    onRescan: vi.fn<RowHandlers["onRescan"]>(),
    onPreview: vi.fn<RowHandlers["onPreview"]>(),
  } satisfies RowHandlers;
}

function renderRow(
  tx: Transaction,
  {
    expanded = true,
    pool = [],
    claimed = new Set<string>(),
    rescanning = new Set<string>(),
    selectedFile = null,
  }: { expanded?: boolean; pool?: ReceiptMeta[]; claimed?: Set<string>; rescanning?: Set<string>; selectedFile?: string | null } = {},
) {
  const h = handlers();
  const onToggle = vi.fn();
  const { container } = render(
    <ul>
      <TransactionRow
        tx={tx}
        expanded={expanded}
        onToggle={onToggle}
        pool={pool}
        claimed={claimed}
        rescanning={rescanning}
        selectedFile={selectedFile}
        handlers={h}
      />
    </ul>,
  );
  const receipts = () => Array.from(container.querySelectorAll<HTMLElement>(".tx__receipts > li"));
  return { h, onToggle, container, receipts };
}

const vendors = (rows: HTMLElement[]) => rows.map((li) => li.querySelector(".receipt__vendor")?.textContent);

describe("TransactionRow header", () => {
  it("shows the date, status, description and amount", () => {
    renderRow(makeTransaction("tx-1", { status: "REVIEW" }), { expanded: false });
    const header = screen.getByRole("button", { expanded: false });
    expect(header.textContent).toBe("2030-03-05ReviewACME CORP-€10.00");
  });

  it("marks income", () => {
    const { container } = renderRow(makeTransaction("tx-1", { amount_cents: 5000, status: "MATCHED" }), { expanded: false });
    const amount = container.querySelector(".tx__amount");
    expect(amount?.textContent).toBe("€50.00");
    expect(amount?.classList.contains("tx__amount--income")).toBe(true);
  });

  it("does not mark an expense as income", () => {
    const { container } = renderRow(makeTransaction("tx-1"), { expanded: false });
    expect(container.querySelector(".tx__amount")?.classList.contains("tx__amount--income")).toBe(false);
  });

  it("hides the body while collapsed", () => {
    const { container } = renderRow(makeTransaction("tx-1", { status: "UNMATCHED" }), { expanded: false, pool: [ACME] });
    expect(container.querySelector(".tx__body")).toBeNull();
    expect(container.querySelector(".tx__chevron--open")).toBeNull();
  });

  it("shows the body while expanded", () => {
    const { container } = renderRow(makeTransaction("tx-1"), { pool: [ACME] });
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
    expect(container.querySelector(".tx__body")).not.toBeNull();
    expect(container.querySelector(".tx__chevron--open")).not.toBeNull();
  });

  it("toggles through the header button", () => {
    const { onToggle } = renderRow(makeTransaction("tx-1"), { expanded: false });
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["MATCHED", "tx--matched"],
    ["REVIEW", "tx--review"],
    ["UNMATCHED", "tx--unmatched"],
  ] as const)("classes a %s transaction", (status, className) => {
    const { container } = renderRow(makeTransaction("tx-1", { status }), { expanded: false });
    expect(container.querySelector(".tx")?.classList.contains(className)).toBe(true);
  });
});

describe("TransactionRow REVIEW", () => {
  const tx = makeTransaction("tx-1", { status: "REVIEW", receipt_meta: [ACME, GLOBEX], notes: "2 receipts match amount" });

  it("lists unclaimed candidates with the reason", () => {
    const { receipts } = renderRow(tx, { claimed: new Set([GLOBEX.file]) });
    expect(vendors(receipts())).toEqual(["ACME"]);
    expect(within(receipts()[0]).getByText("2 receipts match amount")).toBeTruthy();
  });

  it("accepts one candidate", () => {
    const { h, receipts } = renderRow(tx);
    fireEvent.click(within(receipts()[1]).getByRole("button", { name: "Accept" }));
    expect(h.onConfirm).toHaveBeenCalledWith(tx, GLOBEX);
  });

  it("rejects the transaction", () => {
    const { h, receipts } = renderRow(tx);
    fireEvent.click(within(receipts()[0]).getByRole("button", { name: "Reject" }));
    expect(h.onUnmatch).toHaveBeenCalledWith(tx);
  });

  it("has no No Receipt Needed menu", () => {
    renderRow(tx);
    expect(screen.queryByRole("combobox", { name: "No Receipt Needed" })).toBeNull();
  });

  it("marks a candidate whose amount differs", () => {
    const { receipts } = renderRow(tx);
    const amounts = receipts().map((li) => li.querySelector(".receipt__amount")?.classList.contains("receipt__amount--mismatch"));
    expect(amounts).toEqual([false, true]);
  });

  it("still offers an action when every candidate is claimed", () => {
    const only = makeTransaction("tx-2", { status: "REVIEW", receipt_meta: [ACME], notes: "1 receipts match by filename" });
    const { receipts } = renderRow(only, { claimed: new Set([ACME.file]) });
    expect(receipts().length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("button", { name: /Reject|Dispute/ }).length + screen.queryAllByRole("combobox").length).toBeGreaterThan(0);
  });
});

describe("TransactionRow UNMATCHED", () => {
  const tx = makeTransaction("tx-1");

  it("lists the pool by amount proximity without a reason", () => {
    const { receipts } = renderRow(tx, { pool: [INITECH, GLOBEX, HOOLI, ACME] });
    expect(vendors(receipts())).toEqual(["ACME", "HOOLI", "GLOBEX", "INITECH"]);
    expect(screen.queryByText("Amount match")).toBeNull();
  });

  it("assigns a receipt from the pool", () => {
    const { h, receipts } = renderRow(tx, { pool: [GLOBEX, ACME] });
    fireEvent.click(within(receipts()[1]).getByRole("button", { name: "Accept" }));
    expect(h.onAssign).toHaveBeenCalledWith(tx, GLOBEX);
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  it("says when the pool is empty", () => {
    renderRow(tx);
    expect(screen.getByText("No unmatched receipts left to assign.")).toBeTruthy();
  });

  it("marks a receipt as needing none through the pop-up", () => {
    const { h } = renderRow(tx);
    const menu = screen.getByRole("combobox", { name: "No Receipt Needed" });
    const options = within(menu)
      .getAllByRole("option", { hidden: true })
      .map((o) => o.textContent);
    expect(options).toEqual(["No Receipt Needed", "Bank fee", "Salary", "Transfer", "Refund", "No receipt"]);
    fireEvent.change(menu, { target: { value: "1" } });
    expect(h.onNoReceipt).toHaveBeenCalledWith(tx, "salary");
  });

  it("hides the pop-up while collapsed", () => {
    renderRow(tx, { expanded: false });
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

describe("TransactionRow MATCHED", () => {
  it("lists its receipts with the reason and Dispute", () => {
    const tx = makeTransaction("tx-1", { status: "MATCHED", receipt_meta: [ACME], notes: "amount_match" });
    const { h, receipts } = renderRow(tx, { claimed: new Set([ACME.file]) });
    expect(vendors(receipts())).toEqual(["ACME"]);
    expect(within(receipts()[0]).getByText("Amount match")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dispute" }));
    expect(h.onUnmatch).toHaveBeenCalledWith(tx);
  });

  it("shows a no-receipt category with Dispute", () => {
    const tx = makeTransaction("tx-1", { status: "MATCHED", notes: "transfer" });
    const { h, receipts } = renderRow(tx);
    expect(vendors(receipts())).toEqual(["Transfer"]);
    expect(screen.queryByRole("button", { name: "Rescan" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dispute" }));
    expect(h.onUnmatch).toHaveBeenCalledWith(tx);
  });

  it("shows a bank fee as a no-receipt category even with receipts", () => {
    const tx = makeTransaction("tx-1", { status: "MATCHED", notes: "bank_fee", receipt_meta: [ACME] });
    const { receipts } = renderRow(tx);
    expect(vendors(receipts())).toEqual(["Bank fee"]);
  });

  it("shows No receipt for a match without receipts", () => {
    const tx = makeTransaction("tx-1", { status: "MATCHED", notes: "amount_match" });
    const { h, receipts } = renderRow(tx);
    expect(vendors(receipts())).toEqual(["No receipt"]);
    fireEvent.click(screen.getByRole("button", { name: "Dispute" }));
    expect(h.onUnmatch).toHaveBeenCalledWith(tx);
  });
});

describe("TransactionRow receipts", () => {
  const tx = makeTransaction("tx-1", { status: "MATCHED", receipt_meta: [ACME], notes: "manual_match" });

  it("rescans a receipt", () => {
    const { h } = renderRow(tx);
    const rescan = screen.getByRole("button", { name: "Rescan" }) as HTMLButtonElement;
    expect(rescan.disabled).toBe(false);
    fireEvent.click(rescan);
    expect(h.onRescan).toHaveBeenCalledWith(ACME);
  });

  it("disables rescan without a preview path", () => {
    renderRow({ ...tx, receipt_meta: [{ ...ACME, rel_path: null }] });
    expect((screen.getByRole("button", { name: "Rescan" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("disables rescan while it runs", () => {
    renderRow(tx, { rescanning: new Set([ACME.file]) });
    const rescan = screen.getByRole("button", { name: "Rescan" }) as HTMLButtonElement;
    expect(rescan.disabled).toBe(true);
    expect(rescan.querySelector(".spin")).not.toBeNull();
  });

  it("previews a receipt", () => {
    const { h } = renderRow(tx);
    fireEvent.click(screen.getByRole("button", { pressed: false }));
    expect(h.onPreview).toHaveBeenCalledWith(tx, ACME);
  });

  it("marks the selected receipt", () => {
    renderRow(tx, { selectedFile: ACME.file });
    expect(screen.getByRole("button", { pressed: true })).toBeTruthy();
  });

  it("marks an FX receipt more than 10% off", () => {
    const fx = makeReceipt("hooli-usd.pdf", { amount_cents: 1200, currency: "USD" });
    const { container } = renderRow({ ...tx, receipt_meta: [fx] });
    expect(container.querySelector(".receipt__amount--mismatch")).not.toBeNull();
  });
});
