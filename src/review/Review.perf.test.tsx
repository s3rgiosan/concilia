// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Profiler, memo, useState, type ComponentType } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { getDraft, getReview, periodStatus, receiptUrl, saveDraft, startScan, type RunEvent, type ScanResult } from "../lib/tauri";
import { deferred, makePeriodStatus, makeReceipt, makeReviewData, makeTransaction } from "../test/fixtures";
import { Review } from "./Review";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  getDraft: vi.fn(),
  getReview: vi.fn(),
  periodStatus: vi.fn(),
  receiptUrl: vi.fn(),
  requestAttention: vi.fn(() => Promise.resolve()),
  saveDraft: vi.fn(),
  setDockProgress: vi.fn(() => Promise.resolve()),
  startScan: vi.fn(),
}));

vi.mock("@tauri-apps/api/webview", () => ({ getCurrentWebview: vi.fn() }));

const renders = vi.hoisted(() => ({ rows: 0, list: 0, details: 0 }));

// Each row render the memo lets through counts once; the list counts whenever the review renders it.
vi.mock("./TransactionRow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./TransactionRow")>();
  const Row = actual.TransactionRow as ComponentType<Parameters<typeof actual.TransactionRow>[0]>;
  const Counted = memo(function Counted(props: Parameters<typeof actual.TransactionRow>[0]) {
    renders.rows += 1;
    return <Row {...props} />;
  });
  return { ...actual, TransactionRow: Counted };
});

vi.mock("./TransactionList", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./TransactionList")>();
  return {
    ...actual,
    TransactionList: (props: Parameters<typeof actual.TransactionList>[0]) => {
      renders.list += 1;
      return actual.TransactionList(props);
    },
  };
});

vi.mock("./Details", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Details")>();
  const Inner = actual.Details as ComponentType<Parameters<typeof actual.Details>[0]>;
  const Counted = memo(function Counted(props: Parameters<typeof actual.Details>[0]) {
    renders.details += 1;
    return <Inner {...props} />;
  });
  return { ...actual, Details: Counted };
});

const PERIOD = { year: "2030", month: "03" };

function transactions(count: number) {
  return Array.from({ length: count }, (_, i) =>
    makeTransaction(`tx-${String(i).padStart(3, "0")}`, {
      description: `ACME CORP ${i}`,
      date: `2030-03-${String((i % 28) + 1).padStart(2, "0")}`,
      amount_cents: -(1000 + i),
      status: i % 3 === 0 ? "REVIEW" : i % 3 === 1 ? "MATCHED" : "UNMATCHED",
    }),
  );
}

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function frames(ms = 20) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** The review inside a toolbar with the slots the main window gives it. */
function Window({ onRender, onAvailabilityChange }: { onRender: () => void; onAvailabilityChange: () => void }) {
  const [subtitle, setSubtitle] = useState<HTMLElement | null>(null);
  const [trailing, setTrailing] = useState<HTMLElement | null>(null);
  return (
    <>
      <header className="titlebar">
        <span ref={setSubtitle} />
        <div ref={setTrailing} />
      </header>
      <Profiler id="review" onRender={onRender}>
        <Review
          period={PERIOD}
          toolbar={{ subtitle, trailing }}
          status=""
          moreActions={[]}
          onError={() => undefined}
          onAvailabilityChange={onAvailabilityChange}
        />
      </Profiler>
    </>
  );
}

/** Renders the review and counts its commits; the Review gets no state from its parent. */
async function renderReview(data = makeReviewData({ transactions: transactions(200) })) {
  vi.mocked(getReview).mockResolvedValue(data);
  const commits = { count: 0 };
  const onAvailabilityChange = vi.fn();
  render(<Window onRender={() => (commits.count += 1)} onAvailabilityChange={onAvailabilityChange} />);
  await settle();
  const all = screen.queryByRole("radio", { name: /^All/ });
  if (all) {
    fireEvent.click(all);
  }
  return { commits, onAvailabilityChange };
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  vi.mocked(getCurrentWebview).mockReturnValue({
    onDragDropEvent: () => Promise.resolve(() => undefined),
  } as unknown as ReturnType<typeof getCurrentWebview>);
  vi.mocked(getDraft).mockResolvedValue({});
  vi.mocked(periodStatus).mockResolvedValue(makePeriodStatus());
  vi.mocked(saveDraft).mockResolvedValue(undefined);
  vi.mocked(receiptUrl).mockImplementation((path) => `receipt://localhost/${path}`);
  renders.rows = 0;
  renders.list = 0;
  renders.details = 0;
});

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});

describe("moving the selection", () => {
  it("renders the two rows whose selection changed, in one commit, with 200 rows", async () => {
    const { commits } = await renderReview();
    const list = screen.getByRole("listbox");
    expect(list.querySelectorAll("[role=option]")).toHaveLength(200);
    renders.rows = 0;
    commits.count = 0;

    await act(async () => {
      fireEvent.keyDown(list, { key: "ArrowDown" });
    });
    expect(renders.rows).toBe(2);
    expect(commits.count).toBe(1);

    renders.rows = 0;
    commits.count = 0;
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        fireEvent.keyDown(list, { key: "ArrowDown" });
      });
    }
    expect(renders.rows).toBe(10);
    expect(commits.count).toBe(5);
  });

  it("renders only the changed row when a decision is recorded", async () => {
    const { commits } = await renderReview();
    const list = screen.getByRole("listbox");
    renders.rows = 0;
    commits.count = 0;
    const first = screen.getAllByRole("button", { name: "None of These" })[0];
    await act(async () => {
      fireEvent.click(first);
    });
    // The decided row, and the row that takes the selection.
    expect(renders.rows).toBeLessThanOrEqual(3);
    expect(list.querySelectorAll("[role=option]")).toHaveLength(200);
  });
});

describe("scan progress", () => {
  it("leaves the list and the details alone while the sheet follows the events", async () => {
    const result = deferred<ScanResult>();
    let push: (event: RunEvent) => void = () => undefined;
    vi.mocked(startScan).mockImplementation((_year, _month, onEvent) => {
      push = onEvent;
      return { promise: result.promise, cancel: vi.fn().mockResolvedValue(true) };
    });
    const { commits } = await renderReview();
    fireEvent.click(screen.getByRole("button", { name: "Scan for New Receipts" }));
    await settle();
    await frames();
    expect(screen.getByRole("dialog", { name: "Scan for New Receipts" })).toBeTruthy();

    renders.rows = 0;
    renders.list = 0;
    renders.details = 0;
    commits.count = 0;
    for (let current = 1; current <= 60; current += 1) {
      push({ step: "extracting", current, total: 60 });
      await frames(20);
    }
    expect(within(screen.getByRole("dialog")).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("60");
    expect(renders.rows).toBe(0);
    expect(renders.list).toBe(0);
    expect(renders.details).toBe(0);
  });

  it("renders once for a burst of events inside one frame", async () => {
    let push: (event: RunEvent) => void = () => undefined;
    vi.mocked(startScan).mockImplementation((_year, _month, onEvent) => {
      push = onEvent;
      return { promise: new Promise<ScanResult>(() => undefined), cancel: vi.fn().mockResolvedValue(true) };
    });
    const { commits } = await renderReview();
    fireEvent.click(screen.getByRole("button", { name: "Scan for New Receipts" }));
    await settle();
    await frames();
    commits.count = 0;
    act(() => {
      for (let current = 1; current <= 300; current += 1) {
        push({ step: "extracting", current, total: 300 });
      }
    });
    await frames();
    expect(commits.count).toBe(1);
    expect(within(screen.getByRole("dialog")).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("300");
  });
});

describe("an unmatched transaction's receipts", () => {
  const pool = Array.from({ length: 45 }, (_, i) => makeReceipt(`receipt-${String(i).padStart(2, "0")}.pdf`, { vendor: `VENDOR ${i}`, amount_cents: 1000 + i * 100 }));
  const data = () =>
    makeReviewData({
      transactions: [makeTransaction("tx-1", { description: "ACME CORP", amount_cents: -1000, status: "UNMATCHED" })],
      unmatched_receipts: pool,
    });

  const rowTitles = () => Array.from(document.querySelectorAll(".details .receipt-row__title")).map((el) => el.textContent);

  it("lists the 20 closest by amount, then all of them on Show All", async () => {
    await renderReview(data());
    expect(rowTitles()).toHaveLength(20);
    expect(rowTitles()[0]).toBe("VENDOR 0");
    expect(rowTitles()[19]).toBe("VENDOR 19");
    fireEvent.click(screen.getByRole("button", { name: "Show All 45 Receipts" }));
    expect(rowTitles()).toHaveLength(45);
    expect(screen.queryByRole("button", { name: /^Show All/ })).toBeNull();
  });

  it("names the button in Portuguese", async () => {
    await act(async () => {
      await i18n.changeLanguage("pt");
    });
    await renderReview(data());
    expect(screen.getByRole("button", { name: "Mostrar os 45 recibos" })).toBeTruthy();
  });

  it("offers no button for a short list", async () => {
    await renderReview(makeReviewData({ transactions: data().transactions, unmatched_receipts: pool.slice(0, 20) }));
    expect(rowTitles()).toHaveLength(20);
    expect(screen.queryByRole("button", { name: /^Show All/ })).toBeNull();
  });

  it("collapses again for another transaction", async () => {
    const two = makeReviewData({
      transactions: [
        makeTransaction("tx-1", { date: "2030-03-01", description: "ACME CORP", amount_cents: -1000, status: "UNMATCHED" }),
        makeTransaction("tx-2", { date: "2030-03-02", description: "GLOBEX SHOP", amount_cents: -1000, status: "UNMATCHED" }),
      ],
      unmatched_receipts: pool,
    });
    await renderReview(two);
    fireEvent.click(screen.getByRole("button", { name: "Show All 45 Receipts" }));
    expect(rowTitles()).toHaveLength(45);
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    });
    expect(rowTitles()).toHaveLength(20);
  });
});

describe("the receipt preview", () => {
  const data = () =>
    makeReviewData({
      transactions: [makeTransaction("tx-1", { description: "ACME CORP", status: "MATCHED", receipt_meta: [makeReceipt("acme.pdf", { vendor: "ACME" })] })],
    });

  it("leaves the details frame empty while Quick Look shows the file", async () => {
    await renderReview(data());
    await frames(200);
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(document.querySelector(".details iframe")).not.toBeNull();

    await act(async () => {
      fireEvent.keyDown(screen.getByRole("listbox"), { key: " " });
    });
    expect(document.querySelectorAll("iframe")).toHaveLength(1);
    expect(document.querySelector(".quicklook iframe")).not.toBeNull();
    expect(document.querySelector(".details iframe")).toBeNull();
  });

  it("holds the previous file while the arrow key repeats, then loads the one it stops on", async () => {
    const many = makeReviewData({
      transactions: ["a", "b", "c", "d"].map((name, i) =>
        makeTransaction(`tx-${i}`, { date: `2030-03-0${i + 1}`, description: `ACME ${name}`, status: "MATCHED", receipt_meta: [makeReceipt(`${name}.pdf`, { vendor: name })] }),
      ),
    });
    await renderReview(many);
    await frames(200);
    const source = () => document.querySelector(".details iframe")?.getAttribute("src") ?? "";
    expect(source()).toContain("a.pdf");
    const list = screen.getByRole("listbox");
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        fireEvent.keyDown(list, { key: "ArrowDown" });
        await vi.advanceTimersByTimeAsync(30);
      });
      expect(source()).toContain("a.pdf");
    }
    await frames(150);
    expect(source()).toContain("d.pdf");
  });
});
