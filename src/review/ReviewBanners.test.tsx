// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "../i18n";
import { revealPeriod, type RefusedFile } from "../lib/tauri";
import { ReviewBanners, type ReviewBannersProps } from "./ReviewBanners";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  openReport: vi.fn(),
  revealPeriod: vi.fn(),
}));

const LARGE: RefusedFile = {
  file: "/r/2030/03/receipts/scan-archive.pdf",
  rel_path: "2030/03/receipts/scan-archive.pdf",
  code: "file_too_large",
};
const UNKNOWN: RefusedFile = {
  file: "/r/2030/03/receipts/notes.pdf",
  rel_path: "2030/03/receipts/notes.pdf",
  code: "unrecognized_file",
};

function renderBanners(
  refused: RefusedFile[],
  patch: Partial<ReviewBannersProps> = {},
) {
  const props: ReviewBannersProps = {
    period: { year: "2030", month: "03" },
    finalized: false,
    notice: null,
    dropped: [],
    refused,
    onDismissFinalized: vi.fn(),
    onDismissNotice: vi.fn(),
    onDismissDropped: vi.fn(),
    onDismissRefused: vi.fn(),
    onError: vi.fn(),
    ...patch,
  };
  render(<ReviewBanners {...props} />);
  return props;
}

beforeEach(() => {
  vi.mocked(revealPeriod).mockResolvedValue(undefined);
});

afterEach(async () => {
  cleanup();
  vi.clearAllMocks();
  await i18n.changeLanguage("en");
});

describe("the refused files banner", () => {
  it("names each file with its reason in English, in the plural", () => {
    renderBanners([LARGE, UNKNOWN]);
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain(
      "Concilia can't read 2 files in this month's receipts folder:",
    );
    expect(banner.textContent).toContain(
      "scan-archive.pdf: too large (over 50 MB)",
    );
    expect(banner.textContent).toContain("notes.pdf: not a PDF or image file");
  });

  it("uses the singular for one file", () => {
    renderBanners([LARGE]);
    expect(screen.getByRole("status").textContent).toContain(
      "Concilia can't read 1 file in this month's receipts folder:",
    );
  });

  it("words the banner in Portuguese", async () => {
    await i18n.changeLanguage("pt");
    renderBanners([LARGE, UNKNOWN]);
    const text = screen.getByRole("status").textContent;
    expect(text).toContain(
      "O Concilia não consegue ler 2 ficheiros na pasta de recibos deste mês:",
    );
    expect(text).toContain(
      "scan-archive.pdf: demasiado grande (mais de 50 MB)",
    );
    expect(text).toContain("notes.pdf: não é um PDF nem uma imagem");
    cleanup();
    renderBanners([LARGE]);
    expect(screen.getByRole("status").textContent).toContain(
      "O Concilia não consegue ler 1 ficheiro na pasta de recibos deste mês:",
    );
  });

  it("falls back to a generic reason for an unknown code", () => {
    renderBanners([{ ...LARGE, code: "something_else" }]);
    expect(screen.getByRole("status").textContent).toContain(
      "scan-archive.pdf: can't be read",
    );
  });

  it("shows the folder in Finder", () => {
    renderBanners([LARGE]);
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(revealPeriod).toHaveBeenCalledWith("2030", "03");
  });

  it("is dismissible", () => {
    const props = renderBanners([LARGE]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(props.onDismissRefused).toHaveBeenCalled();
  });

  it("is absent without refused files", () => {
    renderBanners([]);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
