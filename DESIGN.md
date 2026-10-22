# Current architecture

This document describes the implementation in this fork. Earlier sketches of separate `DockContainer` and `DockWidget` APIs were proposals, not implemented interfaces. User-facing setup is in [README.md](README.md); contributor commands are in [HACKING.md](HACKING.md).

## Modules and ownership

| Module | Responsibility |
| --- | --- |
| `extension.js` | Owns settings, timers, services, integrations, configuration, dock topology, and extension enable/disable. |
| `dock.js` | Owns a dock's native Dash, monitor placement, layout, transformed input buttons, favorites, app activation, and scrolling. |
| `animator.js` | Updates reusable icon renderers, zoom, bounce, running dots, and badges; settles when visual state stops changing. |
| `dockItems.js` | Dock actors, overlays, custom launcher items, backgrounds, and their app-action menus. |
| `windowPreviewMenu.js` | Native popup menu with proportional compositor clones, title labels, bounded scrolling, and window-row lifetimes. |
| `dockItemMenu.js` | Folder/Downloads pullout actors and their temporary contents. |
| `autohide.js` | Window overlap tracking, edge/pressure reveal, and hide/show transitions. |
| `services.js` | Clock/calendar deadlines, notification state, folder monitoring, asynchronous Downloads/Trash scans, and mounted devices. |
| `timer.js` | Shared GLib timer subscriptions, deferred work, cancellation, and source removal when idle. |
| `integrations.js` | Blur My Shell and Compiz hooks, including restoring or releasing owned wrappers. |
| `prefs.js`, `preferences/`, `ui/` | Shared preferences UI, settings bindings, presets, and original-project/support links. Both build targets use the same UI. |
| `style.js`, `drawing.js`, `effects/`, `apps/` | Generated stylesheets, drawing helpers, icon effects, and dynamic icon content. |
| `monitors.js` | Preferences-side Mutter display configuration queries and stale-reply rejection. |

## Rendering and input

The dock retains native Dash app buttons for activation, drag-and-drop, keyboard interaction, and app menus. Animated icons render separately in `renderArea`; the renderer actors are not click targets. `_syncIconInput()` transforms the corresponding native buttons to match the displayed icons, including their overhang outside the dock background. It restores those transforms for dragging and teardown.

The dock's `struts`, `dwell`, background, and input geometry serve different purposes: reserved work area, edge reveal, visual fill/blur, and pointer interaction. Keep their coordinates consistent with the selected monitor and scale. While hidden, autohide ignores the former visible footprint so the hide animation cannot create an oversized reveal zone.

Blur My Shell receives allocated, signal-capable dock actors. Newer Blur My Shell versions own their surface geometry; older hooks use the compatibility path. Integration changes must preserve that distinction and background/renderer stacking.

## Window selection

Normal app clicks use this fork's activation policy: a focused single window minimizes; an inactive app activates one recent eligible window; a focused multi-window app opens the preview chooser. Ctrl-click, middle-click, and right-click retain native app actions. Click and scroll selection use the configured monitor filter; the preview chooser retains an app-wide list, matching the native app menu.

Activation uses `Meta.Window.activate()` on the active workspace and `Meta.Workspace.activate_with_focus()` when switching workspaces. These paths leave Show Desktop and restore the selected window and any required transient parents. Low-level `raise()` and `focus()` alone do not provide those semantics. Hidden or minimized windows cannot qualify for the focused-window minimize toggle.

The preview chooser uses `PopupMenu` and `PopupBaseMenuItem` for its actor layout and keyboard rows, without `PopupMenuManager` or a modal grab. An open-only stage listener dismisses on outside clicks and propagates the same event to its target. Pointer opening preserves keyboard focus; an arrow toward the popup enters its rows, and Escape dismisses it. Older X11 sessions track only the popup's input rectangle.

While the pointer is in a preview or the narrow gap connecting it to its source, the animator uses the source icon's position to retain zoom. Real hover on another icon wins and dismisses the preview. The existing movement-only pointer watcher handles leaving a settled preview; holding zoom does not require a continuous animation timer. Hidden, fullscreen, drag, disabled-magnification, and teardown behavior take precedence.

The chooser clones existing compositor actors without showing or unminimizing their source windows. Missing surfaces use an app-icon fallback. Window changes update rows while open; closing releases clones and window/app/input connections. Destroying the app icon also destroys its chooser.

## Work and lifetime rules

- Input, settings, window events, and service changes wake animation. Settled visuals stop the animation subscription; stationary hover is not a reason to repaint indefinitely.
- Services schedule their next deadline and use filesystem/notification events where available. Disabled optional services release their watchers; locking suspends their work.
- Downloads and Trash enumeration runs asynchronously. Cancellation, generation checks, coalesced events, and bounded displayed metadata prevent stale results or bursts from retaining unnecessary work.
- Every timer, signal, file monitor, menu, actor, and integration hook needs an owner and a cleanup path. Disable and partial teardown must release remaining resources even if one cleanup operation fails.
- Check lifecycle/generation state before applying asynchronous results. Do not create new icon textures during allocation or actor teardown.
- Keep version-dependent APIs guarded. Modern builds use ES modules; the legacy build converts imports/exports and changes the declared Shell targets to 42–44.

The regression suites enforce these contracts with controlled fakes and selected real GLib/Gio operations. [CHECKLIST.md](CHECKLIST.md) covers compositor behavior and desktop compatibility that those tests cannot establish.
