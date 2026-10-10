// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PopUpAction } from "../components/PopUpButton";
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
import type { ReviewAvailability, ReviewCommands } from "./commands";
import { Review, type ReviewProps } from "./Review";

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
  requestAttention: vi.fn(() => Promise.resolve()),
  saveDraft: vi.fn(),
  setDockProgress: vi.fn(() => Promise.resolve()),
  startScan: vi.fn(),
}));

const PERIOD = { year: "2030", month: "03" };

const ACME = makeReceipt("acme.pdf", { vendor: "ACME", amount_cents: 1000 });
const GLOBEX = makeReceipt("globex.pdf", { vendor: "GLOBEX", amount_cents: 2000 });
const HOOLI = makeReceipt("hooli.jpg", { vendor: "HOOLI", amount_cents: 2000, date: "2030-03-06" });
const INITECH = makeReceipt("initech.pdf", { vendor: "INITECH", amount_cents: 3000 });
const TRAVEL = makeReceipt("acme-travel.pdf", { vendor: "ACME TRAVEL", amount_cents: 500, date: "2030-03-07" });

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

const openReport = vi.fn();
const MORE: PopUpAction[] = [{ label: "Open Report", onSelect: openReport }];

/** The review inside a toolbar with the slots the main window gives it. */
function Window(props: Omit<ReviewProps, "toolbar" | "period" | "status" | "moreActions"> & Partial<ReviewProps>) {
  const [subtitle, setSubtitle] = useState<HTMLElement | null>(null);
  const [trailing, setTrailing] = useState<HTMLElement | null>(null);
  return (
    <>
      <header className="titlebar">
        <p className="titlebar__subtitle">
          <span ref={setSubtitle} />
        </p>
        <div className="titlebar__trailing">
          <div ref={setTrailing} />
        </div>
      </header>
      <Review period={PERIOD} status="In review · 9 to decide" moreActions={MORE} toolbar={{ subtitle, trailing }} {...props} />
    </>
  );
}

async function renderReview(props: Partial<ReviewProps> = {}) {
  const onChanged = vi.fn();
  const onError = vi.fn();
  const onAvailabilityChange = vi.fn<(can: ReviewAvailability) => void>();
  const ref = createRef<ReviewCommands>();
  const result = render(<Window onChanged={onChanged} onError={onError} onAvailabilityChange={onAvailabilityChange} ref={ref} {...props} />);
  await settle();
  return { ...result, onChanged, onError, onAvailabilityChange, commands: () => ref.current! };
}

function button(name: string | RegExp, scope: HTMLElement = document.body): HTMLButtonElement {
  return within(scope).getByRole("button", { name }) as HTMLButtonElement;
}

function toolbar(): HTMLElement {
  return document.querySelector("header.titlebar") as HTMLElement;
}

function subtitle(): string {
  return toolbar().querySelector(".titlebar__subtitle")?.textContent ?? "";
}

function list(): HTMLElement {
  return screen.getByRole("listbox", { name: "Transactions" });
}

function options(): string[] {
  return within(list())
    .queryAllByRole("option")
    .map((o) => `${o.getAttribute("aria-selected") === "true" ? "* " : ""}${o.textContent}`);
}

function selected(): string {
  const option = within(list())
    .getAllByRole("option")
    .find((o) => o.getAttribute("aria-selected") === "true");
  return option?.querySelector(".list-row__description")?.textContent ?? "";
}

function select(description: string) {
  fireEvent.mouseDown(within(list()).getByText(description).closest<HTMLElement>("[role=option]")!);
}

function key(name: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(list(), { key: name, ...init });
}

function filterButton(label: string): HTMLButtonElement {
  return within(screen.getByRole("radiogroup", { name: "Filter" })).getByRole("radio", { name: new RegExp(`^${label}`) }) as HTMLButtonElement;
}

function counts(): Record<string, string> {
  return Object.fromEntries(
    within(screen.getByRole("radiogroup", { name: "Filter" }))
      .getAllByRole("radio")
      .map((b) => [b.firstChild?.textContent ?? "", b.querySelector(".segmented__count")?.textContent ?? ""]),
  );
}

function search(value: string) {
  fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value } });
}

function inspector(): HTMLElement {
  return screen.getByRole("complementary", { name: "Inspector" });
}

/** Titles of the receipts the inspector lists. */
function receiptTitles(): string[] {
  return Array.from(inspector().querySelectorAll(".receipt-row__title")).map((el) => el.textContent ?? "");
}

function receiptItem(title: string): HTMLElement {
  return within(inspector()).getByText(title, { selector: ".receipt-row__title" }).closest<HTMLElement>("li")!;
}

/** Opens the menu of the button labelled `label` and picks `item`, inside a submenu when `submenu` names one. */
function pick(label: string, item: string, scope: HTMLElement = document.body, submenu?: string) {
  fireEvent.click(within(scope).getByRole("button", { name: label }));
  if (submenu) {
    fireEvent.click(screen.getByRole("menuitem", { name: submenu }));
  }
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

/** Makes a decision on the selected row: the inspector's first decision button. */
function decideFirst() {
  fireEvent.click(inspector().querySelector<HTMLButtonElement>("button[data-inspector-action]")!);
}

function previewSource(): string | null {
  const preview = within(inspector()).getByRole("region", { name: /^Preview of / });
  return preview.querySelector("iframe, img")?.getAttribute("src") ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(getReview).mockResolvedValue(DATA);
  vi.mocked(getDraft).mockResolvedValue({});
  vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus());
  vi.mocked(saveDraft).mockResolvedValue(undefined);
  vi.mocked(receiptUrl).mockImplementation((path) => `receipt://localhost/${path}`);
  vi.mocked(openReceipt).mockResolvedValue(undefined);
  vi.mocked(exportReport).mockResolvedValue("/Users/example/Reports/2030-03.xlsx");
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
    expect(screen.getByRole("region", { name: "Review March 2030" })).toBeTruthy();
  });

  it("shows the month's status in the toolbar while loading", () => {
    vi.mocked(getReview).mockReturnValue(new Promise(() => undefined));
    render(<Window onError={vi.fn()} />);
    expect(subtitle()).toBe("In review · 9 to decide");
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.queryByRole("radiogroup", { name: "Filter" })).toBeNull();
  });

  it("shows a load error and loads again on Try Again", async () => {
    vi.mocked(getReview).mockRejectedValueOnce({ kind: "not_found", message: "No reconciliation for March 2030." });
    await renderReview();
    expect(screen.getByRole("alert").textContent).toBe(
      "Couldn't Open This MonthConcilia can't find that item. It may have been moved or deleted.Details: No reconciliation for March 2030.Try Again",
    );
    expect(screen.getByRole("heading", { name: "Couldn't Open This Month" })).toBeTruthy();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(button("Try Again"));
    await settle();
    expect(getReview).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(options()).toHaveLength(5);
  });

  it("applies the stored draft", async () => {
    const draft: Draft = {
      "tx-3": { status: "MATCHED", receipt_meta: [stripped(INITECH)], receipt_files: [INITECH.file], notes: "manual_match" },
    };
    vi.mocked(getDraft).mockResolvedValue(draft);
    await renderReview();
    expect(counts()).toEqual({ All: "4", "Needs Review": "1", Unmatched: "0", Matched: "3" });
    select("INITECH SERVICES");
    expect(within(inspector()).getByText("Manual match")).toBeTruthy();
    expect(receiptTitles()).toEqual(["INITECH"]);
    // The receipt gets its preview path back from the review data.
    expect(previewSource()).toBe("receipt://localhost/2030/03/receipts/initech.pdf#navpanes=0");
  });
});

describe("list", () => {
  it("lists transactions by date with status, short date, description and signed amount, then reimbursements", async () => {
    await renderReview();
    expect(options()).toEqual([
      "Matched1 MarACME CORP-€10.00",
      "* Needs Review2 MarGLOBEX SHOP-€20.00",
      "Unmatched3 MarINITECH SERVICES-€30.00",
      "Matched4 MarHOOLI PAYROLL+€5,000.00",
      "Reimbursement7 MarACME TRAVEL€5.00",
    ]);
    expect(within(list()).getByRole("group", { name: "Reimbursements · €5.00 total" })).toBeTruthy();
  });

  it("starts on the first transaction needing a decision and points the listbox at it", async () => {
    await renderReview();
    expect(selected()).toBe("GLOBEX SHOP");
    const active = list().getAttribute("aria-activedescendant")!;
    expect(document.getElementById(active)?.textContent).toContain("GLOBEX SHOP");
  });

  it("starts on the first row when nothing needs a decision", async () => {
    vi.mocked(getReview).mockResolvedValue(makeReviewData({ transactions: [TX_ACME, TX_SALARY] }));
    await renderReview();
    expect(selected()).toBe("ACME CORP");
  });

  it("selects a clicked row", async () => {
    await renderReview();
    select("HOOLI PAYROLL");
    expect(selected()).toBe("HOOLI PAYROLL");
  });

  it("moves with the arrow keys, Home and End", async () => {
    await renderReview();
    key("ArrowDown");
    expect(selected()).toBe("INITECH SERVICES");
    key("ArrowUp");
    key("ArrowUp");
    key("ArrowUp");
    expect(selected()).toBe("ACME CORP");
    key("End");
    expect(selected()).toBe("ACME TRAVEL");
    key("ArrowDown");
    expect(selected()).toBe("ACME TRAVEL");
    key("Home");
    expect(selected()).toBe("ACME CORP");
  });

  it("leaves keys with modifiers alone", async () => {
    await renderReview();
    key("ArrowDown", { altKey: true });
    expect(selected()).toBe("GLOBEX SHOP");
  });

  it("jumps to the next and previous transaction needing a decision", async () => {
    const { commands } = await renderReview();
    act(() => commands().nextPending());
    expect(selected()).toBe("INITECH SERVICES");
    act(() => commands().nextPending());
    expect(selected()).toBe("INITECH SERVICES");
    act(() => commands().previousPending());
    expect(selected()).toBe("GLOBEX SHOP");
  });

  it("does not handle ⌘] and ⌘F itself", async () => {
    await renderReview();
    fireEvent.keyDown(window, { key: "]", metaKey: true });
    expect(selected()).toBe("GLOBEX SHOP");
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(document.activeElement).not.toBe(screen.getByRole("searchbox", { name: "Search" }));
  });

  it("focuses the search field", async () => {
    const { commands } = await renderReview();
    act(() => commands().focusSearch());
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search" }));
  });

  it("says when nothing is listed", async () => {
    await renderReview();
    search("umbrella");
    expect(options()).toEqual([]);
    expect(screen.getByText("No Results for “umbrella”")).toBeTruthy();
    expect(within(inspector()).getByText("No transaction selected.")).toBeTruthy();
  });
});

describe("filters and search", () => {
  it("counts transactions by status", async () => {
    await renderReview();
    expect(counts()).toEqual({ All: "4", "Needs Review": "1", Unmatched: "1", Matched: "2" });
    expect(filterButton("All").getAttribute("aria-checked")).toBe("true");
  });

  it("shows one status without the reimbursements", async () => {
    await renderReview();
    fireEvent.click(filterButton("Matched"));
    expect(options()).toEqual(["* Matched1 MarACME CORP-€10.00", "Matched4 MarHOOLI PAYROLL+€5,000.00"]);
    expect(filterButton("Matched").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(filterButton("Unmatched"));
    expect(options()).toEqual(["* Unmatched3 MarINITECH SERVICES-€30.00"]);
  });

  it("keeps the selection while it stays listed", async () => {
    await renderReview();
    select("HOOLI PAYROLL");
    fireEvent.click(filterButton("Matched"));
    expect(selected()).toBe("HOOLI PAYROLL");
    fireEvent.click(filterButton("Unmatched"));
    expect(selected()).toBe("INITECH SERVICES");
  });

  it("searches descriptions and reimbursements", async () => {
    await renderReview();
    search("acme");
    expect(options()).toEqual(["* Matched1 MarACME CORP-€10.00", "Reimbursement7 MarACME TRAVEL€5.00"]);
  });

  it("clears the search with Escape, then returns to the list", async () => {
    await renderReview();
    search("hooli");
    const field = screen.getByRole("searchbox", { name: "Search" });
    fireEvent.keyDown(field, { key: "Escape" });
    expect((field as HTMLInputElement).value).toBe("");
    expect(options()).toHaveLength(5);
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.activeElement).toBe(list());
    field.focus();
    fireEvent.keyDown(field, { key: "ArrowDown" });
    expect(document.activeElement).toBe(list());
  });
});

describe("inspector", () => {
  it("shows a REVIEW transaction with its candidates and the first one previewed", async () => {
    await renderReview();
    const panel = inspector();
    expect(within(panel).getByRole("heading", { name: "GLOBEX SHOP" })).toBeTruthy();
    expect(within(panel).getByText("-€20.00")).toBeTruthy();
    expect(within(panel).getByText("2 March 2030")).toBeTruthy();
    expect(within(panel).getByText("2 receipts match amount")).toBeTruthy();
    expect(within(panel).getByRole("region", { name: "Suggested Receipts" })).toBeTruthy();
    expect(receiptTitles()).toEqual(["GLOBEX", "HOOLI"]);
    expect(button("Assign GLOBEX", receiptItem("GLOBEX"))).toBeTruthy();
    expect(button("None of These", panel)).toBeTruthy();
    expect(within(panel).getByRole("button", { name: "No Receipt Needed" })).toBeTruthy();
    expect(previewSource()).toBe("receipt://localhost/2030/03/receipts/globex.pdf#navpanes=0");
  });

  it("previews the candidate clicked", async () => {
    await renderReview();
    fireEvent.click(within(receiptItem("HOOLI")).getByRole("button", { pressed: false }));
    expect(within(receiptItem("HOOLI")).getByRole("button", { pressed: true })).toBeTruthy();
    expect(within(inspector()).getByRole("img", { name: "hooli.jpg" }).getAttribute("src")).toBe("receipt://localhost/2030/03/receipts/hooli.jpg");
  });

  it("offers an UNMATCHED transaction the pool receipts closest in amount", async () => {
    await renderReview();
    fireEvent.click(button("None of These", inspector()));
    select("INITECH SERVICES");
    expect(within(inspector()).getByRole("region", { name: "Unmatched Receipts" })).toBeTruthy();
    expect(receiptTitles()).toEqual(["INITECH", "GLOBEX", "HOOLI"]);
    expect(button("Assign INITECH", receiptItem("INITECH"))).toBeTruthy();
    expect(within(receiptItem("GLOBEX")).getByText("Differs by €10.00")).toBeTruthy();
    expect(within(receiptItem("INITECH")).queryByText(/Differs by/)).toBeNull();
    expect(within(inspector()).queryByRole("button", { name: "None of These" })).toBeNull();
  });

  it("offers income no receipts", async () => {
    await renderReview();
    fireEvent.click(button("None of These", inspector()));
    select("HOOLI PAYROLL");
    fireEvent.click(button("Remove Match", inspector()));
    expect(receiptTitles()).toEqual([]);
    expect(within(inspector()).getByText("No receipts to assign.")).toBeTruthy();
    expect(within(inspector()).getByRole("button", { name: "No Receipt Needed" })).toBeTruthy();
    expect(within(inspector()).queryByRole("region", { name: /^Preview of/ })).toBeNull();
  });

  it("shows a MATCHED transaction's receipt and one marked as needing none", async () => {
    await renderReview();
    select("ACME CORP");
    expect(within(inspector()).getByRole("region", { name: "Receipt" })).toBeTruthy();
    expect(receiptTitles()).toEqual(["ACME"]);
    expect(button("Remove Match", inspector())).toBeTruthy();
    expect(within(inspector()).queryByRole("button", { name: "No Receipt Needed" })).toBeNull();
    select("HOOLI PAYROLL");
    expect(within(inspector()).getByText("No receipt needed: Salary")).toBeTruthy();
  });

  it("says when every candidate went to another transaction", async () => {
    const other = makeTransaction("tx-5", { date: "2030-03-05", description: "GLOBEX STORE", status: "MATCHED", receipt_meta: [GLOBEX, HOOLI] });
    vi.mocked(getReview).mockResolvedValue(makeReviewData({ transactions: [TX_GLOBEX, other] }));
    await renderReview();
    expect(within(inspector()).getByText("Every candidate was assigned to another transaction.")).toBeTruthy();
    expect(button("None of These", inspector())).toBeTruthy();
  });

  it("shows a reimbursement", async () => {
    await renderReview();
    select("ACME TRAVEL");
    expect(within(inspector()).getByRole("heading", { name: "ACME TRAVEL" })).toBeTruthy();
    expect(within(inspector()).getByText("Reimbursement")).toBeTruthy();
    expect(receiptTitles()).toEqual(["ACME TRAVEL"]);
    expect(within(inspector()).queryByRole("button", { name: "Remove Match" })).toBeNull();
  });

  it("hides and shows from the toolbar and remembers the choice", async () => {
    await renderReview();
    fireEvent.click(button("Hide Inspector", toolbar()));
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
    expect(localStorage.getItem("review.inspector")).toBe("hidden");
    cleanup();
    await renderReview();
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
    fireEvent.click(button("Show Inspector", toolbar()));
    expect(inspector()).toBeTruthy();
  });
});

describe("decisions", () => {
  it("accepts a candidate, freeing the other one", async () => {
    await renderReview();
    fireEvent.click(button("Assign GLOBEX", receiptItem("GLOBEX")));
    expect(options()[1]).toBe("* Matched2 MarGLOBEX SHOP-€20.00");
    expect(receiptTitles()).toEqual(["GLOBEX"]);
    expect(counts()).toEqual({ All: "4", "Needs Review": "0", Unmatched: "1", Matched: "3" });
    select("INITECH SERVICES");
    expect(receiptTitles()).toEqual(["INITECH", "HOOLI"]);
  });

  it("moves focus to the inspector's first decision with Return, and commits the focused candidate with the Accept command", async () => {
    const { commands } = await renderReview();
    list().focus();
    key("Enter");
    expect(document.activeElement).toBe(button("Assign GLOBEX", receiptItem("GLOBEX")));
    expect(receiptTitles()).toEqual(["GLOBEX", "HOOLI"]);
    fireEvent.click(within(receiptItem("HOOLI")).getByRole("button", { pressed: false }));
    act(() => commands().accept());
    expect(receiptTitles()).toEqual(["HOOLI"]);
  });

  it("returns focus to the list after a decision in the inspector", async () => {
    await renderReview();
    const assign = button("Assign GLOBEX", receiptItem("GLOBEX"));
    assign.focus();
    fireEvent.click(assign);
    expect(document.activeElement).toBe(list());
  });

  it("autosaves the decision 500 ms later without preview paths", async () => {
    await renderReview();
    decideFirst();
    await advance(499);
    expect(saveDraft).not.toHaveBeenCalled();
    await advance(1);
    expect(saveDraft).toHaveBeenCalledTimes(1);
    const [year, month, draft] = vi.mocked(saveDraft).mock.calls[0];
    expect([year, month]).toEqual(["2030", "03"]);
    expect(draft).toEqual({
      "tx-2": { status: "MATCHED", receipt_meta: [stripped(GLOBEX)], receipt_files: [GLOBEX.file], notes: "2 receipts match amount" },
    });
  });

  it("rejects every candidate with None of These", async () => {
    await renderReview();
    fireEvent.click(button("None of These", inspector()));
    expect(options()[1]).toBe("* Unmatched2 MarGLOBEX SHOP-€20.00");
    expect(receiptTitles()).toEqual(["GLOBEX", "HOOLI", "INITECH"]);
  });

  it("assigns a pool receipt", async () => {
    await renderReview();
    select("INITECH SERVICES");
    fireEvent.click(button("Assign INITECH", receiptItem("INITECH")));
    expect(within(inspector()).getByText("Manual match")).toBeTruthy();
    await advance(500);
    expect(vi.mocked(saveDraft).mock.calls[0][2]).toEqual({
      "tx-3": { status: "MATCHED", receipt_meta: [stripped(INITECH)], receipt_files: [INITECH.file], notes: "manual_match" },
    });
  });

  it("marks a transaction as needing no receipt", async () => {
    await renderReview();
    select("INITECH SERVICES");
    pick("No Receipt Needed", "Refund", inspector());
    expect(within(inspector()).getByText("No receipt needed: Refund")).toBeTruthy();
    await advance(500);
    expect(vi.mocked(saveDraft).mock.calls[0][2]).toEqual({ "tx-3": { status: "MATCHED", receipt_meta: [], receipt_files: [], notes: "refund" } });
  });

  it("disputes a match, freeing its receipt", async () => {
    await renderReview();
    select("ACME CORP");
    fireEvent.click(button("Remove Match", inspector()));
    expect(options()[0]).toBe("* Unmatched1 MarACME CORP-€10.00");
    select("INITECH SERVICES");
    expect(receiptTitles()).toEqual(["INITECH", "ACME"]);
  });

  it("hands the selection to the next row when the decided one leaves the filter", async () => {
    await renderReview();
    fireEvent.click(button("None of These", inspector()));
    fireEvent.click(filterButton("Unmatched"));
    expect(selected()).toBe("GLOBEX SHOP");
    fireEvent.click(button("Assign GLOBEX", receiptItem("GLOBEX")));
    expect(options()).toEqual(["* Unmatched3 MarINITECH SERVICES-€30.00"]);
  });
});

describe("context menu", () => {
  it("selects a right-clicked row and decides from its menu", async () => {
    await renderReview();
    fireEvent.contextMenu(within(list()).getByText("INITECH SERVICES"), { clientX: 40, clientY: 80 });
    expect(selected()).toBe("INITECH SERVICES");
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(items.map((i) => `${(i as HTMLButtonElement).disabled ? "-" : ""}${i.textContent}`)).toEqual([
      "Assign Receipt",
      "-Remove Match",
      "No Receipt Needed",
      "Quick Look",
      "Open in Preview",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "No Receipt Needed" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Refund" }));
    expect(within(inspector()).getByText("No receipt needed: Refund")).toBeTruthy();
  });

  it("names Reject by the row's status and assigns its focused receipt", async () => {
    await renderReview();
    fireEvent.contextMenu(within(list()).getByText("GLOBEX SHOP"));
    expect(screen.getByRole("menuitem", { name: "None of These" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Assign Receipt" }));
    expect(options()[1]).toBe("* Matched2 MarGLOBEX SHOP-€20.00");
  });

  it("offers a reimbursement Read Again and the previews", async () => {
    vi.mocked(rescanReimbursement).mockResolvedValue(stripped(TRAVEL));
    await renderReview();
    fireEvent.contextMenu(within(list()).getByText("ACME TRAVEL"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Read Receipt Again" }));
    expect(rescanReimbursement).toHaveBeenCalledWith("2030", "03", "2030/03/receipts/acme-travel.pdf");
  });
});

describe("inspector width", () => {
  it("resizes from its divider within 260 to 400 pixels and remembers the width", async () => {
    await renderReview();
    const divider = screen.getByRole("separator", { name: "Resize Inspector" });
    const width = () => screen.getByRole("region", { name: /^Review / }).style.getPropertyValue("--inspector-width");
    expect(divider.getAttribute("aria-valuenow")).toBe("300");
    expect(width()).toBe("300px");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(width()).toBe("310px");
    fireEvent.keyDown(divider, { key: "End" });
    expect(divider.getAttribute("aria-valuenow")).toBe("400");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider.getAttribute("aria-valuenow")).toBe("400");
    expect(localStorage.getItem("review.inspectorWidth")).toBe("400");
    fireEvent.keyDown(divider, { key: "Home" });
    expect(width()).toBe("260px");
  });
});

describe("undo and redo", () => {
  it("undoes and redoes decisions, selecting the transaction that changed", async () => {
    const { commands } = await renderReview();
    expect(commands().can.undo).toBe(false);
    fireEvent.click(button("Assign GLOBEX", receiptItem("GLOBEX")));
    select("ACME CORP");
    act(() => commands().undo());
    expect(selected()).toBe("GLOBEX SHOP");
    expect(options()[1]).toBe("* Needs Review2 MarGLOBEX SHOP-€20.00");
    expect(commands().can.redo).toBe(true);
    act(() => commands().redo());
    expect(options()[1]).toBe("* Matched2 MarGLOBEX SHOP-€20.00");
    await advance(500);
    expect(Object.keys(vi.mocked(saveDraft).mock.calls[0][2])).toEqual(["tx-2"]);
  });

  it("saves the draft an undo returns to", async () => {
    const { commands } = await renderReview();
    fireEvent.click(button("Assign GLOBEX", receiptItem("GLOBEX")));
    act(() => commands().undo());
    await advance(500);
    expect(vi.mocked(saveDraft).mock.calls[0][2]).toEqual({});
  });

  it("does nothing with nothing to undo or redo", async () => {
    const { commands } = await renderReview();
    act(() => commands().undo());
    act(() => commands().redo());
    await advance(500);
    expect(saveDraft).not.toHaveBeenCalled();
  });
});

describe("commands", () => {
  it("reports what can run for the selection", async () => {
    const { commands, onAvailabilityChange } = await renderReview();
    expect(commands().can).toEqual({
      accept: true,
      reject: true,
      noReceipt: true,
      rescan: true,
      quickLook: true,
      openInPreview: true,
      nextPending: true,
      previousPending: false,
      undo: false,
      redo: false,
      setFilter: true,
      focusSearch: true,
      toggleInspector: true,
      scan: true,
      exportReport: true,
      finalize: true,
    });
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(commands().can);
    select("ACME CORP");
    expect(commands().can).toMatchObject({ accept: false, reject: true, noReceipt: false, previousPending: false, nextPending: true });
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(expect.objectContaining({ accept: false }));
  });

  it("reports whether the inspector is shown", async () => {
    const onInspectorChange = vi.fn<(shown: boolean) => void>();
    const { commands } = await renderReview({ onInspectorChange });
    expect(onInspectorChange).toHaveBeenLastCalledWith(true);
    act(() => commands().toggleInspector());
    expect(onInspectorChange).toHaveBeenLastCalledWith(false);
  });

  it("reports what Reject does for the selection", async () => {
    const onRejectKindChange = vi.fn<(kind: "noneOfThese" | "removeMatch") => void>();
    await renderReview({ onRejectKindChange });
    select("GLOBEX SHOP");
    expect(onRejectKindChange).toHaveBeenLastCalledWith("noneOfThese");
    select("HOOLI PAYROLL");
    expect(onRejectKindChange).toHaveBeenLastCalledWith("removeMatch");
  });

  it("runs decisions on the selection", async () => {
    const { commands } = await renderReview();
    act(() => commands().noReceipt("bank_fee"));
    expect(options()[1]).toBe("* Matched2 MarGLOBEX SHOP-€20.00");
    act(() => commands().reject());
    expect(options()[1]).toBe("* Unmatched2 MarGLOBEX SHOP-€20.00");
    act(() => commands().accept());
    expect(options()[1]).toBe("* Matched2 MarGLOBEX SHOP-€20.00");
    expect(receiptTitles()).toEqual(["GLOBEX"]);
  });

  it("skips commands that cannot run", async () => {
    const { commands } = await renderReview();
    select("ACME CORP");
    act(() => commands().accept());
    act(() => commands().noReceipt("refund"));
    expect(options()[0]).toBe("* Matched1 MarACME CORP-€10.00");
    select("HOOLI PAYROLL");
    expect(commands().can.quickLook).toBe(false);
    act(() => commands().quickLook());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("filters, moves and toggles the inspector", async () => {
    const { commands } = await renderReview();
    act(() => commands().nextPending());
    expect(selected()).toBe("INITECH SERVICES");
    act(() => commands().previousPending());
    expect(selected()).toBe("GLOBEX SHOP");
    act(() => commands().setFilter("matched"));
    expect(filterButton("Matched").getAttribute("aria-checked")).toBe("true");
    act(() => commands().toggleInspector());
    expect(screen.queryByRole("complementary", { name: "Inspector" })).toBeNull();
    act(() => commands().focusSearch());
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search" }));
  });

  it("opens the focused receipt in Preview", async () => {
    const { commands } = await renderReview();
    act(() => commands().openInPreview());
    expect(openReceipt).toHaveBeenCalledWith("2030", "03", "2030/03/receipts/globex.pdf");
  });
});

describe("receipt actions", () => {
  it("opens a receipt in Preview from its menu", async () => {
    await renderReview();
    pick("Actions for HOOLI", "Open in Preview");
    expect(openReceipt).toHaveBeenCalledWith("2030", "03", "2030/03/receipts/hooli.jpg");
  });

  it("reports a receipt that cannot be opened", async () => {
    const error = { kind: "io", message: "no viewer" };
    vi.mocked(openReceipt).mockRejectedValue(error);
    const { onError } = await renderReview();
    pick("Actions for GLOBEX", "Open in Preview");
    await settle();
    expect(onError).toHaveBeenCalledWith(error);
  });

  it("rescans a receipt and shows the new reading", async () => {
    const pending = deferred<ReceiptMeta>();
    vi.mocked(rescanReceipt).mockReturnValue(pending.promise);
    await renderReview();
    pick("Actions for GLOBEX", "Read Again");
    expect(rescanReceipt).toHaveBeenCalledWith("2030", "03", "2030/03/receipts/globex.pdf");
    expect(within(receiptItem("GLOBEX")).getByRole("status", { name: "Reading…" })).toBeTruthy();
    fireEvent.click(button("Actions for GLOBEX", receiptItem("GLOBEX")));
    expect((screen.getByRole("menuitem", { name: "Read Again" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await act(async () => pending.resolve({ ...stripped(GLOBEX), vendor: "GLOBEX LTD", amount_cents: 2100 }));
    expect(receiptTitles()).toEqual(["GLOBEX LTD", "HOOLI"]);
    expect(within(receiptItem("GLOBEX LTD")).getByText("€21.00")).toBeTruthy();
    expect(within(receiptItem("GLOBEX LTD")).getByText("Differs by €1.00")).toBeTruthy();
    expect(within(receiptItem("GLOBEX LTD")).queryByRole("status")).toBeNull();
    // The preview path survives the rescan.
    expect(previewSource()).toBe("receipt://localhost/2030/03/receipts/globex.pdf#navpanes=0");
  });

  it("rescans a receipt held by a pending decision", async () => {
    vi.mocked(rescanReceipt).mockResolvedValue({ ...stripped(GLOBEX), vendor: "GLOBEX LTD" });
    const { commands } = await renderReview();
    fireEvent.click(button("Assign GLOBEX", receiptItem("GLOBEX")));
    act(() => commands().rescan());
    await settle();
    expect(receiptTitles()).toEqual(["GLOBEX LTD"]);
    await advance(500);
    const calls = vi.mocked(saveDraft).mock.calls;
    expect(calls[calls.length - 1][2]["tx-2"].receipt_meta?.[0].vendor).toBe("GLOBEX LTD");
  });

  it("rescans a reimbursement", async () => {
    vi.mocked(rescanReimbursement).mockResolvedValue({ ...stripped(TRAVEL), amount_cents: 700 });
    await renderReview();
    select("ACME TRAVEL");
    pick("Actions for ACME TRAVEL", "Read Again");
    expect(rescanReimbursement).toHaveBeenCalledWith("2030", "03", "2030/03/receipts/acme-travel.pdf");
    expect(rescanReceipt).not.toHaveBeenCalled();
    await settle();
    expect(within(list()).getByRole("group", { name: "Reimbursements · €7.00 total" })).toBeTruthy();
  });

  it("reports a failed rescan", async () => {
    const error = { kind: "network", message: "offline" };
    vi.mocked(rescanReceipt).mockRejectedValue(error);
    const { onError } = await renderReview();
    pick("Actions for GLOBEX", "Read Again");
    await settle();
    expect(onError).toHaveBeenCalledWith(error);
    expect(receiptTitles()).toEqual(["GLOBEX", "HOOLI"]);
  });
});

describe("Quick Look", () => {
  it("opens with Space and closes with Escape, returning focus to the list", async () => {
    await renderReview();
    list().focus();
    key(" ");
    const dialog = screen.getByRole("dialog", { name: "Quick Look of globex.pdf" });
    expect(dialog.querySelector("iframe")?.getAttribute("src")).toBe("receipt://localhost/2030/03/receipts/globex.pdf#navpanes=0");
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(list());
  });

  it("closes with Space and opens in Preview", async () => {
    await renderReview();
    fireEvent.click(button("Quick Look", inspector()));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(button("Open in Preview", dialog));
    expect(openReceipt).toHaveBeenCalledWith("2030", "03", "2030/03/receipts/globex.pdf");
    fireEvent.keyDown(dialog, { key: " " });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves the selection with the arrow keys and previews each row's receipt, keeping Tab inside", async () => {
    await renderReview();
    list().focus();
    key(" ");
    const dialog = screen.getByRole("dialog", { name: "Quick Look of globex.pdf" });
    fireEvent.keyDown(dialog, { key: "ArrowUp" });
    expect(selected()).toBe("ACME CORP");
    expect(screen.getByRole("dialog", { name: "Quick Look of acme.pdf" })).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    expect(selected()).toBe("INITECH SERVICES");
    expect(screen.getByRole("dialog", { name: "Quick Look of initech.pdf" })).toBeTruthy();
    const close = button("Close", dialog);
    const open = button("Open in Preview", dialog);
    open.focus();
    fireEvent.keyDown(open, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    expect(list().closest("[inert]")).toBeTruthy();
  });

  it("opens on a double click and closes from the backdrop", async () => {
    await renderReview();
    fireEvent.doubleClick(within(list()).getByText("ACME CORP"));
    expect(selected()).toBe("ACME CORP");
    expect(screen.getByRole("dialog", { name: "Quick Look of acme.pdf" })).toBeTruthy();
    fireEvent.mouseDown(document.querySelector(".quicklook-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("toolbar", () => {
  it("shows the status, pending count and save state in the subtitle", async () => {
    const save = deferred<void>();
    vi.mocked(saveDraft).mockReturnValue(save.promise);
    const { onChanged } = await renderReview();
    expect(subtitle()).toBe("In review · 2 to decide");
    decideFirst();
    await advance(500);
    expect(subtitle()).toBe("In review · 1 to decide · Saving…");
    await act(async () => save.resolve());
    expect(subtitle()).toBe("In review · 1 to decide · Saved");
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it("reports a failed save", async () => {
    vi.mocked(saveDraft).mockRejectedValue({ kind: "io", message: "disk full" });
    await renderReview();
    decideFirst();
    await advance(500);
    const alert = within(toolbar()).getByRole("alert");
    expect(alert.textContent).toBe(" ·  Couldn't save changes: Concilia couldn't read or write a file. Check that the folder is available, then try again. Details: disk full");
  });

  it("shows the run's figures until the first change", async () => {
    await renderReview({ runSummary: "4 transactions · 4 receipts · 50% matched" });
    expect(subtitle()).toBe("4 transactions · 4 receipts · 50% matched");
    decideFirst();
    expect(subtitle()).toBe("In review · 1 to decide");
  });

  it("says In review when nothing is left", async () => {
    vi.mocked(getReview).mockResolvedValue(makeReviewData({ transactions: [TX_ACME] }));
    await renderReview();
    expect(subtitle()).toBe("In review");
  });

  it("offers the month's other actions", async () => {
    await renderReview();
    pick("More Actions", "Open Report", toolbar());
    expect(openReport).toHaveBeenCalledTimes(1);
    expect(button("Scan for New Receipts", toolbar()).disabled).toBe(false);
    expect(button("Finalize…", toolbar()).disabled).toBe(false);
  });

  it("hides Finalize and disables Scan for a finalized month", async () => {
    vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus({ applied: true }));
    const { commands } = await renderReview();
    expect(subtitle()).toBe("Finalized");
    expect(within(toolbar()).queryByRole("button", { name: "Finalize…" })).toBeNull();
    expect(button("Scan for New Receipts", toolbar()).disabled).toBe(true);
    expect(button("Export Report…", toolbar()).disabled).toBe(false);
    expect(commands().can).toMatchObject({ scan: false, finalize: false, exportReport: true });
  });

  it("shows a finalized month read-only", async () => {
    vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus({ applied: true }));
    const { commands } = await renderReview();
    expect(within(inspector()).getByText("This month is finalized. Reconcile it again to change decisions.")).toBeTruthy();
    expect(within(inspector()).queryByRole("button", { name: /^Assign / })).toBeNull();
    expect(within(inspector()).queryByRole("button", { name: "None of These" })).toBeNull();
    expect(within(inspector()).queryByRole("button", { name: "No Receipt Needed" })).toBeNull();
    expect(commands().can).toMatchObject({ accept: false, reject: false, noReceipt: false, rescan: false, quickLook: true, openInPreview: true });
    fireEvent.click(button("Actions for GLOBEX", receiptItem("GLOBEX")));
    expect((screen.getByRole("menuitem", { name: "Read Again" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("scan for new receipts", () => {
  it("saves pending changes, then scans with progress", async () => {
    const run = scanRun();
    await renderReview();
    decideFirst();
    fireEvent.click(button("Scan for New Receipts", toolbar()));
    expect(startScan).not.toHaveBeenCalled();
    await settle();
    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(startScan).toHaveBeenCalledWith("2030", "03", expect.any(Function));
    expect(vi.mocked(saveDraft).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(startScan).mock.invocationCallOrder[0]);

    const dialog = screen.getByRole("dialog", { name: "Scan for New Receipts" });
    await run.push({ step: "receipts_found", count: 3 });
    await run.push({ step: "extracting", current: 1, total: 3 });
    expect(within(dialog).getByRole("progressbar", { name: "Extracting receipt data" })).toBeTruthy();
    expect(button("Scan for New Receipts", toolbar()).disabled).toBe(true);
    expect(button("Export Report…", toolbar()).disabled).toBe(true);
    expect(button("Finalize…", toolbar()).disabled).toBe(true);
    run.result.resolve({ summary: SUMMARY, dropped_decisions: [] });
    await settle();
  });

  it("cancels a scan", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts", toolbar()));
    await settle();
    fireEvent.click(button("Cancel", screen.getByRole("dialog")));
    expect(run.cancel).toHaveBeenCalledTimes(1);
    expect(button("Cancelling…", screen.getByRole("dialog")).disabled).toBe(true);
  });

  it("shows the scan in a sheet that Esc cancels", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts", toolbar()));
    await settle();
    const sheet = screen.getByRole("dialog", { name: "Scan for New Receipts" });
    expect(sheet.querySelector(".sheet__title")?.textContent).toBe("Scan for New Receipts");
    expect(document.activeElement).toBe(button("Cancel", sheet));
    expect(list().closest("[inert]")).toBeTruthy();
    fireEvent.keyDown(sheet, { key: "Escape" });
    expect(run.cancel).toHaveBeenCalledTimes(1);
    await act(async () => run.result.reject({ kind: "cancelled", message: "cancelled" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reloads and reports dropped decisions in one dismissible warning", async () => {
    const run = scanRun();
    const { onChanged, commands } = await renderReview();
    fireEvent.click(button("Assign GLOBEX", receiptItem("GLOBEX")));
    act(() => commands().scan());
    await settle();
    vi.mocked(getReview).mockResolvedValue(makeReviewData({ transactions: [TX_ACME, TX_INITECH] }));
    run.result.resolve({
      summary: SUMMARY,
      dropped_decisions: [
        { txId: "tx-2", description: "GLOBEX SHOP", removedReceiptFiles: [GLOBEX.file] },
        { txId: "tx-9", description: "HOOLI STORE", removedReceiptFiles: [HOOLI.file] },
      ],
    });
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getReview).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalled();
    expect(options()).toEqual(["Matched1 MarACME CORP-€10.00", "* Unmatched3 MarINITECH SERVICES-€30.00"]);
    // A reload starts a new history.
    expect(commands().can.undo).toBe(false);
    const banner = screen.getByText("2 decisions were discarded because their receipts are gone: GLOBEX SHOP, HOOLI STORE.").closest<HTMLElement>(".banner")!;
    fireEvent.click(button("Dismiss", banner));
    expect(screen.queryByText(/decisions were discarded/)).toBeNull();
  });

  it("names one dropped decision", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts", toolbar()));
    await settle();
    run.result.resolve({ summary: SUMMARY, dropped_decisions: [{ txId: "tx-2", description: "GLOBEX SHOP", removedReceiptFiles: [GLOBEX.file] }] });
    await settle();
    expect(screen.getByText("1 decision was discarded because its receipt is gone: GLOBEX SHOP.")).toBeTruthy();
  });

  it("shows a failed scan until closed", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts", toolbar()));
    await settle();
    run.result.reject({ kind: "io", message: "folder missing" });
    await settle();
    const dialog = screen.getByRole("dialog", { name: "Scan for New Receipts" });
    expect(within(dialog).getByRole("alert").textContent).toContain("Details: folder missing");
    fireEvent.click(button("Close", dialog));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(getReview).toHaveBeenCalledTimes(1);
  });

  it("reports a failed save and does not scan", async () => {
    const error = { kind: "io", message: "disk full" };
    vi.mocked(saveDraft).mockRejectedValue(error);
    scanRun();
    const { onError } = await renderReview();
    decideFirst();
    fireEvent.click(button("Scan for New Receipts", toolbar()));
    await settle();
    expect(onError).toHaveBeenCalledWith(error);
    expect(startScan).not.toHaveBeenCalled();
  });
});

describe("export report", () => {
  it("saves pending changes, then exports without a notice", async () => {
    await renderReview();
    decideFirst();
    fireEvent.click(button("Export Report…", toolbar()));
    await settle();
    expect(exportReport).toHaveBeenCalledWith("2030", "03");
    expect(vi.mocked(saveDraft).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(exportReport).mock.invocationCallOrder[0]);
    expect(screen.queryByText(/2030-03.xlsx/)).toBeNull();
  });

  it("reports a failed export", async () => {
    const error = { kind: "io", message: "read-only volume" };
    vi.mocked(exportReport).mockRejectedValue(error);
    const { onError } = await renderReview();
    fireEvent.click(button("Export Report…", toolbar()));
    await settle();
    expect(onError).toHaveBeenCalledWith(error);
  });
});

describe("finalize", () => {
  it("asks with the counts of the receipts that move and what is left", async () => {
    await renderReview();
    fireEvent.click(button("Finalize…", toolbar()));
    const sheet = screen.getByRole("alertdialog", { name: "Finalize March 2030?" });
    expect(sheet.textContent).toContain(
      "4 receipts will be moved: 1 to _matched, 2 to _review and 1 to _unmatched. They stay in this month's receipts folder.",
    );
    expect(sheet.textContent).toContain("You can't undo this.");
    expect(sheet.textContent).toContain("2 transactions still need a decision. They will be sorted as they are now.");
    expect(within(sheet).queryByRole("checkbox")).toBeNull();
    expect(document.activeElement).toBe(button("Cancel", sheet));
    fireEvent.click(button("Cancel", sheet));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(finalize).not.toHaveBeenCalled();
  });

  it("leaves out the pending line when every transaction is decided", async () => {
    vi.mocked(getReview).mockResolvedValue(makeReviewData({ transactions: [TX_ACME] }));
    const { commands } = await renderReview();
    act(() => commands().finalize());
    const sheet = screen.getByRole("alertdialog");
    expect(sheet.textContent).toContain("1 receipt will be moved: 1 to _matched, 0 to _review and 0 to _unmatched.");
    expect(sheet.textContent).not.toContain("still need");
  });

  it("saves pending changes, finalizes and reloads", async () => {
    const done = deferred<void>();
    vi.mocked(finalize).mockReturnValue(done.promise);
    const { onChanged } = await renderReview();
    decideFirst();
    fireEvent.click(button("Finalize…", toolbar()));
    const sheet = screen.getByRole("alertdialog");
    fireEvent.click(button("Finalize", sheet));
    expect(button("Working…", sheet).disabled).toBe(true);
    await settle();
    expect(finalize).toHaveBeenCalledWith("2030", "03");
    expect(vi.mocked(saveDraft).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(finalize).mock.invocationCallOrder[0]);

    vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus({ applied: true }));
    await act(async () => done.resolve());
    await settle();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(getReview).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalled();
    expect(subtitle()).toBe("Finalized");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports a failed finalize and keeps the sheet open", async () => {
    const error = { kind: "busy", message: "scan running" };
    vi.mocked(finalize).mockRejectedValue(error);
    const { onError } = await renderReview();
    fireEvent.click(button("Finalize…", toolbar()));
    const sheet = screen.getByRole("alertdialog");
    fireEvent.click(button("Finalize", sheet));
    await settle();
    expect(onError).toHaveBeenCalledWith(error);
    expect(screen.getByRole("alertdialog")).toBe(sheet);
    expect(button("Finalize", sheet).disabled).toBe(false);
    expect(getReview).toHaveBeenCalledTimes(1);
  });
});
