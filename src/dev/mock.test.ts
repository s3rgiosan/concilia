import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

/** The command names `src/lib/tauri.ts` invokes. */
function invokedCommands(): string[] {
  const names = new Set<string>();
  for (const match of read("../lib/tauri.ts").matchAll(/(?:invoke|run)(?:<[^>]*>)?\("([a-z_]+)"/g)) {
    names.add(match[1]);
  }
  return [...names];
}

describe("mock backend", () => {
  it("handles every command the app invokes", () => {
    const mock = read("./mock.ts");
    const commands = invokedCommands();
    expect(commands).toContain("set_menu_state");
    const missing = commands.filter((name) => !mock.includes(`case "${name}"`));
    expect(missing).toEqual([]);
  });
});
