// Every test renders English strings.
import { afterEach } from "vitest";
import i18n from "../i18n";

await i18n.changeLanguage("en");

// HTML menus live outside the rendered tree, so each test starts without one. The module loads
// here, after the test file's mocks are registered.
afterEach(async () => {
  const { closeMenus } = await import("../lib/popUpMenu");
  closeMenus();
});
