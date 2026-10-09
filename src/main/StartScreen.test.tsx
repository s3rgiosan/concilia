// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { useFileDrop } from "../lib/hooks/useFileDrop";
import type { Period } from "../lib/period";
import { periodStatus, pickStatements, type PeriodStatus } from "../lib/tauri";
import { deferred } from "../test/fixtures";
import { StartScreen, type Statement } from "./StartScreen";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  periodStatus: vi.fn(),
  pickStatements: vi.fn(),
}));

vi.mock("../lib/hooks/useFileDrop", () => ({ useFileDrop: vi.fn() }));

const MARCH: Period = { year: "2030", month: "03" };
const STATEMENT_PATH = "/Users/example/Downloads/extrato-2030-03.pdf";
const NONE: PeriodStatus = { exists: false, applied: false, has_transactions: false, has_draft: false };
const UNFINISHED: PeriodStatus = { exists: true, applied: false, has_transactions: true, has_draft: true };
const APPLIED: PeriodStatus = { exists: true, applied: true, has_transactions: true, has_draft: false };

let drop: (paths: string[]) => void;
let dragging: boolean;
let uuid: number;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2030, 3, 15));
  uuid = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation(() => {
    uuid += 1;
    return `00000000-0000-4000-8000-${String(uuid).padStart(12, "0")}`;
  });
  dragging = false;
  vi.mocked(useFileDrop).mockImplementation((onDrop) => {
    drop = onDrop;
    return dragging;
  });
  vi.mocked(periodStatus).mockResolvedValue(NONE);
  vi.mocked(pickStatements).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

interface Callbacks {
  onPeriod: Mock<(period: Period) => void>;
  onStatements: Mock<(statements: Statement[]) => void>;
  onReconcile: Mock<(clearCache: boolean) => void>;
  onResume: Mock<() => void>;
  onScan: Mock<() => void>;
  onError: Mock<(e: unknown) => void>;
}

/** Holds the period and statements the way the main window does, and spies on each callback. */
function Harness({ initial, callbacks }: { initial: Statement[]; callbacks: Callbacks }) {
  const [period, setPeriod] = useState<Period>(MARCH);
  const [statements, setStatements] = useState<Statement[]>(initial);
  return (
    <StartScreen
      period={period}
      onPeriod={(next) => {
        callbacks.onPeriod(next);
        setPeriod(next);
      }}
      statements={statements}
      onStatements={(next) => {
        callbacks.onStatements(next);
        setStatements(next);
      }}
      onReconcile={callbacks.onReconcile}
      onResume={callbacks.onResume}
      onScan={callbacks.onScan}
      onError={callbacks.onError}
    />
  );
}

async function renderStart(initial: Statement[] = []) {
  const callbacks: Callbacks = {
    onPeriod: vi.fn(),
    onStatements: vi.fn(),
    onReconcile: vi.fn(),
    onResume: vi.fn(),
    onScan: vi.fn(),
    onError: vi.fn(),
  };
  const result = render(<Harness initial={initial} callbacks={callbacks} />);
  await act(async () => undefined);
  return { ...result, ...callbacks };
}

function statement(patch: Partial<Statement> = {}): Statement {
  return { id: "statement-1", path: STATEMENT_PATH, bank: "cgd", ...patch };
}

function names(): string[] {
  return screen.queryAllByRole("listitem").map((li) => li.querySelector(".statements__name")?.textContent ?? "");
}

function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

describe("period", () => {
  it("shows the period and the years on offer", async () => {
    await renderStart();
    expect(screen.getByRole("heading", { name: "Reconcile a month" })).toBeTruthy();
    expect((screen.getByLabelText("Month") as HTMLSelectElement).value).toBe("03");
    const year = screen.getByLabelText("Year") as HTMLSelectElement;
    expect(year.value).toBe("2030");
    expect(within(year).getAllByRole("option").map((o) => o.textContent)).toEqual(["2030", "2029", "2028"]);
  });

  it("changes the month and the year", async () => {
    const { onPeriod } = await renderStart();
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "02" } });
    expect(onPeriod).toHaveBeenLastCalledWith({ year: "2030", month: "02" });
    fireEvent.change(screen.getByLabelText("Year"), { target: { value: "2029" } });
    expect(onPeriod).toHaveBeenLastCalledWith({ year: "2029", month: "02" });
  });

  it("loads the status of each period", async () => {
    await renderStart();
    expect(periodStatus).toHaveBeenCalledWith("2030", "03");
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "02" } });
    await act(async () => undefined);
    expect(periodStatus).toHaveBeenLastCalledWith("2030", "02");
  });

  it("ignores the status of a period no longer shown", async () => {
    const march = deferred<PeriodStatus>();
    const february = deferred<PeriodStatus>();
    vi.mocked(periodStatus).mockReturnValueOnce(march.promise).mockReturnValueOnce(february.promise);
    await renderStart();
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "02" } });
    await act(async () => february.resolve(APPLIED));
    await act(async () => march.resolve(UNFINISHED));
    expect(screen.getByRole("status").textContent).toContain("This month is finalized.");
  });

  it("clears the previous period's status while the next one loads", async () => {
    const february = deferred<PeriodStatus>();
    vi.mocked(periodStatus).mockResolvedValueOnce(UNFINISHED).mockReturnValueOnce(february.promise);
    await renderStart();
    expect(screen.getByRole("status")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "02" } });
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports a status that cannot be loaded", async () => {
    const failure = { kind: "io", message: "unreadable" };
    vi.mocked(periodStatus).mockRejectedValue(failure);
    const { onError } = await renderStart();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("ignores an error for a period no longer shown", async () => {
    const march = deferred<PeriodStatus>();
    vi.mocked(periodStatus).mockReturnValueOnce(march.promise).mockResolvedValueOnce(NONE);
    const { onError } = await renderStart();
    fireEvent.change(screen.getByLabelText("Month"), { target: { value: "02" } });
    await act(async () => march.reject(new Error("late")));
    expect(onError).not.toHaveBeenCalled();
  });
});

describe("resume banner", () => {
  it("is hidden for a month never reconciled", async () => {
    await renderStart();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Resume Review" })).toBeNull();
  });

  it("offers to resume, scan or re-run an unfinished month", async () => {
    vi.mocked(periodStatus).mockResolvedValue(UNFINISHED);
    const { onResume, onScan, onReconcile } = await renderStart();
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("This month has a reconciliation in progress.");
    expect(banner.textContent).toContain("Re-running moves sorted receipts back into the receipts folder");

    fireEvent.click(button("Resume Review"));
    expect(onResume).toHaveBeenCalledTimes(1);
    fireEvent.click(button("Scan for New Receipts"));
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(button("Re-run").disabled).toBe(false);
    fireEvent.click(button("Re-run"));
    expect(onReconcile).toHaveBeenCalledWith(true);
  });

  it("offers no scan for a finalized month", async () => {
    vi.mocked(periodStatus).mockResolvedValue(APPLIED);
    await renderStart();
    expect(screen.getByRole("status").textContent).toContain("This month is finalized.");
    expect(screen.queryByRole("button", { name: "Scan for New Receipts" })).toBeNull();
    expect(screen.getByRole("button", { name: "Resume Review" })).toBeTruthy();
  });

  it("allows a re-run only with saved transactions or a statement", async () => {
    vi.mocked(periodStatus).mockResolvedValue({ ...UNFINISHED, has_transactions: false });
    await renderStart();
    expect(button("Re-run").disabled).toBe(true);
    cleanup();

    await renderStart([statement()]);
    expect(button("Re-run").disabled).toBe(false);
  });
});

describe("statements", () => {
  it("starts empty with Reconcile disabled", async () => {
    const { onReconcile } = await renderStart();
    expect(screen.getByText("Drop statement PDFs here")).toBeTruthy();
    expect(button("Reconcile").disabled).toBe(true);
    fireEvent.click(button("Reconcile"));
    expect(onReconcile).not.toHaveBeenCalled();
  });

  it("adds picked PDFs as CGD statements", async () => {
    vi.mocked(pickStatements).mockResolvedValue([STATEMENT_PATH, "/Users/example/Downloads/EXTRATO-2030-02.PDF"]);
    const { onStatements } = await renderStart();
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(pickStatements).toHaveBeenCalledTimes(1);
    expect(onStatements).toHaveBeenCalledWith([
      { id: "00000000-0000-4000-8000-000000000001", path: STATEMENT_PATH, bank: "cgd" },
      { id: "00000000-0000-4000-8000-000000000002", path: "/Users/example/Downloads/EXTRATO-2030-02.PDF", bank: "cgd" },
    ]);
    expect(names()).toEqual(["extrato-2030-03.pdf", "EXTRATO-2030-02.PDF"]);
    expect(screen.getAllByLabelText("Bank").map((s) => (s as HTMLSelectElement).value)).toEqual(["cgd", "cgd"]);
    expect(screen.queryByText("Drop statement PDFs here")).toBeNull();
    expect(screen.queryByText("Only PDF files can be added.")).toBeNull();
  });

  it("adds nothing when the picker is cancelled", async () => {
    const { onStatements } = await renderStart();
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(onStatements).not.toHaveBeenCalled();
  });

  it("ignores a statement already added", async () => {
    vi.mocked(pickStatements).mockResolvedValue([STATEMENT_PATH]);
    const { onStatements } = await renderStart([statement()]);
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(onStatements).not.toHaveBeenCalled();
    expect(names()).toEqual(["extrato-2030-03.pdf"]);
  });

  it("rejects files that are not PDFs and keeps the PDFs", async () => {
    vi.mocked(pickStatements).mockResolvedValue(["/Users/example/Downloads/notes.txt", STATEMENT_PATH]);
    await renderStart();
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(screen.getByText("Only PDF files can be added.")).toBeTruthy();
    expect(names()).toEqual(["extrato-2030-03.pdf"]);

    vi.mocked(pickStatements).mockResolvedValue(["/Users/example/Downloads/extrato-2030-02.pdf"]);
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(screen.queryByText("Only PDF files can be added.")).toBeNull();
  });

  it("reports a picker failure", async () => {
    const failure = { kind: "internal", message: "no dialog" };
    vi.mocked(pickStatements).mockRejectedValue(failure);
    const { onError } = await renderStart();
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("adds dropped files", async () => {
    await renderStart();
    act(() => drop([STATEMENT_PATH, "/Users/example/Downloads/photo.png"]));
    expect(names()).toEqual(["extrato-2030-03.pdf"]);
    expect(screen.getByText("Only PDF files can be added.")).toBeTruthy();
  });

  it("highlights the drop zone while a drag is over it", async () => {
    dragging = true;
    const { container } = await renderStart();
    expect(container.querySelector(".dropzone")?.classList.contains("dropzone--over")).toBe(true);
  });

  it("shows the file name with its full path as a tooltip", async () => {
    await renderStart([statement({ path: "C:\\Users\\example\\extrato.pdf" })]);
    const name = screen.getByText("extrato.pdf");
    expect(name.getAttribute("title")).toBe("C:\\Users\\example\\extrato.pdf");
  });

  it("removes a statement", async () => {
    const other = statement({ id: "statement-2", path: "/Users/example/Downloads/extrato-2030-02.pdf" });
    const { onStatements } = await renderStart([statement(), other]);
    fireEvent.click(button("Remove extrato-2030-03.pdf"));
    expect(onStatements).toHaveBeenCalledWith([other]);
    expect(names()).toEqual(["extrato-2030-02.pdf"]);
  });

  it("changes a statement's bank", async () => {
    const other = statement({ id: "statement-2", path: "/Users/example/Downloads/extrato-2030-02.pdf", bank: "other" });
    const { onStatements } = await renderStart([statement(), other]);
    const banks = screen.getAllByLabelText("Bank");
    fireEvent.change(banks[1], { target: { value: "cgd" } });
    expect(onStatements).toHaveBeenCalledWith([statement(), { ...other, bank: "cgd" }]);
  });

  it("reconciles the statements without clearing the cache", async () => {
    const { onReconcile } = await renderStart([statement()]);
    expect(button("Reconcile").disabled).toBe(false);
    fireEvent.click(button("Reconcile"));
    expect(onReconcile).toHaveBeenCalledWith(false);
  });
});
