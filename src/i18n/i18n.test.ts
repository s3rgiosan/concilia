// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import en from "./locales/en.json";
import pt from "./locales/pt.json";
import i18n, { applyLanguage, resolveLanguage } from "./index";

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      out.set(path, value);
    } else {
      for (const [k, v] of leaves(value, path)) {
        out.set(k, v);
      }
    }
  }
  return out;
}

describe("locales", () => {
  const english = leaves(en as Tree);
  const portuguese = leaves(pt as Tree);

  it("have the same keys", () => {
    expect([...portuguese.keys()].sort()).toEqual([...english.keys()].sort());
  });

  it("have no empty strings", () => {
    for (const [key, value] of [...english, ...portuguese]) {
      expect(value.trim(), key).not.toBe("");
    }
  });

  it("use the same placeholders in both languages", () => {
    const placeholders = (s: string) => (s.match(/\{\{\w+\}\}/g) ?? []).sort();
    for (const [key, value] of english) {
      expect(placeholders(portuguese.get(key) ?? ""), key).toEqual(placeholders(value));
    }
  });

  it("never say por defeito", () => {
    for (const value of portuguese.values()) {
      expect(value.toLowerCase()).not.toContain("por defeito");
    }
  });
});

describe("resolveLanguage", () => {
  it("keeps a saved choice", () => {
    expect(resolveLanguage("pt", "en-US")).toBe("pt");
    expect(resolveLanguage("en", "pt-PT")).toBe("en");
  });

  it("follows the system without one", () => {
    expect(resolveLanguage(null, "pt-PT")).toBe("pt");
    expect(resolveLanguage(null, "pt-BR")).toBe("pt");
    expect(resolveLanguage(null, "de-DE")).toBe("en");
  });
});

describe("loading", () => {
  it("loads a language the first time it is shown", async () => {
    await applyLanguage("en");
    expect(i18n.hasResourceBundle("en", "translation")).toBe(true);
    expect(i18n.hasResourceBundle("pt", "translation")).toBe(false);
    await applyLanguage("pt");
    expect(i18n.hasResourceBundle("pt", "translation")).toBe(true);
    expect(i18n.t("common.cancel")).toBe(pt.common.cancel);
    await applyLanguage("en");
    expect(i18n.t("common.cancel")).toBe(en.common.cancel);
  });
});

describe("plurals", () => {
  it("use the European Portuguese rules, where 0 is plural", async () => {
    await applyLanguage("pt");
    expect(i18n.t("month.summary.transactions", { count: 0 })).toBe("0 transações");
    expect(i18n.t("month.summary.transactions", { count: 1 })).toBe("1 transação");
    expect(i18n.t("month.summary.transactions", { count: 2 })).toBe("2 transações");
    await applyLanguage("en");
    expect(i18n.t("month.summary.transactions", { count: 0 })).toBe("0 transactions");
  });
});
