The automated regression tests require Node.js 18 or newer, GJS, Python 3,
Make, GLib schema tools, zip, and unzip. Run from
the project directory:

```sh
npm test
npm run check
glib-compile-schemas --strict --dry-run schemas
```

The regression suites exercise the production code with small Shell UI fakes,
plus real GLib timers and asynchronous Gio file enumeration. They cover timer
failures and cancellation, zoom settling and finite actor geometry, bounce
cleanup, autohide window tracking, favorite insertion and concurrent changes,
settings bindings, resource disposal, async reply ordering, Trash scan event
coalescing, Show Apps labels and toggling, startup, and shutdown.
Resource regressions also check that stationary hover and pullouts settle,
unchanged frames reuse layout without resizing the dock, idle timers release
their GLib source immediately, and services sleep until their next deadline.
Disabled features create no folder/volume watchers; Downloads metadata requests
are limited to displayed rows, event bursts coalesce, unchanged results do not
animate, and indicator canvases release when their content disappears. Shader
checks ensure repeated paints do not write uniforms or reload source files.
Live settings/configuration tests exercise waking settled docks and replacing
cached folder launchers. Empty-dock drag tests use the native Dash child-count
contract. Blur My Shell compatibility tests exercise discovery before allocation,
signal-capable dock actors, blur geometry ownership, and older integration hooks.
Magnified input tests match native button bounds to rendered icons at all four
edges, with scaled parents and pivots, and verify X11 tracking, native drag
restoration and idle stability. Pointer watch tests cover missed exits after
click grabs, stationary hover, and cleanup on hide, cancellation and teardown.
Window activation tests cover focused clicks, recent-window selection, restoring
only one minimized window, monitor/workspace selection, and native launch,
modifier and custom-icon behavior.
Packaging tests build modern/legacy bundles in a guarded temporary
directory. Upgrade tests simulate installs, exact preference preservation,
corrupted/partial-install rollback, and unsafe backup destinations entirely in
temporary directories; they never invoke the real extension installer.
The lifecycle suites deliberately log injected errors to verify that timer
callbacks and teardown continue running after a failure.

The older `test_*.js` files outside the lifecycle and drag suites are manual demos
requiring a graphical session; the automated runner does not launch them.

Before release, test inside a disposable GNOME Shell session: reorder favorites
in both directions at all four screen edges, insert at the start/middle/end,
cancel a drag, open/close an app while dragging, zoom repeatedly then leave the
dock, lock/unlock, change monitors/scaling, and enable/disable repeatedly. Check
the Shell journal for disposed-object errors and Clutter allocation assertions.
Compare idle CPU, stationary-hover CPU, and RAM before and after repeated
hover/pullout/lock cycles. These operation-count regressions do not measure a
live compositor's CPU usage or process RSS.
Unit tests cannot verify compositor input focus, GPU rendering, or Shell-version
compatibility by themselves.
