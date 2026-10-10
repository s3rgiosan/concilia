// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import i18n from "../i18n";
import { useFileDrop } from "../lib/hooks/useFileDrop";
import { emptySummary, type Period } from "../lib/period";
import { pickStatements, type PeriodSummary } from "../lib/tauri";
import { BANKS, receiptsFolder, Statements, type Statement } from "./Statements";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  pickStatements: vi.fn(),
}));

vi.mock("../lib/hooks/useFileDrop", () => ({ useFileDrop: vi.fn() }));

const MARCH: Period = { year: "2030", month: "03" };
const ROOT = "/Users/example/Receipts";
const STATEMENT_PATH = "/Users/example/Downloads/extrato-2030-03.pdf";

let drop: (paths: string[]) => void;
let dragging: boolean;
let uuid: number;

beforeEach(() => {
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
  vi.mocked(pickStatements).mockResolvedValue([]);
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  await i18n.changeLanguage("en");
});

interface Callbacks {
  onStatements: Mock<(statements: Statement[]) => void>;
  onReveal: Mock<() => void>;
  onError: Mock<(e: unknown) => void>;
}

/** Holds the statements the way the main window does, and spies on each callback. */
function Harness({ initial, summary, callbacks }: { initial: Statement[]; summary: PeriodSummary; callbacks: Callbacks }) {
  const [statements, setStatements] = useState<Statement[]>(initial);
  return (
    <Statements
      period={MARCH}
      summary={summary}
      receiptsRoot={ROOT}
      statements={statements}
      onStatements={(next) => {
        callbacks.onStatements(next);
        setStatements(next);
      }}
      onReveal={callbacks.onReveal}
      onError={callbacks.onError}
    />
  );
}

async function renderStatements(initial: Statement[] = [], summary: PeriodSummary = emptySummary(MARCH)) {
  const callbacks: Callbacks = { onStatements: vi.fn(), onReveal: vi.fn(), onError: vi.fn() };
  const result = render(<Harness initial={initial} summary={summary} callbacks={callbacks} />);
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

describe("receiptsFolder", () => {
  it("is the month's receipts folder under the root", () => {
    expect(receiptsFolder(ROOT, MARCH)).toBe("/Users/example/Receipts/2030/03/receipts");
    expect(receiptsFolder(`${ROOT}/`, MARCH)).toBe("/Users/example/Receipts/2030/03/receipts");
  });
});

describe("drop zone", () => {
  it("asks for the month's statements", async () => {
    await renderStatements();
    expect(screen.getByText("Drop March's bank statements here")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("writes the month in lower case in Portuguese", async () => {
    await i18n.changeLanguage("pt");
    await renderStatements();
    expect(screen.getByText("Largue aqui os extratos bancários de março")).toBeTruthy();
  });

  it("highlights the drop zone while a drag is over it", async () => {
    dragging = true;
    const { container } = await renderStatements();
    expect(container.querySelector(".dropzone")?.classList.contains("dropzone--over")).toBe(true);
  });
});

describe("receipts hint", () => {
  it("says where an empty month's receipts go and shows the folder", async () => {
    const { onReveal } = await renderStatements();
    expect(screen.getByText("Put this month's receipts in /Users/example/Receipts/2030/03/receipts")).toBeTruthy();
    fireEvent.click(button("Show in Finder"));
    expect(onReveal).toHaveBeenCalledTimes(1);
  });

  it("is hidden once the month has receipts", async () => {
    await renderStatements([], { ...emptySummary(MARCH), status: "ready", receipts: 4 });
    expect(screen.queryByText(/Put this month's receipts/)).toBeNull();
  });
});

describe("statements", () => {
  it("adds picked PDFs as CGD statements", async () => {
    vi.mocked(pickStatements).mockResolvedValue([STATEMENT_PATH, "/Users/example/Downloads/EXTRATO-2030-02.PDF"]);
    const { onStatements } = await renderStatements();
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(pickStatements).toHaveBeenCalledTimes(1);
    expect(onStatements).toHaveBeenCalledWith([
      { id: "00000000-0000-4000-8000-000000000001", path: STATEMENT_PATH, bank: "cgd" },
      { id: "00000000-0000-4000-8000-000000000002", path: "/Users/example/Downloads/EXTRATO-2030-02.PDF", bank: "cgd" },
    ]);
    expect(names()).toEqual(["extrato-2030-03.pdf", "EXTRATO-2030-02.PDF"]);
    expect(screen.queryByText(/isn't a PDF/)).toBeNull();
  });

  it("offers no bank choice while only one bank exists", async () => {
    await renderStatements([statement()]);
    expect(screen.queryByLabelText(/^Bank for/)).toBeNull();
  });

  it("changes a statement's bank when there is a choice", async () => {
    BANKS.push({ value: "other", label: "OTHER BANK" });
    try {
      const other = statement({ id: "statement-2", path: "/Users/example/Downloads/extrato-2030-02.pdf", bank: "other" });
      const { onStatements } = await renderStatements([statement(), other]);
      const banks = screen.getAllByLabelText(/^Bank for/);
      fireEvent.change(banks[1], { target: { value: "cgd" } });
      expect(onStatements).toHaveBeenCalledWith([statement(), { ...other, bank: "cgd" }]);
    } finally {
      BANKS.pop();
    }
  });

  it("adds nothing when the picker is cancelled", async () => {
    const { onStatements } = await renderStatements();
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(onStatements).not.toHaveBeenCalled();
  });

  it("ignores a statement already added", async () => {
    vi.mocked(pickStatements).mockResolvedValue([STATEMENT_PATH]);
    const { onStatements } = await renderStatements([statement()]);
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(onStatements).not.toHaveBeenCalled();
    expect(names()).toEqual(["extrato-2030-03.pdf"]);
  });

  it("rejects files that are not PDFs and keeps the PDFs", async () => {
    vi.mocked(pickStatements).mockResolvedValue(["/Users/example/Downloads/notes.txt", STATEMENT_PATH]);
    await renderStatements();
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(screen.getByText("notes.txt isn't a PDF. Only PDF statements can be added.")).toBeTruthy();
    expect(names()).toEqual(["extrato-2030-03.pdf"]);

    vi.mocked(pickStatements).mockResolvedValue(["/Users/example/Downloads/extrato-2030-02.pdf"]);
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(screen.queryByText(/isn't a PDF/)).toBeNull();
  });

  it("reports a picker failure", async () => {
    const failure = { kind: "internal", message: "no dialog" };
    vi.mocked(pickStatements).mockRejectedValue(failure);
    const { onError } = await renderStatements();
    await act(async () => fireEvent.click(button("Add Statements…")));
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("adds dropped files", async () => {
    await renderStatements();
    act(() => drop([STATEMENT_PATH, "/Users/example/Downloads/photo.png"]));
    expect(names()).toEqual(["extrato-2030-03.pdf"]);
    expect(screen.getByText("photo.png isn't a PDF. Only PDF statements can be added.")).toBeTruthy();
  });

  it("shows the file name with its full path as a tooltip", async () => {
    await renderStatements([statement({ path: "C:\\Users\\example\\extrato.pdf" })]);
    const name = screen.getByText("extrato.pdf");
    expect(name.getAttribute("title")).toBe("C:\\Users\\example\\extrato.pdf");
  });

  it("removes a statement", async () => {
    const other = statement({ id: "statement-2", path: "/Users/example/Downloads/extrato-2030-02.pdf" });
    const { onStatements } = await renderStatements([statement(), other]);
    fireEvent.click(button("Remove extrato-2030-03.pdf"));
    expect(onStatements).toHaveBeenCalledWith([other]);
    expect(names()).toEqual(["extrato-2030-02.pdf"]);
  });
});
