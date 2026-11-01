# Changelog

Extension versions refer to `metadata.json`. This fork's current behavior is documented in [README.md](README.md); older entries describe their releases and may have been superseded.

## Version 118

* Match the window preview chooser's nonmodal behavior on right-click app menus and custom launcher menus: hovering another dock icon dismisses the menu and magnifies that icon immediately, and moving away into empty space unzooms and dismisses without forcing an action.
* Outside mouse clicks and touch presses close the context menu without swallowing the event, delivering the click to other dock icons or desktop windows immediately. Escape closes the menu.
* Detach context menus from `PopupMenuManager` modal grabs and track nonmodal input via stage captured-events. Unify popup owner tracking in the animator so context menus share preview dismissal, gap transit, and zoom retention.

## Version 117

* Keep the right-clicked icon magnified while its native app-actions menu is open, including custom launcher menus and keyboard/long-press opening. Preserve native menu actions and dismissal.
* Wake normal hover settling when the menu closes, release retained zoom on icon cleanup, and suspend frame work while an open menu is stationary. Hidden/fullscreen, dragging, and disabled-magnification behavior still take precedence.
* Cover context-menu zoom and dismissal at all four dock edges, legacy/current native menu creation, custom launchers, icon-cache invalidation, and teardown.

## Version 116

* Restore thumbnail previews on GNOME 51 using St's supported orientation property on GNOME 48 and newer, with the legacy property retained for older targets. The removed property caused previews to fail and fall back to the modal title-only menu, losing retained icon zoom and free browsing between icons.
* Save **Dashes** rather than single **Dash** in the personal settings: one thin running marker per window, up to four, at the dock's outer edge. Preserve the Small thickness and separate notification badge.
* Test preview construction across GNOME 42–51 API variants, thumbnail availability, dismissal without selection, first-click delivery to another icon, and multi-window dash counts at all four edges.

## Version 115

* Enlarge the **Small** circular notification count badge to 2.25 times its version 114 diameter. Keep centered numbers, circular geometry, and the thin running-window dash.

## Version 114

* Make dash thickness respect the size setting: **Small** is half the normal visible thickness, including its outline, while keeping the dash length.
* Draw notification counts in a circle for all counts, fitting the white number inside it. **Small** uses one-third the diameter of version 113's Large badge; counts above 99 still show **99+**.
* Save both size preferences as **Small** in the personal configuration.

## Version 113

* Use square corners for the red notification count badge. One digit uses a square; longer counts widen into a rectangle to keep the numbers readable.
* Set the opened-window marker to a single short **Dash** in the saved personal settings. This preference applies immediately without reloading the extension.
* Select **Large** for notification badges in the saved personal settings, and document reloading the GNOME session when an older running version still shows a small dot.

## Version 112

* Add **Count** notification badges: a circle with the notification number, widening for multiple digits and showing **99+** above 99. Keep badges at the icon's top-right through magnification and monitor scaling; zero notifications remove the badge.
* Use red badges with white numbers in the saved personal settings, alongside the separate single circular running-window marker. Keep **None** and the existing notification shapes available.

## Version 111

* Honor **None** for notification badges: do not draw the top-right badge or allocate its drawing surface, and release an existing badge as soon as it is disabled.
* Update the saved personal dock settings to use one circular running-window marker per app, on the dock's outer edge. Keep other running-marker styles available in preferences.

## Version 110

* Fix GNOME 51 startup after removal of Shell's `ui/pointerWatcher.js`. Bundle pointer watching with the extension instead of importing that removed resource.
* Use coalesced cursor-position notifications on newer Shell versions, retain an idle-aware fallback for older versions, and release pending work and signals when the final watch is removed.
* Keep the saved eight-extension desktop profile explicitly tied to its GNOME 48 snapshot. GNOME 51 source/API and native component checks do not establish live desktop behavior.

## Version 109

* Document the maintainer's complete GNOME 48 setup, including eight installed extension versions, settings snapshots, appearance, wallpaper, and app order. Add an optional installer/restore helper with backups, version checks, and isolated tests.
* Include an optional `my-custom.dconf` snapshot of 94 current preferences and document restoring it after a fresh install. Keep its application explicit; installation preserves existing settings.
* Audit repository files by actual use; remove obsolete standalone experiments, unused UI layouts, launcher templates, custom icons, and the unused vector helper. Stop tracking the generated settings binary.
* Keep modern and legacy packaging, use the shared current preferences UI, and make the default build compile without installing. Development installation uses the official ZIP installer.
* Clearly credit icedman's original project and describe his Buy Me a Coffee link as support. Preserve the GPL license, original author metadata, source credits, support QR, funding accounts, and historical artwork.

## Version 108

* Position right-click app menus toward the desktop from the clicked icon at every dock edge, including native app actions and custom launchers. Anchor menus to the actual icon button so placement follows its magnification.
* Refresh menu geometry before opening, including reused menus after changing the dock position and menus in right-to-left layouts.

## Version 107

* Remove the preview chooser's modal input grab so outside mouse/touch clicks dismiss it and reach their target immediately, without choosing a window first.
* Keep the source icon zoomed while browsing previews or crossing the narrow gap to them. Hovering another icon or moving away dismisses the previews without activation; Escape and a second source click also dismiss.
* Retain idle suspension, keyboard navigation, X11 popup input tracking, and cleanup of preview and pointer listeners.

## Version 106

* Show proportional window thumbnails and titles when clicking an active app with multiple windows. Selecting a preview activates only that window; minimized siblings remain minimized while previews are open.
* Bound long preview lists with scrolling, retain native keyboard/menu dismissal, update window rows while open, and release compositor clones and listeners on close or teardown. Unavailable surfaces show an app icon; right-click keeps native app actions.
* Restore an app window after Show Desktop or minimizing all windows. Use Mutter's normal window activation and ignore stale focus on hidden/minimized windows for click toggling and scroll selection.
* Refresh all repository Markdown for current setup, behavior, architecture, troubleshooting, and release verification; move already shipped fixes out of the former “Next Release” list.

## Version 105

* Ignore the old dock footprint while hidden so returning near the dock during its hide animation cannot reveal it away from the screen edge. Preserve pressure/edge reveal and open-menu behavior.

## Version 104

* Toggle a single app window between focused and minimized. Click the active multi-window app to open a native title chooser; retain native app actions on right-click. Version 106 replaces the normal chooser with thumbnails.
* Restore only the selected window when scrolling through app windows; keep other minimized windows unchanged and preserve the app's window order. Keep the dock visible while a menu is open.

## Version 103

* Activate an app's most recent unminimized eligible window on a normal dock click; restore only one when all are minimized. This release left a focused app unchanged; version 104 added single-window toggling and multi-window selection.
* Update installation, upgrade, configuration, and testing documentation.

## Version 102

* Match native button hit areas to magnified icons, including outside the dock background; recover zoom after click grabs swallow pointer exit events.
* Keep Show Apps mouse, touch, and keyboard activation on its native button while retaining the older zero-size fallback.

## Version 101

* Expose allocated dock actors to newer Blur My Shell versions and let its surface tracker manage blur geometry. Retain older integration hooks and correct background stacking.

## Version 100 and earlier fork fixes

These changes were collected under version 100 before the numbered follow-up releases above.

* wake settled docks for live visual settings and late configuration; restart correctly after changing FPS and refresh cached folder launchers
* allow dragging apps into an empty dock or an empty favorites-only dock
* restore default running dots/badges and correct tint transparency
* refresh Downloads periodically only when filesystem monitoring is unavailable
* include bundled themes, publish legacy archives without installing them and preserve unrelated ZIP backups
* verify update archives and settings before installation, with automatic rollback on failed or corrupted installs
* stop animation when hover, tooltips, autohide slides and Downloads pullouts settle; wake it again on input
* reuse unchanged dock layout and final bounds, avoid forced offscreen buffers and allocate indicator canvases only when needed
* use notification signals and service deadlines instead of idle polling; detach disabled folder/volume watchers and suspend services while locked
* coalesce Downloads scan bursts, fetch rich metadata only for displayed rows and skip redraws for unchanged results
* reduce pullout, autohide and Blur My Shell work; release resources held by closed pullouts and chained integration hooks
* set shader samplers once instead of updating uniforms on every paint; share shader sources between instances
* reorder pinned icons at the pointer position on horizontal and vertical docks; reuse existing app actors and cancel stale favorite writes
* keep animation timers usable after callback failures, finish zoom and bounce cleanup, and prevent callbacks from reaching destroyed docks
* release window, settings, canvas, menu and integration resources on shutdown; reject stale monitor/config/file results
* scan Downloads and Trash asynchronously without blocking the Shell main loop or retaining every download entry; rescan Trash after changes received during an active scan
* fix transformed input areas, fullscreen/monitor pressure handling, single-icon backgrounds, settings feedback and Cairo context disposal
* restore Show Apps hover labels and close the app grid on a second click
* add automated regression suites (`npm test`) and JavaScript syntax checks (`npm run check`)
* add GNOME 51 support (icon effects use Cogl snippets)
* fix GNOME 50 errors: dock item right-click menu, scroll to cycle windows
* fix leaked docks and dashes after disable/lock screen
* fix trash, downloads and mounted icons without nautilus, localized Downloads folder, several mounted volumes
* fix middle click to open a new window, scroll cycling between two windows, touchpad scrolling
* fix per-monitor docks from config.json
* fix `make g44` build
* fix preferred monitor setting placing the dock on the wrong monitor
* fix reserved screen area after moving the dock or turning off autohide
* fix autohide not hiding until a window moved, pressure sense with the dock at the top
* fix Downloads folder chooser on GNOME 42 and 43, Downloads list missing files moved in
* fix trash icon state when enabled, Empty Trash no longer opens a terminal
* open the Trash, Downloads and Documents folders instead of selecting them in their parent folder
* fix GNOME 50 overview dash errors after rearranging favorites, overview dash left hidden after disable
* load ~/.config/d2da files regardless of the working directory

# Earlier upstream releases

The following entries retain the upstream release history. Their feature and performance descriptions are historical, not measurements of the current fork.

## Release 84

* add custom config for overriding file explorer and icon size
* add background for focused icon
* add transparent background on Overview
* adjust badges and dots positions

## Release 83

* add GNOME 49 support
* Filter icon actions to current monitor

## Release 75

* add GNOME 48 support
* 2xScaling fix
* add multi-user support

## Release 65

* Blurred Backgrounds
* Custom icons

## Release 64

* Minor bug fixes

## Release 57

* GNOME 45, 46
* GNOME 42, 43, 44
* Minor bug fixes

## Release 50

* Major bug fixes

## Release 47

* Add Downloads folder with fan pullout
* Add separator with styles
* Clock styles

## Release 46

* Minor bug fixes

## Release 45

* Multi-Monitor support
* Major overhaul
* Dynamic icons improvement

## Release 43

* Fix lag. Revamped animation for faster and more resource efficient animation.
* Add bounce animation setting

## Release 40

* Fix hit areas outside of dock region

## Release 37,38,39

* Fix unresponsive Apps Button when animation is disabled
* Other bug fixes

## Release 36

* Fix tint & monochrome settings
* Improve animation icon positions

## Release 35

* GNOME 45

## Release 27

* Improved animation
* Fix startup artifacts showing prior to scaling down
* Fix Compiz Effects compatibility

## Release 21

* Fix shaking animation
* Fix bounce for zero rise settings

## Release 20

* Fix hovered icon shaking
* Fix janky resizing on hover (total dash width shaking)
* Fix labels not centering
* Fix space is showing between Apps button & icons - more prominent with vertical layouts


## Release 19

* Major refactor of the dock - Code cleanup
* Add dock position - left, right layout
* Add scrollwheel cycle windows
* Add click maximize/minimize windows
* Add opening app animation
* Add topbar text color 

## Release 16

* Add preferred monitor
* Add icon color effects
* Icon Effect: Tint
* Icon Effect: Monochrome
* Add background color effects
* Add border settings color and thickness
* Add show/hide apps icon
* Add show/hide running app icons
* Add diagnostics/tests
* Improved animation and icon scaling
* Refactor timers (use less timers)


## Release 14

* Update settings panel
* Add animation tweaks
* Tweak: peek icons
* Tweak: icon magnification
* Tweak: icons spread
* Tweak: icons rise
* Tweak: frame rate
* Add dynamic trash icon
* Add dynamic clock
* Add dynamic calendar
* Add mounted devices 
* Add border radius settings
* Add hover icon border radius settings
* Add panel mode
* Custom running window indicator style and color

## Release 12

## Features:
* Animated dash icons
* Autohide(Intellihide)
* Pressure sense
* Shrink/Scale icons
* Dark background
* Background opacity
* Topbar opacity
