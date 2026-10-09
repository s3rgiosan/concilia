// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exportReport,
  finalize,
  getDraft,
  getReview,
  openReceipt,
  periodStatus,
  receiptUrl,
  rescanReceipt,
  rescanReimbursement,
  saveDraft,
  startScan,
  type Draft,
  type ReceiptMeta,
  type RunEvent,
  type RunHandle,
  type ScanResult,
} from "../lib/tauri";
import { deferred, makePeriodStatus, makeReceipt, makeReviewData, makeTransaction } from "../test/fixtures";
import { Review } from "./Review";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  exportReport: vi.fn(),
  finalize: vi.fn(),
  getDraft: vi.fn(),
  getReview: vi.fn(),
  openReceipt: vi.fn(),
  periodStatus: vi.fn(),
  receiptUrl: vi.fn(),
  rescanReceipt: vi.fn(),
  rescanReimbursement: vi.fn(),
  saveDraft: vi.fn(),
  startScan: vi.fn(),
}));

const PERIOD = { year: "2030", month: "03" };

const ACME = makeReceipt("acme.pdf", { vendor: "ACME", amount_cents: 1000 });
const GLOBEX = makeReceipt("globex.pdf", { vendor: "GLOBEX", amount_cents: 2000 });
const HOOLI = makeReceipt("hooli.pdf", { vendor: "HOOLI", amount_cents: 2000, date: "2030-03-06" });
const INITECH = makeReceipt("initech.pdf", { vendor: "INITECH", amount_cents: 3000 });
const TRAVEL = makeReceipt("acme-travel.pdf", { vendor: "ACME TRAVEL", amount_cents: 500 });

const TX_ACME = makeTransaction("tx-1", {
  date: "2030-03-01",
  description: "ACME CORP",
  amount_cents: -1000,
  status: "MATCHED",
  receipt_meta: [ACME],
  notes: "amount_match",
});
const TX_GLOBEX = makeTransaction("tx-2", {
  date: "2030-03-02",
  description: "GLOBEX SHOP",
  amount_cents: -2000,
  status: "REVIEW",
  receipt_meta: [GLOBEX, HOOLI],
  notes: "2 receipts match amount",
});
const TX_INITECH = makeTransaction("tx-3", {
  date: "2030-03-03",
  description: "INITECH SERVICES",
  amount_cents: -3000,
  status: "UNMATCHED",
});
const TX_SALARY = makeTransaction("tx-4", {
  date: "2030-03-04",
  description: "HOOLI PAYROLL",
  amount_cents: 500000,
  status: "MATCHED",
  notes: "salary",
});

const DATA = makeReviewData({
  transactions: [TX_ACME, TX_GLOBEX, TX_INITECH, TX_SALARY],
  unmatched_receipts: [INITECH],
  reimbursements: [TRAVEL],
});

function stripped(receipt: ReceiptMeta): ReceiptMeta {
  const { rel_path: _relPath, ...rest } = receipt;
  return rest;
}

/** A scan the test settles by hand, pushing events through the callback it was started with. */
function scanRun() {
  const result = deferred<ScanResult>();
  const cancel = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  const handle: RunHandle<ScanResult> = { promise: result.promise, cancel };
  let onEvent: (event: RunEvent) => void = () => undefined;
  vi.mocked(startScan).mockImplementation((_year, _month, callback) => {
    onEvent = callback;
    return handle;
  });
  return { result, cancel, push: (event: RunEvent) => act(() => onEvent(event)) };
}

const SUMMARY = {
  totalTransactions: 4,
  matched: 2,
  review: 1,
  unmatched: 1,
  bankFees: 0,
  totalReceipts: 4,
  matchedReceipts: 1,
  reviewReceipts: 2,
  unmatchedReceipts: 1,
  matchRate: 50,
};

/** Runs every timer due now and the promise callbacks they lead to. */
async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function renderReview() {
  const onBack = vi.fn();
  const onError = vi.fn();
  const result = render(<Review period={PERIOD} onBack={onBack} onError={onError} />);
  await settle();
  return { ...result, onBack, onError };
}

function button(name: string, scope: HTMLElement = document.body): HTMLButtonElement {
  return within(scope).getByRole("button", { name }) as HTMLButtonElement;
}

/** The list item of the transaction with this description. */
function row(description: string): HTMLElement {
  const item = screen.getByText(description).closest<HTMLElement>("li.tx");
  if (!item) {
    throw new Error(`no row for ${description}`);
  }
  return item;
}

function header(description: string): HTMLButtonElement {
  return row(description).querySelector<HTMLButtonElement>(".tx__header")!;
}

function receiptVendors(description: string): (string | null | undefined)[] {
  return Array.from(row(description).querySelectorAll(".tx__receipts > li")).map((li) => li.querySelector(".receipt__vendor")?.textContent);
}

/** The receipt item showing this vendor inside a transaction or the reimbursements. */
function receipt(scope: HTMLElement, vendor: string): HTMLElement {
  return within(scope).getByText(vendor, { selector: ".receipt__vendor" }).closest<HTMLElement>("li")!;
}

function filters(): HTMLElement {
  return screen.getByRole("group", { name: "Review March 2030" });
}

function filterButton(label: string): HTMLButtonElement {
  return within(filters()).getByRole("button", { name: new RegExp(`^${label}`) }) as HTMLButtonElement;
}

function counts(): Record<string, string> {
  return Object.fromEntries(
    within(filters())
      .getAllByRole("button")
      .map((b) => [b.firstChild?.textContent ?? "", b.querySelector(".segmented__count")?.textContent ?? ""]),
  );
}

function descriptions(): string[] {
  return Array.from(document.querySelectorAll(".tx__description")).map((el) => el.textContent ?? "");
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getReview).mockResolvedValue(DATA);
  vi.mocked(getDraft).mockResolvedValue({});
  vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus());
  vi.mocked(saveDraft).mockResolvedValue(undefined);
  vi.mocked(receiptUrl).mockImplementation((path) => `receipt://localhost/${path}`);
  vi.mocked(openReceipt).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("loading", () => {
  it("loads the review, draft and status for the month", async () => {
    await renderReview();
    expect(getReview).toHaveBeenCalledWith("2030", "03");
    expect(getDraft).toHaveBeenCalledWith("2030", "03");
    expect(periodStatus).toHaveBeenCalledWith("2030", "03");
    expect(screen.getByRole("heading", { name: "Review March 2030" })).toBeTruthy();
  });

  it("shows nothing while loading", () => {
    vi.mocked(getReview).mockReturnValue(new Promise(() => undefined));
    const { container } = render(<Review period={PERIOD} onBack={vi.fn()} onError={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });

  it("shows a load error with Back", async () => {
    vi.mocked(getReview).mockRejectedValue({ kind: "not_found", message: "No reconciliation for March 2030." });
    const { onBack } = await renderReview();
    expect(screen.getByRole("alert").textContent).toBe("No reconciliation for March 2030.Back");
    expect(screen.queryByRole("heading")).toBeNull();
    fireEvent.click(button("Back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("lists transactions by date with every undecided one open", async () => {
    await renderReview();
    expect(descriptions()).toEqual(["ACME CORP", "GLOBEX SHOP", "INITECH SERVICES", "HOOLI PAYROLL"]);
    expect(header("ACME CORP").getAttribute("aria-expanded")).toBe("false");
    expect(header("GLOBEX SHOP").getAttribute("aria-expanded")).toBe("true");
    expect(header("INITECH SERVICES").getAttribute("aria-expanded")).toBe("true");
    expect(header("HOOLI PAYROLL").getAttribute("aria-expanded")).toBe("false");
  });

  it("applies the stored draft", async () => {
    const draft: Draft = {
      "tx-3": { status: "MATCHED", receipt_meta: [stripped(INITECH)], receipt_files: [INITECH.file], notes: "manual_match" },
    };
    vi.mocked(getDraft).mockResolvedValue(draft);
    await renderReview();
    expect(header("INITECH SERVICES").getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(header("INITECH SERVICES"));
    expect(receiptVendors("INITECH SERVICES")).toEqual(["INITECH"]);
    expect(within(row("INITECH SERVICES")).getByText("Manual match")).toBeTruthy();
    // The receipt gets its preview path back, so it can be rescanned.
    expect(button("Rescan", row("INITECH SERVICES")).disabled).toBe(false);
    expect(counts()).toEqual({ All: "4", Review: "1", Unmatched: "0", Matched: "3" });
  });

  it("lists the reimbursements", async () => {
    await renderReview();
    const section = screen.getByRole("region", { name: "Reimbursements (1)" });
    expect(within(section).getByText("Total: €5.00")).toBeTruthy();
  });

  it("goes back", async () => {
    const { onBack } = await renderReview();
    fireEvent.click(button("Back"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});

describe("filters and search", () => {
  it("counts transactions by status", async () => {
    await renderReview();
    expect(counts()).toEqual({ All: "4", Review: "1", Unmatched: "1", Matched: "2" });
    expect(filterButton("All").getAttribute("aria-pressed")).toBe("true");
  });

  it("shows one status", async () => {
    await renderReview();
    fireEvent.click(filterButton("Matched"));
    expect(descriptions()).toEqual(["ACME CORP", "HOOLI PAYROLL"]);
    expect(filterButton("Matched").getAttribute("aria-pressed")).toBe("true");
    expect(filterButton("All").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(filterButton("Review"));
    expect(descriptions()).toEqual(["GLOBEX SHOP"]);
    fireEvent.click(filterButton("Unmatched"));
    expect(descriptions()).toEqual(["INITECH SERVICES"]);
    fireEvent.click(filterButton("All"));
    expect(descriptions()).toHaveLength(4);
  });

  it("searches descriptions", async () => {
    await renderReview();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "hooli" } });
    expect(descriptions()).toEqual(["HOOLI PAYROLL"]);
  });

  it("says when nothing matches and disables Expand", async () => {
    await renderReview();
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "umbrella" } });
    expect(descriptions()).toEqual([]);
    expect(screen.getByText("No transactions.")).toBeTruthy();
    expect(button("Expand").disabled).toBe(true);
  });
});

describe("expanding", () => {
  it("expands and collapses one transaction", async () => {
    await renderReview();
    fireEvent.click(header("ACME CORP"));
    expect(header("ACME CORP").getAttribute("aria-expanded")).toBe("true");
    expect(receiptVendors("ACME CORP")).toEqual(["ACME"]);
    fireEvent.click(header("ACME CORP"));
    expect(header("ACME CORP").getAttribute("aria-expanded")).toBe("false");
  });

  it("expands and collapses every transaction", async () => {
    await renderReview();
    fireEvent.click(button("Expand"));
    expect(screen.getAllByRole("button", { expanded: true })).toHaveLength(4);
    fireEvent.click(button("Collapse"));
    expect(screen.queryAllByRole("button", { expanded: true })).toHaveLength(0);
    expect(button("Expand")).toBeTruthy();
  });

  it("expands only the transactions shown", async () => {
    await renderReview();
    fireEvent.click(filterButton("Matched"));
    expect(button("Expand")).toBeTruthy();
    fireEvent.click(button("Expand"));
    fireEvent.click(filterButton("All"));
    expect(screen.getAllByRole("button", { expanded: true })).toHaveLength(4);
    expect(button("Collapse")).toBeTruthy();
  });
});

describe("decisions", () => {
  it("accepts one candidate, freeing the other for an unmatched transaction", async () => {
    await renderReview();
    expect(receiptVendors("INITECH SERVICES")).toEqual(["INITECH"]);
    fireEvent.click(button("Accept", receipt(row("GLOBEX SHOP"), "GLOBEX")));
    expect(row("GLOBEX SHOP").classList.contains("tx--matched")).toBe(true);
    expect(receiptVendors("GLOBEX SHOP")).toEqual(["GLOBEX"]);
    expect(button("Dispute", row("GLOBEX SHOP"))).toBeTruthy();
    // The pool is ordered by distance to the transaction's 30.00.
    expect(receiptVendors("INITECH SERVICES")).toEqual(["INITECH", "HOOLI"]);
    expect(counts()).toEqual({ All: "4", Review: "0", Unmatched: "1", Matched: "3" });
  });

  it("autosaves the decision 500 ms later without preview paths", async () => {
    await renderReview();
    fireEvent.click(button("Accept", receipt(row("GLOBEX SHOP"), "GLOBEX")));
    await advance(499);
    expect(saveDraft).not.toHaveBeenCalled();
    await advance(1);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    const [year, month, draft] = vi.mocked(saveDraft).mock.calls[0];
    expect([year, month]).toEqual(["2030", "03"]);
    expect(draft).toEqual({
      "tx-2": { status: "MATCHED", receipt_meta: [stripped(GLOBEX)], receipt_files: [GLOBEX.file], notes: "2 receipts match amount" },
    });
    expect("rel_path" in draft["tx-2"].receipt_meta![0]).toBe(false);
  });

  it("collects several decisions into one save", async () => {
    await renderReview();
    fireEvent.click(button("Reject", receipt(row("GLOBEX SHOP"), "GLOBEX")));
    fireEvent.click(header("HOOLI PAYROLL"));
    fireEvent.click(button("Dispute", row("HOOLI PAYROLL")));
    await advance(500);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveDraft).mock.calls[0][2]).toEqual({
      "tx-2": { status: "UNMATCHED", receipt_meta: [], receipt_files: [], notes: "" },
      "tx-4": { status: "UNMATCHED", receipt_meta: [], receipt_files: [], notes: "" },
    });
  });

  it("rejects candidates, returning them to the pool", async () => {
    await renderReview();
    fireEvent.click(button("Reject", receipt(row("GLOBEX SHOP"), "HOOLI")));
    expect(row("GLOBEX SHOP").classList.contains("tx--unmatched")).toBe(true);
    expect(receiptVendors("GLOBEX SHOP")).toEqual(["GLOBEX", "HOOLI", "INITECH"]);
    expect(receiptVendors("INITECH SERVICES")).toEqual(["INITECH", "GLOBEX", "HOOLI"]);
  });

  it("assigns a receipt from the pool", async () => {
    await renderReview();
    fireEvent.click(button("Accept", receipt(row("INITECH SERVICES"), "INITECH")));
    expect(row("INITECH SERVICES").classList.contains("tx--matched")).toBe(true);
    expect(within(row("INITECH SERVICES")).getByText("Manual match")).toBeTruthy();
    await advance(500);
    expect(vi.mocked(saveDraft).mock.calls[0][2]).toEqual({
      "tx-3": { status: "MATCHED", receipt_meta: [stripped(INITECH)], receipt_files: [INITECH.file], notes: "manual_match" },
    });
  });

  it("marks a transaction as needing no receipt", async () => {
    await renderReview();
    fireEvent.change(within(row("INITECH SERVICES")).getByRole("combobox", { name: "No Receipt Needed" }), { target: { value: "3" } });
    expect(row("INITECH SERVICES").classList.contains("tx--matched")).toBe(true);
    expect(receiptVendors("INITECH SERVICES")).toEqual(["Refund"]);
    await advance(500);
    expect(vi.mocked(saveDraft).mock.calls[0][2]).toEqual({
      "tx-3": { status: "MATCHED", receipt_meta: [], receipt_files: [], notes: "refund" },
    });
  });

  it("disputes a match, freeing its receipt", async () => {
    await renderReview();
    fireEvent.click(header("ACME CORP"));
    fireEvent.click(button("Dispute", row("ACME CORP")));
    expect(row("ACME CORP").classList.contains("tx--unmatched")).toBe(true);
    expect(receiptVendors("INITECH SERVICES")).toEqual(["INITECH", "ACME"]);
  });

  it("previews a receipt", async () => {
    await renderReview();
    fireEvent.click(within(receipt(row("GLOBEX SHOP"), "GLOBEX")).getByRole("button", { pressed: false }));
    const pane = screen.getByRole("complementary", { name: "Preview" });
    expect(within(pane).getByTitle("globex.pdf").getAttribute("src")).toBe("receipt://localhost/2030/03/receipts/globex.pdf#navpanes=0");
    expect(within(receipt(row("GLOBEX SHOP"), "GLOBEX")).getByRole("button", { pressed: true })).toBeTruthy();
  });

  it("opens the previewed receipt in Preview", async () => {
    await renderReview();
    fireEvent.click(within(receipt(row("GLOBEX SHOP"), "GLOBEX")).getByRole("button", { pressed: false }));
    fireEvent.click(button("Open in Preview"));
    expect(openReceipt).toHaveBeenCalledWith("2030", "03", "2030/03/receipts/globex.pdf");
  });

  it("reports a failure to open the receipt", async () => {
    const error = { kind: "io", message: "no viewer" };
    vi.mocked(openReceipt).mockRejectedValue(error);
    const { onError } = await renderReview();
    fireEvent.click(within(receipt(row("GLOBEX SHOP"), "GLOBEX")).getByRole("button", { pressed: false }));
    fireEvent.click(button("Open in Preview"));
    await settle();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("closes the preview", async () => {
    await renderReview();
    fireEvent.click(within(receipt(row("GLOBEX SHOP"), "GLOBEX")).getByRole("button", { pressed: false }));
    fireEvent.click(button("Close", screen.getByRole("complementary", { name: "Preview" })));
    expect(screen.getByText("Select a receipt to preview it.")).toBeTruthy();
  });

  it("previews a reimbursement", async () => {
    await renderReview();
    const section = screen.getByRole("region", { name: "Reimbursements (1)" });
    fireEvent.click(within(section).getByRole("button", { pressed: false }));
    expect(screen.getByTitle("acme-travel.pdf")).toBeTruthy();
  });
});

describe("save status", () => {
  it("says nothing before a change", async () => {
    const { container } = await renderReview();
    expect(container.querySelector(".review__save")).toBeNull();
  });

  it("reports saving, then saved", async () => {
    const save = deferred<void>();
    vi.mocked(saveDraft).mockReturnValue(save.promise);
    await renderReview();
    fireEvent.click(button("Accept", receipt(row("INITECH SERVICES"), "INITECH")));
    await advance(500);
    expect(screen.getByText("Saving…")).toBeTruthy();
    await act(async () => save.resolve());
    expect(screen.getByText("All changes saved")).toBeTruthy();
  });

  it("reports a failed save", async () => {
    vi.mocked(saveDraft).mockRejectedValue({ kind: "io", message: "disk full" });
    await renderReview();
    fireEvent.click(button("Accept", receipt(row("INITECH SERVICES"), "INITECH")));
    await advance(500);
    expect(screen.getByRole("alert").textContent).toBe(" Changes not saved: Concilia couldn't read or write a file: disk full");
  });
});

describe("rescan", () => {
  it("rescans a receipt and shows the new data", async () => {
    vi.mocked(rescanReceipt).mockResolvedValue({ ...stripped(GLOBEX), vendor: "GLOBEX LTD", amount_cents: 2100 });
    await renderReview();
    fireEvent.click(button("Rescan", receipt(row("GLOBEX SHOP"), "GLOBEX")));
    expect(rescanReceipt).toHaveBeenCalledWith("2030", "03", "2030/03/receipts/globex.pdf");
    await settle();
    expect(receiptVendors("GLOBEX SHOP")).toEqual(["GLOBEX LTD", "HOOLI"]);
    const item = receipt(row("GLOBEX SHOP"), "GLOBEX LTD");
    expect(item.querySelector(".receipt__amount")?.textContent).toBe("€21.00");
    // The preview path survives, so the receipt can be rescanned again.
    expect(button("Rescan", item).disabled).toBe(false);
  });

  it("disables the button while the rescan runs", async () => {
    const pending = deferred<ReceiptMeta>();
    vi.mocked(rescanReceipt).mockReturnValue(pending.promise);
    await renderReview();
    fireEvent.click(button("Rescan", receipt(row("GLOBEX SHOP"), "GLOBEX")));
    expect(button("Rescan", receipt(row("GLOBEX SHOP"), "GLOBEX")).disabled).toBe(true);
    expect(button("Rescan", receipt(row("GLOBEX SHOP"), "HOOLI")).disabled).toBe(false);
    await act(async () => pending.resolve(GLOBEX));
    expect(button("Rescan", receipt(row("GLOBEX SHOP"), "GLOBEX")).disabled).toBe(false);
  });

  it("updates the open preview", async () => {
    vi.mocked(rescanReceipt).mockResolvedValue({ ...stripped(GLOBEX), vendor: "GLOBEX LTD" });
    await renderReview();
    fireEvent.click(within(receipt(row("GLOBEX SHOP"), "GLOBEX")).getByRole("button", { pressed: false }));
    fireEvent.click(button("Rescan", receipt(row("GLOBEX SHOP"), "GLOBEX")));
    await settle();
    // The preview keeps showing the rescanned receipt with its path.
    expect(screen.getByTitle("globex.pdf").getAttribute("src")).toBe("receipt://localhost/2030/03/receipts/globex.pdf#navpanes=0");
    expect(within(receipt(row("GLOBEX SHOP"), "GLOBEX LTD")).getByRole("button", { pressed: true })).toBeTruthy();
  });

  it("uses a new preview path from the rescan", async () => {
    vi.mocked(rescanReceipt).mockResolvedValue({ ...GLOBEX, rel_path: "2030/03/receipts/globex-2.pdf" });
    await renderReview();
    fireEvent.click(within(receipt(row("GLOBEX SHOP"), "GLOBEX")).getByRole("button", { pressed: false }));
    fireEvent.click(button("Rescan", receipt(row("GLOBEX SHOP"), "GLOBEX")));
    await settle();
    expect(screen.getByTitle("globex.pdf").getAttribute("src")).toBe("receipt://localhost/2030/03/receipts/globex-2.pdf#navpanes=0");
  });

  it("leaves the preview of another receipt alone", async () => {
    vi.mocked(rescanReceipt).mockResolvedValue({ ...GLOBEX, vendor: "GLOBEX LTD" });
    await renderReview();
    fireEvent.click(within(receipt(row("GLOBEX SHOP"), "HOOLI")).getByRole("button", { pressed: false }));
    fireEvent.click(button("Rescan", receipt(row("GLOBEX SHOP"), "GLOBEX")));
    await settle();
    expect(screen.getByTitle("hooli.pdf")).toBeTruthy();
  });

  it("rescans a reimbursement", async () => {
    vi.mocked(rescanReimbursement).mockResolvedValue({ ...stripped(TRAVEL), amount_cents: 700 });
    await renderReview();
    const section = screen.getByRole("region", { name: "Reimbursements (1)" });
    fireEvent.click(button("Rescan", section));
    expect(rescanReimbursement).toHaveBeenCalledWith("2030", "03", "2030/03/receipts/acme-travel.pdf");
    expect(rescanReceipt).not.toHaveBeenCalled();
    await settle();
    expect(within(section).getByText("Total: €7.00")).toBeTruthy();
  });

  it("reports a failed rescan", async () => {
    const error = { kind: "network", message: "offline" };
    vi.mocked(rescanReceipt).mockRejectedValue(error);
    const { onError } = await renderReview();
    fireEvent.click(button("Rescan", receipt(row("GLOBEX SHOP"), "GLOBEX")));
    await settle();
    expect(onError).toHaveBeenCalledWith(error);
    expect(receiptVendors("GLOBEX SHOP")).toEqual(["GLOBEX", "HOOLI"]);
    expect(button("Rescan", receipt(row("GLOBEX SHOP"), "GLOBEX")).disabled).toBe(false);
  });

  it("shows a rescan of a receipt in a pending decision", async () => {
    vi.mocked(rescanReceipt).mockResolvedValue({ ...stripped(GLOBEX), vendor: "GLOBEX LTD", amount_cents: 2100 });
    await renderReview();
    fireEvent.click(button("Accept", receipt(row("GLOBEX SHOP"), "GLOBEX")));
    fireEvent.click(button("Rescan", receipt(row("GLOBEX SHOP"), "GLOBEX")));
    await settle();
    expect(receiptVendors("GLOBEX SHOP")).toEqual(["GLOBEX LTD"]);
  });
});

describe("scan for new receipts", () => {
  it("saves pending changes, then scans with progress", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Accept", receipt(row("INITECH SERVICES"), "INITECH")));
    fireEvent.click(button("Scan for New Receipts"));
    expect(startScan).not.toHaveBeenCalled();
    await settle();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(startScan).toHaveBeenCalledWith("2030", "03", expect.any(Function));
    expect(vi.mocked(saveDraft).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(startScan).mock.invocationCallOrder[0]);

    const dialog = screen.getByRole("dialog", { name: "Scanning for new receipts" });
    await run.push({ step: "receipts_found", count: 3 });
    await run.push({ step: "extracting", current: 1, total: 3 });
    expect(within(dialog).getByRole("progressbar", { name: "Extracting receipt data" })).toBeTruthy();
    expect(button("Scan for New Receipts").disabled).toBe(true);
    expect(button("Save Report…").disabled).toBe(true);
    expect(button("Finalize…").disabled).toBe(true);
    run.result.resolve({ summary: SUMMARY, dropped_decisions: [] });
    await settle();
  });

  it("cancels a scan", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts"));
    await settle();
    fireEvent.click(button("Cancel", screen.getByRole("dialog")));
    expect(run.cancel).toHaveBeenCalledTimes(1);
    expect(button("Stopping…", screen.getByRole("dialog")).disabled).toBe(true);
  });

  it("reloads and reports dropped decisions when the scan succeeds", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts"));
    await settle();
    vi.mocked(getReview).mockResolvedValue(makeReviewData({ transactions: [TX_ACME, TX_INITECH] }));
    run.result.resolve({
      summary: SUMMARY,
      dropped_decisions: [{ txId: "tx-2", description: "GLOBEX SHOP", removedReceiptFiles: [GLOBEX.file] }],
    });
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getReview).toHaveBeenCalledTimes(2);
    expect(descriptions()).toEqual(["ACME CORP", "INITECH SERVICES"]);
    const banner = screen.getByText("1 pending decision was dropped because its receipt was removed: GLOBEX SHOP").closest<HTMLElement>(".banner")!;
    fireEvent.click(button("Dismiss", banner));
    expect(screen.queryByText(/pending decision was dropped/)).toBeNull();
  });

  it("names every dropped decision", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts"));
    await settle();
    run.result.resolve({
      summary: SUMMARY,
      dropped_decisions: [
        { txId: "tx-2", description: "GLOBEX SHOP", removedReceiptFiles: [GLOBEX.file] },
        { txId: "tx-3", description: "INITECH SERVICES", removedReceiptFiles: [INITECH.file] },
      ],
    });
    await settle();
    expect(screen.getByText("2 pending decisions were dropped because their receipts were removed: GLOBEX SHOP, INITECH SERVICES")).toBeTruthy();
  });

  it("shows a failed scan until closed", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts"));
    await settle();
    run.result.reject({ kind: "io", message: "folder missing" });
    await settle();
    const dialog = screen.getByRole("dialog", { name: "Scanning for new receipts" });
    expect(within(dialog).getByRole("alert").textContent).toBe("Concilia couldn't read or write a file: folder missing");
    expect(button("Scan for New Receipts").disabled).toBe(false);
    fireEvent.click(button("Close", dialog));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getReview).toHaveBeenCalledTimes(1);
  });

  it("reports a failed save and does not scan", async () => {
    const error = { kind: "io", message: "disk full" };
    vi.mocked(saveDraft).mockRejectedValue(error);
    scanRun();
    const { onError } = await renderReview();
    fireEvent.click(button("Accept", receipt(row("INITECH SERVICES"), "INITECH")));
    fireEvent.click(button("Scan for New Receipts"));
    await settle();
    expect(onError).toHaveBeenCalledWith(error);
    expect(startScan).not.toHaveBeenCalled();
  });

  it("is unavailable for a finalized month", async () => {
    vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus({ applied: true }));
    await renderReview();
    expect(button("Scan for New Receipts").disabled).toBe(true);
    expect(
      screen.getByText("This month is finalized. Changes here go into the report; re-run the month to sort receipts again."),
    ).toBeTruthy();
    expect(button("Save Report…").disabled).toBe(false);
  });

  it("shows no finalized note for an open month", async () => {
    await renderReview();
    expect(screen.queryByText(/This month is finalized/)).toBeNull();
  });
});

describe("save report", () => {
  it("saves pending changes, then exports and says where", async () => {
    vi.mocked(exportReport).mockResolvedValue("/Users/example/Reports/2030-03.xlsx");
    await renderReview();
    fireEvent.click(button("Accept", receipt(row("INITECH SERVICES"), "INITECH")));
    fireEvent.click(button("Save Report…"));
    await settle();
    expect(exportReport).toHaveBeenCalledWith("2030", "03");
    expect(vi.mocked(saveDraft).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(exportReport).mock.invocationCallOrder[0]);
    const notice = screen.getByText("Report saved to /Users/example/Reports/2030-03.xlsx.").closest<HTMLElement>(".banner")!;
    fireEvent.click(button("Close", notice));
    expect(screen.queryByText(/Report saved to/)).toBeNull();
  });

  it("says nothing when the dialog is cancelled", async () => {
    vi.mocked(exportReport).mockResolvedValue(null);
    await renderReview();
    fireEvent.click(button("Save Report…"));
    await settle();
    expect(exportReport).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Report saved to/)).toBeNull();
  });

  it("reports a failed export", async () => {
    const error = { kind: "io", message: "read-only volume" };
    vi.mocked(exportReport).mockRejectedValue(error);
    const { onError } = await renderReview();
    fireEvent.click(button("Save Report…"));
    await settle();
    expect(onError).toHaveBeenCalledWith(error);
  });
});

describe("finalize", () => {
  async function confirmFinalize() {
    fireEvent.click(button("Finalize…"));
    const sheet = screen.getByRole("alertdialog", { name: "Finalize reconciliation?" });
    fireEvent.click(within(sheet).getByRole("checkbox"));
    fireEvent.click(button("Finalize", sheet));
    return sheet;
  }

  it("opens the confirmation and cancels", async () => {
    await renderReview();
    fireEvent.click(button("Finalize…"));
    const sheet = screen.getByRole("alertdialog", { name: "Finalize reconciliation?" });
    fireEvent.click(button("Cancel", sheet));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("saves pending changes, finalizes and reloads", async () => {
    const done = deferred<void>();
    vi.mocked(finalize).mockReturnValue(done.promise);
    await renderReview();
    fireEvent.click(button("Accept", receipt(row("INITECH SERVICES"), "INITECH")));
    const sheet = await confirmFinalize();
    expect(button("Working…", sheet).disabled).toBe(true);
    expect(button("Scan for New Receipts").disabled).toBe(true);
    await settle();
    expect(finalize).toHaveBeenCalledWith("2030", "03");
    expect(vi.mocked(saveDraft).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(finalize).mock.invocationCallOrder[0]);

    vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus({ applied: true }));
    await act(async () => done.resolve());
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByText("Changes applied and report updated")).toBeTruthy();
    expect(getReview).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/This month is finalized/)).toBeTruthy();
  });

  it("reports a failed finalize and keeps the sheet open", async () => {
    const error = { kind: "busy", message: "scan running" };
    vi.mocked(finalize).mockRejectedValue(error);
    const { onError } = await renderReview();
    const sheet = await confirmFinalize();
    await settle();
    expect(onError).toHaveBeenCalledWith(error);
    expect(screen.getByRole("alertdialog")).toBe(sheet);
    expect(button("Finalize", sheet).disabled).toBe(false);
    expect(screen.queryByText("Changes applied and report updated")).toBeNull();
    expect(getReview).toHaveBeenCalledTimes(1);
  });
});
