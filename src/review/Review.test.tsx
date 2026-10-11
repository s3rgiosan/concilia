// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PopUpAction } from "../components/PopUpButton";
import {
  exportReport,
  finalize,
  getDraft,
  getReview,
  getRules,
  openReceipt,
  openReport as openReportFile,
  openSettings,
  periodStatus,
  pickStatements,
  receiptUrl,
  rescanReceipt,
  rescanReimbursement,
  revealPeriod,
  saveDraft,
  saveRules,
  startAddStatements,
  startScan,
  type AddStatementsResult,
  type Draft,
  type ReceiptMeta,
  type RunEvent,
  type RunHandle,
  type ScanResult,
} from "../lib/tauri";
import { deferred, makePeriodStatus, makeReceipt, makeReviewData, makeTransaction } from "../test/fixtures";
import type { RejectKind, ReviewAvailability, ReviewCommands } from "../lib/menuCommands";
import { Review, type ReviewProps } from "./Review";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  exportReport: vi.fn(),
  finalize: vi.fn(),
  getDraft: vi.fn(),
  getReview: vi.fn(),
  getRules: vi.fn(),
  openReceipt: vi.fn(),
  openReport: vi.fn(),
  periodStatus: vi.fn(),
  receiptUrl: vi.fn(),
  rescanReceipt: vi.fn(),
  rescanReimbursement: vi.fn(),
  requestAttention: vi.fn(() => Promise.resolve()),
  revealPeriod: vi.fn(),
  saveDraft: vi.fn(),
  saveRules: vi.fn(),
  setDockProgress: vi.fn(() => Promise.resolve()),
  openSettings: vi.fn(() => Promise.resolve()),
  pickStatements: vi.fn(),
  startAddStatements: vi.fn(),
  startScan: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

/** Drops files on the window, as the webview reports them. */
let dropFiles: (paths: string[]) => void = () => undefined;
/** Reports files dragged over the window. */
let dragOver: () => void = () => undefined;

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
  return { result, cancel, push: (event: RunEvent) =>
      act(async () => {
        onEvent(event);
        await vi.advanceTimersByTimeAsync(20);
      }) };
}

/** Adding statements the test settles by hand. */
function addRun() {
  const result = deferred<AddStatementsResult>();
  const cancel = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  let onEvent: (event: RunEvent) => void = () => undefined;
  vi.mocked(startAddStatements).mockImplementation((_year, _month, _statements, callback) => {
    onEvent = callback;
    return { promise: result.promise, cancel };
  });
  return { result, cancel, push: (event: RunEvent) =>
      act(async () => {
        onEvent(event);
        await vi.advanceTimersByTimeAsync(20);
      }) };
}

const ADDED: AddStatementsResult = {
  summary: SUMMARY,
  added: 3,
  duplicates_skipped: 1,
  newly_matched: 2,
  statements: [{ file: "extrato-b.pdf", bank: "cgd", added: 3, skipped: 1 }],
  dropped_decisions: [],
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

/**
 * Renders the review and waits for it to load. Unless `opening` is set, it then shows every
 * transaction, so a test starts from the full list rather than the ones still to decide.
 */
async function renderReview(props: Partial<ReviewProps> = {}, { opening = false } = {}) {
  const onChanged = vi.fn();
  const onSaved = vi.fn();
  const onError = vi.fn();
  const onAvailabilityChange = vi.fn<(can: ReviewAvailability) => void>();
  const ref = createRef<ReviewCommands>();
  const result = render(<Window onChanged={onChanged} onSaved={onSaved} onError={onError} onAvailabilityChange={onAvailabilityChange} ref={ref} {...props} />);
  await settle();
  const all = screen.queryByRole("radio", { name: /^All/ });
  if (!opening && all) {
    fireEvent.click(all);
  }
  return { ...result, onChanged, onSaved, onError, onAvailabilityChange, commands: () => ref.current! };
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

function details(): HTMLElement {
  return screen.getByRole("complementary", { name: "Details" });
}

/** Titles of the receipts the details column lists. */
function receiptTitles(): string[] {
  return Array.from(details().querySelectorAll(".receipt-row__title")).map((el) => el.textContent ?? "");
}

function receiptItem(title: string): HTMLElement {
  return within(details()).getByText(title, { selector: ".receipt-row__title" }).closest<HTMLElement>("li")!;
}

/** Opens the menu of the button labelled `label` and picks `item`, inside a submenu when `submenu` names one. */
function pick(label: string, item: string, scope: HTMLElement = document.body, submenu?: string) {
  fireEvent.click(within(scope).getByRole("button", { name: label }));
  if (submenu) {
    fireEvent.click(screen.getByRole("menuitem", { name: submenu }));
  }
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}

/** Makes a decision on the selected row: the details column's first decision button. */
function decideFirst() {
  fireEvent.click(details().querySelector<HTMLButtonElement>("button[data-details-action]")!);
}

/** The preview's source once the preview has settled on the focused receipt. */
function previewSource(): string | null {
  act(() => {
    vi.advanceTimersByTime(200);
  });
  const preview = within(details()).getByRole("region", { name: /^Preview of / });
  return preview.querySelector("iframe, img")?.getAttribute("src") ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  let uuid = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    uuid += 1;
    return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
  });
  vi.mocked(getCurrentWebview).mockReturnValue({
    onDragDropEvent: (handler: (event: { payload: { type: "drop"; paths: string[] } | { type: "over" } }) => void) => {
      dropFiles = (paths) => act(() => handler({ payload: { type: "drop", paths } }));
      dragOver = () => act(() => handler({ payload: { type: "over" } }));
      return Promise.resolve(() => undefined);
    },
  } as unknown as ReturnType<typeof getCurrentWebview>);
  vi.mocked(pickStatements).mockResolvedValue([]);
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
    expect(options()).toHaveLength(2);
  });

  it("applies the stored draft", async () => {
    const draft: Draft = {
      "tx-3": { status: "MATCHED", receipt_meta: [stripped(INITECH)], receipt_files: [INITECH.file], notes: "manual_match" },
    };
    vi.mocked(getDraft).mockResolvedValue(draft);
    await renderReview();
    expect(counts()).toEqual({ "To Decide": "1", Matched: "3", All: "4" });
    select("INITECH SERVICES");
    expect(within(details()).getByText("Manual decision")).toBeTruthy();
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
      "No Receipt · Salary4 MarHOOLI PAYROLL+€5,000.00",
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
    expect(within(details()).getByText("No Selection")).toBeTruthy();
  });
});

describe("empty list", () => {
  it("says when every transaction has a decision and offers Finalize…", async () => {
    await renderReview({}, { opening: true });
    fireEvent.click(button("Assign GLOBEX", receiptItem("GLOBEX")));
    fireEvent.click(button("Assign INITECH", receiptItem("INITECH")));
    expect(options()).toEqual([]);
    expect(screen.getByText("Every Transaction Has a Decision")).toBeTruthy();
    expect(screen.getByText("Finalize the month to sort its receipts and save the report.")).toBeTruthy();
    expect(within(details()).getByText("No Selection")).toBeTruthy();
    const finalizeHere = within(list().parentElement!).getByRole("button", { name: "Finalize…" });
    expect(finalizeHere.classList.contains("default")).toBe(true);
    fireEvent.click(finalizeHere);
    expect(screen.getByRole("alertdialog", { name: "Finalize March 2030?" })).toBeTruthy();
  });

  it("points to the transactions still to decide from another filter", async () => {
    vi.mocked(getReview).mockResolvedValue(makeReviewData({ transactions: [TX_GLOBEX, TX_INITECH] }));
    await renderReview();
    fireEvent.click(filterButton("Matched"));
    expect(screen.getByText("No Matched Transactions")).toBeTruthy();
    expect(screen.getByText("2 transactions still need a decision.")).toBeTruthy();
    fireEvent.click(button("Show Them"));
    expect(filterButton("To Decide").getAttribute("aria-checked")).toBe("true");
    expect(options()).toHaveLength(2);
  });
});

describe("filters and search", () => {
  it("counts the transactions to decide, the matched ones and all of them", async () => {
    await renderReview();
    expect(counts()).toEqual({ "To Decide": "2", Matched: "2", All: "4" });
    expect(filterButton("All").getAttribute("aria-checked")).toBe("true");
  });

  it("opens on the transactions still to decide", async () => {
    await renderReview({}, { opening: true });
    expect(filterButton("To Decide").getAttribute("aria-checked")).toBe("true");
    expect(options()).toEqual(["* Needs Review2 MarGLOBEX SHOP-€20.00", "Unmatched3 MarINITECH SERVICES-€30.00"]);
  });

  it("opens on every transaction when nothing is left to decide or the month is finalized", async () => {
    vi.mocked(getReview).mockResolvedValue(makeReviewData({ transactions: [TX_ACME, TX_SALARY] }));
    await renderReview({}, { opening: true });
    expect(filterButton("All").getAttribute("aria-checked")).toBe("true");
    cleanup();
    vi.mocked(getReview).mockResolvedValue(DATA);
    vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus({ applied: true }));
    await renderReview({}, { opening: true });
    expect(filterButton("All").getAttribute("aria-checked")).toBe("true");
  });

  it("shows one filter without the reimbursements", async () => {
    await renderReview();
    fireEvent.click(filterButton("Matched"));
    expect(options()).toEqual(["* Matched1 MarACME CORP-€10.00", "No Receipt · Salary4 MarHOOLI PAYROLL+€5,000.00"]);
    expect(filterButton("Matched").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(filterButton("To Decide"));
    expect(options()).toEqual(["* Needs Review2 MarGLOBEX SHOP-€20.00", "Unmatched3 MarINITECH SERVICES-€30.00"]);
  });

  it("keeps the selection while it stays listed", async () => {
    await renderReview();
    select("HOOLI PAYROLL");
    fireEvent.click(filterButton("Matched"));
    expect(selected()).toBe("HOOLI PAYROLL");
    fireEvent.click(filterButton("To Decide"));
    expect(selected()).toBe("GLOBEX SHOP");
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

describe("details", () => {
  it("shows a REVIEW transaction with its candidates and the first one previewed", async () => {
    await renderReview();
    const panel = details();
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
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(within(details()).getByRole("img", { name: "hooli.jpg" }).getAttribute("src")).toBe("receipt://localhost/2030/03/receipts/hooli.jpg");
  });

  it("offers an UNMATCHED transaction the pool receipts closest in amount", async () => {
    await renderReview();
    fireEvent.click(button("None of These", details()));
    select("INITECH SERVICES");
    expect(within(details()).getByRole("region", { name: "Unmatched Receipts" })).toBeTruthy();
    expect(receiptTitles()).toEqual(["INITECH", "GLOBEX", "HOOLI"]);
    expect(button("Assign INITECH", receiptItem("INITECH"))).toBeTruthy();
    expect(within(receiptItem("GLOBEX")).getByText("Differs by €10.00")).toBeTruthy();
    expect(within(receiptItem("INITECH")).queryByText(/Differs by/)).toBeNull();
    expect(within(details()).queryByRole("button", { name: "None of These" })).toBeNull();
  });

  it("offers income no receipts, its likely categories first", async () => {
    await renderReview();
    fireEvent.click(button("None of These", details()));
    select("HOOLI PAYROLL");
    fireEvent.click(button("Needs a Receipt", details()));
    expect(receiptTitles()).toEqual([]);
    expect(within(details()).getByText("No receipts to assign.")).toBeTruthy();
    expect(within(details()).queryByRole("region", { name: /^Preview of/ })).toBeNull();
    fireEvent.click(button("No Receipt Needed", details()));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["Transfer", "Salary", "Refund", "Bank Fee", "Other"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Bank Fee" }));
    expect(options()[3]).toBe("* No Receipt · Bank Fee4 MarHOOLI PAYROLLEdited+€5,000.00");
    fireEvent.click(button("Needs a Receipt", details()));
    pick("No Receipt Needed", "Transfer", details());
    expect(within(details()).getByText("No receipt needed: Transfer")).toBeTruthy();
  });

  it("shows a MATCHED transaction's receipt and one marked as needing none", async () => {
    await renderReview();
    select("ACME CORP");
    expect(within(details()).getByRole("region", { name: "Receipt" })).toBeTruthy();
    expect(receiptTitles()).toEqual(["ACME"]);
    expect(button("Remove Match", details())).toBeTruthy();
    expect(within(details()).queryByRole("button", { name: "No Receipt Needed" })).toBeNull();
    select("HOOLI PAYROLL");
    expect(within(details()).getByText("No receipt needed: Salary")).toBeTruthy();
    expect(button("Needs a Receipt", details())).toBeTruthy();
    expect(within(details()).queryByRole("button", { name: "Remove Match" })).toBeNull();
  });

  it("says when every candidate went to another transaction", async () => {
    const other = makeTransaction("tx-5", { date: "2030-03-05", description: "GLOBEX STORE", status: "MATCHED", receipt_meta: [GLOBEX, HOOLI] });
    vi.mocked(getReview).mockResolvedValue(makeReviewData({ transactions: [TX_GLOBEX, other] }));
    await renderReview();
    expect(within(details()).getByText("Every candidate was assigned to another transaction.")).toBeTruthy();
    expect(button("None of These", details())).toBeTruthy();
  });

  it("shows a reimbursement", async () => {
    await renderReview();
    select("ACME TRAVEL");
    expect(within(details()).getByRole("heading", { name: "ACME TRAVEL" })).toBeTruthy();
    expect(within(details()).getByText("Reimbursement")).toBeTruthy();
    expect(receiptTitles()).toEqual(["ACME TRAVEL"]);
    expect(within(details()).queryByRole("button", { name: "Remove Match" })).toBeNull();
  });

  it("stays in place, with no button to hide it", async () => {
    await renderReview();
    expect(details()).toBeTruthy();
  });

  it("marks a decision as manual in the list and the header", async () => {
    await renderReview();
    expect(within(details()).getByText("2 receipts match amount")).toBeTruthy();
    fireEvent.click(button("Assign GLOBEX", receiptItem("GLOBEX")));
    select("GLOBEX SHOP");
    expect(within(details()).getByText("Manual decision")).toBeTruthy();
    const row = within(list()).getByText("GLOBEX SHOP").closest<HTMLElement>("[role=option]")!;
    expect(row.querySelector(".list-row__edited .symbol--pencil")).toBeTruthy();
    expect(within(list()).getByText("ACME CORP").closest<HTMLElement>("[role=option]")!.querySelector(".symbol--pencil")).toBeNull();
  });

  it("says when a receipt couldn't be read and reads it again from the row", async () => {
    const blank = makeReceipt("scan-01.pdf", { vendor: null, amount_cents: null, confidence: null, provider_used: "error" });
    vi.mocked(getReview).mockResolvedValue(makeReviewData({ transactions: [TX_INITECH], unmatched_receipts: [blank] }));
    vi.mocked(rescanReceipt).mockResolvedValue({ ...stripped(blank), vendor: "SAMPLE CAFE", amount_cents: 3000, confidence: "high" });
    await renderReview();
    const item = receiptItem("scan-01.pdf");
    expect(within(item).getByText("Couldn't read this receipt")).toBeTruthy();
    fireEvent.click(button("Read scan-01.pdf Again", item));
    expect(rescanReceipt).toHaveBeenCalledWith("2030", "03", "2030/03/receipts/scan-01.pdf");
    await settle();
    expect(within(receiptItem("SAMPLE CAFE")).queryByText("Couldn't read this receipt")).toBeNull();
  });
});

describe("decisions", () => {
  it("accepts a candidate, freeing the other one", async () => {
    await renderReview();
    fireEvent.click(button("Assign GLOBEX", receiptItem("GLOBEX")));
    expect(options()[1]).toBe("* Matched2 MarGLOBEX SHOPEdited-€20.00");
    expect(receiptTitles()).toEqual(["GLOBEX"]);
    expect(counts()).toEqual({ "To Decide": "1", Matched: "3", All: "4" });
    select("INITECH SERVICES");
    expect(receiptTitles()).toEqual(["INITECH", "HOOLI"]);
  });

  it("moves focus to the details column's first decision with Return, and commits the focused candidate with the Accept command", async () => {
    const { commands } = await renderReview();
    list().focus();
    key("Enter");
    expect(document.activeElement).toBe(button("Assign GLOBEX", receiptItem("GLOBEX")));
    expect(receiptTitles()).toEqual(["GLOBEX", "HOOLI"]);
    fireEvent.click(within(receiptItem("HOOLI")).getByRole("button", { pressed: false }));
    act(() => commands().accept());
    expect(receiptTitles()).toEqual(["HOOLI"]);
  });

  it("returns focus to the list after a decision in the details column", async () => {
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
    fireEvent.click(button("None of These", details()));
    expect(options()[1]).toBe("* Unmatched2 MarGLOBEX SHOPEdited-€20.00");
    expect(receiptTitles()).toEqual(["GLOBEX", "HOOLI", "INITECH"]);
  });

  it("assigns a pool receipt", async () => {
    await renderReview();
    select("INITECH SERVICES");
    fireEvent.click(button("Assign INITECH", receiptItem("INITECH")));
    expect(within(details()).getByText("Manual decision")).toBeTruthy();
    await advance(500);
    expect(vi.mocked(saveDraft).mock.calls[0][2]).toEqual({
      "tx-3": { status: "MATCHED", receipt_meta: [stripped(INITECH)], receipt_files: [INITECH.file], notes: "manual_match" },
    });
  });

  it("marks a transaction as needing no receipt", async () => {
    await renderReview();
    select("INITECH SERVICES");
    pick("No Receipt Needed", "Refund", details());
    expect(within(details()).getByText("No receipt needed: Refund")).toBeTruthy();
    await advance(500);
    expect(vi.mocked(saveDraft).mock.calls[0][2]).toEqual({ "tx-3": { status: "MATCHED", receipt_meta: [], receipt_files: [], notes: "refund" } });
  });

  it("disputes a match, freeing its receipt", async () => {
    await renderReview();
    select("ACME CORP");
    fireEvent.click(button("Remove Match", details()));
    expect(options()[0]).toBe("* Unmatched1 MarACME CORPEdited-€10.00");
    select("INITECH SERVICES");
    expect(receiptTitles()).toEqual(["INITECH", "ACME"]);
  });

  it("hands the selection to the next row when the decided one leaves the filter", async () => {
    await renderReview();
    fireEvent.click(button("None of These", details()));
    fireEvent.click(filterButton("To Decide"));
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
    expect(within(details()).getByText("No receipt needed: Refund")).toBeTruthy();
  });

  it("names Reject by the row's status and assigns its focused receipt", async () => {
    await renderReview();
    fireEvent.contextMenu(within(list()).getByText("GLOBEX SHOP"));
    expect(screen.getByRole("menuitem", { name: "None of These" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Assign Receipt" }));
    expect(options()[1]).toBe("* Matched2 MarGLOBEX SHOPEdited-€20.00");
  });

  it("names Reject Needs a Receipt for a transaction marked as needing none", async () => {
    await renderReview();
    fireEvent.contextMenu(within(list()).getByText("HOOLI PAYROLL"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Needs a Receipt" }));
    expect(options()[3]).toBe("* Unmatched4 MarHOOLI PAYROLLEdited+€5,000.00");
  });

  it("adds a match rule from a decision the user made", async () => {
    vi.mocked(getRules).mockResolvedValue([{ id: "rule-1", receiptVendor: "ACME", transactionDescription: "ACME CORP" }]);
    vi.mocked(saveRules).mockImplementation(async (rules) => rules);
    await renderReview();
    fireEvent.contextMenu(within(list()).getByText("ACME CORP"));
    expect(screen.queryByRole("menuitem", { name: /^Always Match/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    select("GLOBEX SHOP");
    fireEvent.click(button("Assign GLOBEX", receiptItem("GLOBEX")));
    fireEvent.contextMenu(within(list()).getByText("GLOBEX SHOP"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Always Match “GLOBEX” to “GLOBEX SHOP”" }));
    await settle();
    expect(saveRules).toHaveBeenCalledWith([
      { id: "rule-1", receiptVendor: "ACME", transactionDescription: "ACME CORP" },
      { id: expect.any(String), receiptVendor: "GLOBEX", transactionDescription: "GLOBEX SHOP" },
    ]);
    const banner = screen.getByText("Rule added. It applies the next time Concilia matches receipts.").closest<HTMLElement>(".banner")!;
    fireEvent.click(button("Dismiss", banner));
    expect(screen.queryByText(/Rule added/)).toBeNull();
  });

  it("does not add a rule that exists", async () => {
    vi.mocked(getRules).mockResolvedValue([{ id: "rule-1", receiptVendor: "globex", transactionDescription: "globex shop" }]);
    await renderReview();
    fireEvent.click(button("Assign GLOBEX", receiptItem("GLOBEX")));
    fireEvent.contextMenu(within(list()).getByText("GLOBEX SHOP"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Always Match “GLOBEX” to “GLOBEX SHOP”" }));
    await settle();
    expect(saveRules).not.toHaveBeenCalled();
    expect(screen.getByText("That rule already exists.")).toBeTruthy();
  });

  it("offers a reimbursement Read Again and the previews", async () => {
    vi.mocked(rescanReimbursement).mockResolvedValue(stripped(TRAVEL));
    await renderReview();
    fireEvent.contextMenu(within(list()).getByText("ACME TRAVEL"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Read Receipt Again" }));
    expect(rescanReimbursement).toHaveBeenCalledWith("2030", "03", "2030/03/receipts/acme-travel.pdf");
  });
});

describe("details width", () => {
  it("resizes from its divider within 280 to 420 pixels and remembers the width", async () => {
    await renderReview();
    const divider = screen.getByRole("separator", { name: "Resize Details" });
    const width = () => screen.getByRole("region", { name: /^Review / }).style.getPropertyValue("--details-width");
    expect(divider.getAttribute("aria-valuenow")).toBe("300");
    expect(width()).toBe("300px");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(width()).toBe("310px");
    fireEvent.keyDown(divider, { key: "End" });
    expect(divider.getAttribute("aria-valuenow")).toBe("420");
    fireEvent.keyDown(divider, { key: "ArrowLeft" });
    expect(divider.getAttribute("aria-valuenow")).toBe("420");
    expect(localStorage.getItem("review.detailsWidth")).toBe("420");
    fireEvent.keyDown(divider, { key: "Home" });
    expect(width()).toBe("280px");
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
    expect(options()[1]).toBe("* Matched2 MarGLOBEX SHOPEdited-€20.00");
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
      scan: true,
      exportReport: true,
      finalize: true,
      addStatements: true,
    });
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(commands().can);
    select("ACME CORP");
    expect(commands().can).toMatchObject({ accept: false, reject: true, noReceipt: false, previousPending: false, nextPending: true });
    expect(onAvailabilityChange).toHaveBeenLastCalledWith(expect.objectContaining({ accept: false }));
  });

  it("reports what Reject does for the selection", async () => {
    const onRejectKindChange = vi.fn<(kind: RejectKind) => void>();
    await renderReview({ onRejectKindChange });
    select("GLOBEX SHOP");
    expect(onRejectKindChange).toHaveBeenLastCalledWith("noneOfThese");
    select("ACME CORP");
    expect(onRejectKindChange).toHaveBeenLastCalledWith("removeMatch");
    select("HOOLI PAYROLL");
    expect(onRejectKindChange).toHaveBeenLastCalledWith("needsReceipt");
  });

  it("runs decisions on the selection", async () => {
    const { commands } = await renderReview();
    act(() => commands().noReceipt("bank_fee"));
    expect(options()[1]).toBe("* No Receipt · Bank Fee2 MarGLOBEX SHOPEdited-€20.00");
    act(() => commands().reject());
    expect(options()[1]).toBe("* Unmatched2 MarGLOBEX SHOPEdited-€20.00");
    act(() => commands().accept());
    expect(options()[1]).toBe("* Matched2 MarGLOBEX SHOPEdited-€20.00");
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

  it("filters, moves and focuses the search field", async () => {
    const { commands } = await renderReview();
    act(() => commands().nextPending());
    expect(selected()).toBe("INITECH SERVICES");
    act(() => commands().previousPending());
    expect(selected()).toBe("GLOBEX SHOP");
    act(() => commands().setFilter("matched"));
    expect(filterButton("Matched").getAttribute("aria-checked")).toBe("true");
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
    fireEvent.click(button("Quick Look", details()));
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
    const { onSaved, onChanged } = await renderReview();
    expect(subtitle()).toBe("In review · 2 to decide");
    decideFirst();
    await advance(500);
    expect(subtitle()).toBe("In review · 1 to decide · Saving…");
    await act(async () => save.resolve());
    expect(subtitle()).toBe("In review · 1 to decide · Saved");
    expect(onSaved).toHaveBeenCalledExactlyOnceWith(PERIOD);
    expect(onChanged).not.toHaveBeenCalled();
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
    expect(button("Finalize…", toolbar()).classList.contains("default")).toBe(false);
  });

  it("makes Finalize… the default button once nothing is left to decide", async () => {
    vi.mocked(getReview).mockResolvedValue(makeReviewData({ transactions: [TX_ACME] }));
    await renderReview();
    expect(button("Finalize…", toolbar()).classList.contains("default")).toBe(true);
  });

  it("offers Open Report in place of Finalize and disables Scan for a finalized month", async () => {
    vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus({ applied: true }));
    vi.mocked(openReportFile).mockResolvedValue(undefined);
    const { commands } = await renderReview();
    expect(subtitle()).toBe("Finalized");
    expect(within(toolbar()).queryByRole("button", { name: "Finalize…" })).toBeNull();
    fireEvent.click(button("Open Report", toolbar()));
    expect(openReportFile).toHaveBeenCalledWith("2030", "03");
    expect(button("Scan for New Receipts", toolbar()).disabled).toBe(true);
    expect(button("Export Report…", toolbar()).disabled).toBe(false);
    expect(commands().can).toMatchObject({ scan: false, finalize: false, exportReport: true });
  });

  it("shows a finalized month read-only", async () => {
    vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus({ applied: true }));
    const { commands } = await renderReview();
    expect(within(details()).getByText("This month is finalized. Reconcile it again to change decisions.")).toBeTruthy();
    expect(within(details()).queryByRole("button", { name: /^Assign / })).toBeNull();
    expect(within(details()).queryByRole("button", { name: "None of These" })).toBeNull();
    expect(within(details()).queryByRole("button", { name: "No Receipt Needed" })).toBeNull();
    expect(commands().can).toMatchObject({ accept: false, reject: false, noReceipt: false, rescan: false, quickLook: true, openInPreview: true });
    fireEvent.click(button("Actions for GLOBEX", receiptItem("GLOBEX")));
    expect((screen.getByRole("menuitem", { name: "Read Again" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("add statements", () => {
  const STATEMENTS = [{ file: "extrato-a.pdf", bank: "cgd" as const, transactions: 6, added_at: "2030-04-01T09:00:00Z" }];
  const NEW_PATH = "/Users/example/Downloads/extrato-b.pdf";

  beforeEach(() => {
    vi.mocked(getReview).mockResolvedValue({ ...DATA, statements: STATEMENTS });
  });

  /** Opens the sheet from the toolbar's More Actions menu with the file the picker returns. */
  async function openSheet(): Promise<HTMLElement> {
    vi.mocked(pickStatements).mockResolvedValue([NEW_PATH]);
    fireEvent.click(button("More Actions", toolbar()));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "Add Statements…" }));
    await settle();
    return screen.getByRole("dialog", { name: "Add Statements to March 2030" });
  }

  it("lists the month's statements and the files to add", async () => {
    await renderReview();
    const sheet = await openSheet();
    const existing = within(sheet).getByRole("list", { name: "Already in This Month" });
    expect(existing.textContent).toBe("extrato-a.pdfCGD6 transactions");
    const fresh = within(sheet).getByRole("list", { name: "To Add" });
    expect(fresh.textContent).toContain("extrato-b.pdf");
    fireEvent.click(button("Remove extrato-b.pdf", sheet));
    expect(within(sheet).queryByRole("list", { name: "To Add" })).toBeNull();
    expect(button("Add", sheet).disabled).toBe(true);
    fireEvent.click(button("Cancel", sheet));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("adds with progress, then sums up and reloads", async () => {
    const run = addRun();
    const { onChanged } = await renderReview();
    const sheet = await openSheet();
    fireEvent.click(button("Add", sheet));
    await settle();
    expect(startAddStatements).toHaveBeenCalledWith("2030", "03", [{ path: NEW_PATH, bank: "cgd" }], expect.any(Function));
    const dialog = screen.getByRole("dialog", { name: "Adding Statements" });
    await run.push({ step: "parsing", count: 1 });
    expect(within(dialog).getByText("Reading statements")).toBeTruthy();
    expect(within(dialog).queryByText("Generating report")).toBeNull();
    run.result.resolve(ADDED);
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("3 transactions added · 1 duplicate skipped · 2 matched")).toBeTruthy();
    expect(getReview).toHaveBeenCalledTimes(2);
    expect(onChanged).toHaveBeenCalled();
  });

  it("goes back to the chosen files when adding is stopped", async () => {
    const run = addRun();
    await renderReview();
    const sheet = await openSheet();
    fireEvent.click(button("Add", sheet));
    await settle();
    fireEvent.click(button("Cancel", screen.getByRole("dialog")));
    expect(run.cancel).toHaveBeenCalledTimes(1);
    await act(async () => run.result.reject({ kind: "cancelled", message: "cancelled" }));
    await settle();
    const back = screen.getByRole("dialog", { name: "Add Statements to March 2030" });
    expect(within(back).getByRole("list", { name: "To Add" }).textContent).toContain("extrato-b.pdf");
  });

  it("explains a failure and adds the same files again on Try Again", async () => {
    const run = addRun();
    await renderReview();
    const sheet = await openSheet();
    fireEvent.click(button("Add", sheet));
    await settle();
    run.result.reject({ kind: "parse", message: "no rows" });
    await settle();
    const dialog = screen.getByRole("dialog", { name: "Adding Statements" });
    expect(within(dialog).getByRole("alert").textContent).toContain("Details: no rows");
    fireEvent.click(button("Try Again", dialog));
    await settle();
    expect(startAddStatements).toHaveBeenCalledTimes(2);
    expect(vi.mocked(startAddStatements).mock.calls[1][2]).toEqual([{ path: NEW_PATH, bank: "cgd" }]);
  });

  it("opens the sheet with dropped PDFs and notes other files", async () => {
    await renderReview();
    dragOver();
    expect(screen.getByText("Drop to add statements to March 2030")).toBeTruthy();
    dropFiles([NEW_PATH, "/Users/example/Downloads/notes.txt"]);
    const sheet = screen.getByRole("dialog", { name: "Add Statements to March 2030" });
    expect(within(sheet).getByRole("list", { name: "To Add" }).textContent).toContain("extrato-b.pdf");
    expect(within(sheet).getByText("notes.txt isn't a PDF. Only PDF statements can be added.")).toBeTruthy();
    dropFiles([NEW_PATH, "/Users/example/Downloads/extrato-c.pdf"]);
    expect(within(sheet).getAllByRole("listitem").map((item) => item.textContent)).toContain("extrato-c.pdfCGD");
    expect(within(within(sheet).getByRole("list", { name: "To Add" })).getAllByRole("listitem")).toHaveLength(2);
  });

  it("is not offered for a finalized month", async () => {
    vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus({ applied: true }));
    const { commands } = await renderReview();
    expect(commands().can.addStatements).toBe(false);
    fireEvent.click(button("More Actions", toolbar()));
    expect(within(screen.getByRole("menu")).queryByRole("menuitem", { name: "Add Statements…" })).toBeNull();
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
    run.result.resolve({ summary: SUMMARY, dropped_decisions: [], new_receipts: 0, newly_matched: 0 });
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
      new_receipts: 0,
      newly_matched: 0,
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
    run.result.resolve({
      summary: SUMMARY,
      new_receipts: 0,
      newly_matched: 0,
      dropped_decisions: [{ txId: "tx-2", description: "GLOBEX SHOP", removedReceiptFiles: [GLOBEX.file] }],
    });
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

  it("offers Settings and Try Again after a scan that Google refused", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts", toolbar()));
    await settle();
    run.result.reject({ kind: "unauthorized", message: "token exchange failed (400)" });
    await settle();
    const dialog = screen.getByRole("dialog", { name: "Scan for New Receipts" });
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Close", "Open Settings…", "Try Again"]);
    fireEvent.click(button("Open Settings…", dialog));
    expect(openSettings).toHaveBeenCalledTimes(1);
    scanRun();
    fireEvent.click(button("Try Again", dialog));
    await settle();
    expect(startScan).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("offers only Try Again for a failure Settings cannot fix", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts", toolbar()));
    await settle();
    run.result.reject({ kind: "network", message: "offline" });
    await settle();
    const dialog = screen.getByRole("dialog", { name: "Scan for New Receipts" });
    expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(["Close", "Try Again"]);
  });

  it("sums up what a scan found in a dismissible banner", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts", toolbar()));
    await settle();
    run.result.resolve({ summary: SUMMARY, dropped_decisions: [], new_receipts: 3, newly_matched: 1 });
    await settle();
    const banner = screen.getByText("3 new receipts · 1 matched").closest<HTMLElement>(".banner")!;
    fireEvent.click(button("Dismiss", banner));
    expect(screen.queryByText("3 new receipts · 1 matched")).toBeNull();
  });

  it("says when a scan found nothing new", async () => {
    const run = scanRun();
    await renderReview();
    fireEvent.click(button("Scan for New Receipts", toolbar()));
    await settle();
    run.result.resolve({ summary: SUMMARY, dropped_decisions: [], new_receipts: 0, newly_matched: 0 });
    await settle();
    expect(screen.getByText("No new receipts")).toBeTruthy();
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
    expect(sheet.textContent).toContain("4 receipts will be sorted: 1 matched, 2 still to review, and 1 unmatched.");
    expect(sheet.textContent).toContain("To change decisions later, use Reconcile Again.");
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
    expect(sheet.textContent).toContain("1 receipt will be sorted: 1 matched.");
    expect(sheet.textContent).not.toContain("still need");
    expect(within(sheet).queryByRole("button", { name: "Review Remaining" })).toBeNull();
  });

  it("goes to the first transaction still to decide from Review Remaining", async () => {
    await renderReview();
    select("ACME CORP");
    search("corp");
    fireEvent.click(button("Finalize…", toolbar()));
    fireEvent.click(button("Review Remaining", screen.getByRole("alertdialog")));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(filterButton("To Decide").getAttribute("aria-checked")).toBe("true");
    expect((screen.getByRole("searchbox", { name: "Search" }) as HTMLInputElement).value).toBe("");
    expect(selected()).toBe("GLOBEX SHOP");
    expect(document.activeElement).toBe(list());
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
    expect(screen.getAllByRole("status")).toHaveLength(1);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("March 2030 is finalized. The receipts are sorted and the report is ready.");
    vi.mocked(openReportFile).mockResolvedValue(undefined);
    vi.mocked(revealPeriod).mockResolvedValue(undefined);
    fireEvent.click(button("Open Report", banner));
    expect(openReportFile).toHaveBeenCalledWith("2030", "03");
    fireEvent.click(button("Show in Finder", banner));
    expect(revealPeriod).toHaveBeenCalledWith("2030", "03");
    fireEvent.click(button("Dismiss", banner));
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
