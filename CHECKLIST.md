# Release verification

Use this checklist for each release. These are checks to perform, not a record that every supported Shell version or desktop scenario has passed. Record the package version, GNOME Shell version, session type, monitor layout, scaling, and results with the release.

## Automated checks and packages

- Run `npm test`, `npm run check`, and `glib-compile-schemas --strict --dry-run schemas`.
- Build modern and legacy archives separately, following [HACKING.md](HACKING.md). Check each archive's version, UUID, Shell targets, themes, and source files.
- Review [CHANGELOG.md](CHANGELOG.md) and [README.md](README.md) against the final behavior. A declared Shell target requires desktop testing on that version.
- Use the update helper on an existing test installation; confirm its manifest reports verified files/settings and preferences survive logging out and back in.

## Desktop lifecycle and settings

- Enable/disable repeatedly, lock/unlock, suspend/resume, and log out/in. Inspect the Shell journal for errors, disposed actors, duplicate docks, and allocation assertions.
- Change preferences while the dock is settled: size, magnification, position, FPS, panel mode, colors, labels, indicators, and optional icons. Verify changes appear without an extra pointer movement.
- Connect/disconnect monitors, change the primary/preferred monitor, and test scale 1 and 2 plus fractional scaling where supported. Check docks and reserved screen areas after changes.
- Test Wayland and X11 on Shell versions that provide them; Shell 50 and newer do not provide an X11 session.

## Icon input and favorites

- At all four screen edges, hover and click the enlarged part of an icon outside the background. Verify the intended icon receives the click.
- Click, move away immediately, and confirm zoom settles without returning the pointer to the dock. Also test stationary hover and disabled magnification.
- Reorder favorites forward/backward; insert at the start, middle, and end; cancel a drag; change running apps during a drag; and drop into an empty favorites-only dock.
- Check Show Apps with mouse, touch, and keyboard: hover label, opening the app grid, closing it on a second click, and its optional horizontal front position.

## Window activation and previews

- One window: click to focus/restore; click the focused app again to minimize. From the overview, clicking returns to the window.
- Several windows: click an inactive app to activate one window; click the active app to open thumbnails. Select a thumbnail and verify only that window activates.
- Keep a sibling minimized while opening previews, selecting another window, and scrolling. Preview display alone must not restore it.
- Use Show Desktop, then select each app through the dock. Verify a window returns, including when focus notifications are still pending.
- Test previews at every dock edge, with many windows, long titles, unavailable surfaces, and changing/closing windows. Check scrolling, keyboard selection, Escape, outside-click dismissal, right-click actions, and cleanup on disable.
- Browse previews without selecting: the source stays zoomed, crossing the gap works, and returning to another icon dismisses previews and lets its first click through. Move away, click elsewhere, press Escape, or re-click the source; no window should activate just from dismissal. Check that pointer opening preserves keyboard focus and stationary browsing stops frame work.
- Scroll both directions across windows and workspaces; hold Ctrl to limit cycling to the current workspace. Check monitor filtering and native Ctrl-click/middle-click new-window actions.

## Autohide, services, and integrations

- Hide the dock and immediately return through its former footprint. It should reveal at the edge according to the pressure setting, without a temporary wider hover zone.
- Test fullscreen windows, workspace switches, overlapping windows, panel mode, and pointer pressure at each edge. Menus must remain accessible while open.
- Change icon themes; add/remove Downloads and Trash entries; mount/unmount several devices; and enable/disable optional icons. Check default file opening with and without a configured file explorer.
- Test Blur My Shell discovery, geometry, stacking, and enable/disable order. Test Compiz Magic Lamp integration when installed.
- Compare whole-Shell CPU and memory during idle, stationary hover, menus, and repeated hover/pullout/lock cycles. Record conditions and measurements; operation-count tests alone do not establish CPU or memory improvements.
