export type View = "main" | "settings";

/** Picks the window view from the `view` query parameter. Unknown values fall back to the main view. */
export function viewFromSearch(search: string): View {
  const value = new URLSearchParams(search).get("view");
  switch (value) {
    case "settings":
      return "settings";
    default:
      return "main";
  }
}
