# Wiring

How each menu item, context menu and native surface reaches its handler, and where each permission is declared. Fire every entry in the built app before a release.

## Menu bar

Built in `src-tauri/src/menu.rs` (`build`). The frontend sends the localized labels (`set_menu`), the enabled flags (`set_menu_state`) and the Remove Match text (`set_menu_item_text`) from `src/lib/hooks/useMenu.ts`.

Routes, from `menu::route` and `handle_menu_event` in `src-tauri/src/lib.rs`:

- **Rust**: the item runs in the backend.
- **Main**: a `menu` event with `{ id }` to the main window, handled in `useMenu.ts` (`onMenu`), month items in its `switch`, review items through `runMenuCommand` in `src/lib/menuCommands.ts`.
- **Focused**: a `menu` event to the Settings window while it has focus (`menu::event_target`), handled in `src/settings/Settings.tsx`; otherwise as Main.
- **AppKit**: a predefined item handled by the system.

| Menu | Item | Id | Shortcut | Route | Handler |
|---|---|---|---|---|---|
| App | About Concilia | predefined | | AppKit | About panel with version, copyright and credits (`menu.rs` `AboutMetadata`) |
| App | Check for Updates… | `check_updates` | | Rust | `check_for_updates_from_menu` (`lib.rs`), result sent as `update-check-result` to main |
| App | Settings… | `settings` | ⌘, | Rust | `windows::open_settings` |
| App | Services, Hide Concilia, Hide Others, Show All, Quit Concilia | predefined | system | AppKit | |
| File | New Month… | `new_month` | ⌘N | Main | `MenuActions.newMonth` (`Main.tsx`) |
| File | Show in Finder | `reveal_period` | | Main | `MenuActions.revealPeriod` |
| File | Close Window | predefined | ⌘W | AppKit | |
| Edit | Undo | `undo` | ⌘Z | Focused | text field: `execCommand("undo")`; review: `undo`; Settings: Rules pane undo |
| Edit | Redo | `redo` | ⇧⌘Z | Focused | text field: `execCommand("redo")`; review: `redo` |
| Edit | Cut, Copy, Paste, Select All | predefined | system | AppKit | |
| Edit | Delete | `delete` | | Focused | text field: `execCommand("delete")` |
| Edit | Find | `find` | ⌘F | Main | review: `focusSearch` |
| View | To Decide, Matched, All | `filter_pending`, `filter_matched`, `filter_all` | ⌘1, ⌘2, ⌘3 | Main | review: `setFilter` |
| View | Show Sidebar / Hide Sidebar | `toggle_sidebar` | ⌃⌘S | Main | `MenuActions.toggleSidebar` |
| View | Enter Full Screen | predefined | ⌃⌘F | AppKit | |
| View | Actual Size, Zoom In, Zoom Out | `actual_size`, `zoom_in`, `zoom_out` | ⌘0, ⌘=, ⌘− | Rust | `zoom::apply` on the focused window, then `zoom-changed` to that window (Settings resizes to fit, `useFitWindow.ts`) |
| Month | Add Statements… | `add_statements` | ⌘O | Main | `MenuActions.addStatements` |
| Month | Reconcile | `reconcile` | ⌘R | Main | `MenuActions.reconcile` |
| Month | Scan for New Receipts | `scan` | ⇧⌘R | Main | review: `scan` |
| Month | Finalize… | `finalize` | | Main | review: `finalize`, which shows the Finalize alert |
| Month | Reconcile Again… | `rerun` | | Main | `MenuActions.rerun`, which shows the Reconcile Again alert |
| Month | Open Report | `open_report` | | Main | `MenuActions.openReport` |
| Month | Export Report… | `export_report` | | Main | review: `exportReport` |
| Transaction | Assign Receipt | `accept` | ⌘↩ | Main | review: `accept` |
| Transaction | Remove Match (text follows the selection) | `reject` | ⌘⌫ | Main | review: `reject` |
| Transaction | No Receipt Needed › Bank Fee, Salary, Transfer, Refund, Other | `no_receipt_*` | | Main | review: `noReceipt` |
| Transaction | Read Receipt Again | `rescan` | ⌥⌘R | Main | review: `rescan` |
| Transaction | Quick Look | `quick_look` | ⌘Y | Main | review: `quickLook` |
| Transaction | Open in Preview | `open_in_preview` | ⌥⌘O | Main | review: `openInPreview` |
| Go | Next Undecided, Previous Undecided | `next_pending`, `previous_pending` | ⌘], ⌘[ | Main | review: `nextPending`, `previousPending` |
| Window | Minimize, Zoom, Bring All to Front | predefined | system | AppKit | registered as the Window menu (`WINDOW_SUBMENU_ID`) |
| Help | Concilia Help | `help` | | Rust | opens `menu::HELP_URL` |

## Context and pop-up menus

Native menus built in the webview with `Menu.new` and shown with `menu.popup` (`src/lib/popUpMenu.ts`); each entry runs its `onSelect` in the page.

| Where | Built in | Items |
|---|---|---|
| Sidebar month (right click) | `monthMenu` in `src/main/Main.tsx`, shown by `src/main/Sidebar.tsx` | Open Report, Show in Finder, Reconcile Again… |
| Month toolbar More Actions | `monthActions` in `src/main/Main.tsx` | Open Report, Show in Finder, Reconcile Again… |
| Statement row (right click) | `src/main/Statements.tsx` | Remove |
| Transaction row (right click) | `rowMenu` in `src/review/rowMenu.ts`, shown by `src/review/Review.tsx` | Quick Look, Open in Preview, Read Receipt Again, Assign Receipt, Remove Match, No Receipt Needed, Always Match rule |
| Receipt row (right click) | `src/review/ReceiptRow.tsx` | Read Receipt Again, Open in Preview |
| Toolbar pop-up buttons | `src/components/PopUpButton.tsx` with entries from `ReviewToolbar.tsx` and `Details.tsx` | the entries each pane passes |
| Text fields | WebKit | the system text menu (`App.tsx` keeps it for text fields only) |

## Alerts

`show_alert` (`src-tauri/src/alert.rs`) shows an `NSAlert` as a sheet on the calling window through `tauri-plugin-dialog`.

| Alert | Asked from | Buttons |
|---|---|---|
| Finalize <month>? | `askFinalize` in `src/review/Review.tsx` (`finalizeAlert.ts`) | Finalize, Review Remaining (while transactions need a decision), Cancel |
| Reconcile <month> again? | `askRerun` in `src/main/Main.tsx` (`rerunAlert.ts`) | Reconcile Again, Cancel |
| Remove the service account key? | `askRemove` in `src/settings/GeminiTab.tsx` | Remove Key, Cancel |

## Events

| Event | Sent by | To | Listener |
|---|---|---|---|
| `menu` | `handle_menu_event` (`lib.rs`) | main, or Settings for Undo, Redo and Delete while it has focus | `onMenu` in `useMenu.ts` and `Settings.tsx` |
| `appearance-changed` | `appearance::refresh` on window focus and theme change | all windows | `installAppearance` (`src/lib/appearance.ts`) |
| `zoom-changed` | `zoom::apply` | the zoomed window | `onZoomChanged` in `useFitWindow.ts` |
| `settings-changed` | `commands.rs` after a settings change | all windows | `onSettingsChanged` |
| `busy-changed` | the lock watcher set up in `lib.rs` | all windows | `onBusyChanged` |
| `update-progress` | `install_update` in `commands.rs` | all windows | `onUpdateProgress` |
| `update-check-result` | `check_for_updates_from_menu` in `lib.rs` | main | `onUpdateCheckResult` |

## Permissions

App commands are declared in `src-tauri/build.rs` (`COMMANDS`); each window may call only the commands its capability allows.

| Capability | File | Window | Grants |
|---|---|---|---|
| `main` | `src-tauri/capabilities/main.json` | main | core app version, event listen, menu new and popup, window title, progress bar, attention and dragging; the month, review, report, menu-state, update, `get_appearance` and `show_alert` commands |
| `settings` | `src-tauri/capabilities/settings.json` | settings | core app version, event listen, window size, title and dragging; the settings, key, Gemini, rules, update, `get_appearance` and `show_alert` commands |

Plugins used from Rust only (no webview permission): `tauri-plugin-window-state` restores the main window's size and position, `tauri-plugin-dialog` shows file pickers and alerts, `tauri-plugin-opener` opens the help and key pages.
