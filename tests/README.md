# Regression tests

The automated checks require Node.js 18 or newer, GJS, Python 3.9 or newer, Make, GLib schema tools, zip, and unzip. Run from the project directory:

```sh
npm test
npm run check
glib-compile-schemas --strict --dry-run schemas
```

No npm dependency installation is required for these scripts. `npm test` discovers the `.mjs` suites in this directory and runs three explicit GJS suites: `test_timer_lifecycle.js`, `test_background_lifecycle.js`, and `test_drag_order.js`. It stops on the first failure. `npm run check` parses JavaScript files without executing the GNOME UI.

## Coverage

The tests exercise production code with small Shell UI fakes, plus real GLib timers and selected asynchronous Gio file operations.

| Area | Regression coverage |
| --- | --- |
| Animation and layout | Finite geometry, zoom/bounce settling, stable layout reuse, idle subscription removal, and indicator allocation/release. |
| Input and dragging | Magnified native hit bounds at every edge, scaled parents/pivots, X11 tracking, drag transform restoration, missed exits after click grabs, pointer-watch cleanup, favorite insertion/races, and empty native Dash drops. |
| Context-menu placement | Inward opening at every dock edge, actual icon-button anchoring, and refreshed geometry for reused menus after position changes, including right-to-left layouts. |
| App activation | Single-window minimizing, recent-window selection, restoring one minimized window, Show Desktop/stale-focus recovery, monitor/workspace filtering, and native modifier/custom-launcher fallbacks. |
| Window previews | Proportional compositor clones, minimized-window preservation, unavailable-surface fallback, selecting one window, bounded scrolling, keyboard visibility, title/window changes, no modal manager, first-click delivery to outside targets, Escape/source dismissal, and releasing clones/input/window signals on close or destruction. |
| Preview hover | Retained source zoom over tall previews and narrow gaps at all edges, other-icon priority, dismissing without activation, hidden/fullscreen/drag overrides, movement-only wakeups, and settling without a continuous animation timer. |
| Scrolling | Direction, thresholds, cooldown, monitor/workspace selection, and restoring only the selected window. |
| Autohide | Window tracking and hidden-footprint containment; edge, pressure, open-menu, overview, and window-dodge behavior at four edges and on offset/scaled monitors. |
| Settings and startup | Settled-dock updates, late configuration, FPS restarts, cached launcher refresh, preference feedback, duplicate topology prevention, and stale async result rejection. |
| Resources and services | Timer failure/cancellation, teardown isolation, menu/canvas/integration disposal, notification signals, service deadlines, disabled watchers, coalesced folder scans, bounded Downloads metadata, and shader source/uniform reuse. |
| Blur My Shell | Discovery before allocation, signal-capable actors, stacking, modern blur geometry ownership, and legacy hooks. |
| Packaging and updates | Modern/legacy contents and metadata, themes and new source modules, archive validation, exact preference preservation, rollback after corrupted/partial installs, and unsafe backup destinations. |

Packaging tests build both bundles in guarded temporary directories. Upgrade tests simulate installation entirely in temporary directories and never call the real extension installer. Failure-path tests deliberately log injected timer/disposal errors and a preview-open error to exercise the native-menu fallback; a nonzero exit status or failed assertion determines failure, not those expected messages.

Run a focused suite while iterating:

```sh
node tests/test_window_activation.mjs
node tests/test_window_preview.mjs
gjs -m tests/test_drag_order.js
```

The older `test_*.js` files outside the three GJS suites are manual experiments, some requiring a graphical session. The automated runner does not launch them.

## Desktop verification

Complete [CHECKLIST.md](../CHECKLIST.md) in a disposable GNOME session before a release. Pay particular attention to magnified overhang clicks, inward right-click menu placement at every dock edge, immediate exits after clicking, Show Desktop recovery, minimized siblings, preview selection/dismissal, immediate return during autohide, and repeated enable/disable or lock/unlock.

Inspect the Shell journal for disposed-object errors and Clutter allocation assertions. Compare whole-Shell CPU and RAM under the same idle, stationary-hover, and repeated interaction conditions. These regression tests check behavior, operation counts, and resource lifetimes; they do not measure a live compositor's GPU/CPU use or process RSS, and cannot establish input focus, rendering, or Shell-version compatibility by themselves.

See [HACKING.md](../HACKING.md) for build commands and [ERRORS.md](../ERRORS.md) for a reproducible diagnostic report.
