# Dash2Dock Animated

An animated desktop dock targeting GNOME Shell 46–51, based on [icedman's Dash2Dock Animated](https://github.com/icedman/dash2dock-lite). This fork is maintained on the `main` branch.

[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/icedman)

![Screen Shot](https://raw.githubusercontent.com/icedman/dash2dock-lite/main/screenshots/Screenshot%20from%202024-03-19%2015-31-27.png)

## Current Version

Version **108** includes:

* Right-click menus open toward the desktop beside the clicked icon: right of a left dock, left of a right dock, below a top dock, and above a bottom dock. Menus follow the icon's magnified position, including custom launchers.
* Freely dismissible previews: the source icon stays zoomed while you browse its previews. Move to another icon or away from the dock, click elsewhere, press Escape, or click the source icon again to dismiss without selecting a window. Clicking another icon works immediately.
* A thumbnail chooser for apps with multiple windows: click the active app to see small window previews with titles, then select one to activate only that window. Right-click retains GNOME's app actions.
* Reliable restore after Show Desktop or minimizing all windows: clicking an app activates one window through GNOME's normal window activation path.
* Reliable edge reveal after autohiding: moving into the dock's former on-screen area during the hide animation no longer opens it before you reach the screen edge.
* Single-window toggling: click an app to focus or restore its window, then click it again while focused to minimize that window.
* Multi-window selection: click an app to focus its most recently used unminimized eligible window, or restore one window if all are minimized. Click the active app again to open the thumbnail chooser; click again to dismiss it.
* Scrollwheel cycling that restores only the selected window and leaves minimized siblings alone. Hold Ctrl while scrolling to stay on the current workspace.
* Native Ctrl-click and middle-click actions for opening a new window, right-click app actions, and custom folder launchers.
* Click targets that follow enlarged icons beyond the dock frame, and zoom recovery when leaving after a click.
* Updated Blur My Shell integration, live settings updates, favorite reordering, and reduced idle animation and resource use.

These window actions are this fork's GNOME dock policy. Monitor filtering applies to click and scroll selection; the chooser and right-click app menu retain the app-wide window list. Opening previews leaves other icons and windows available and does not move keyboard focus. Preview resources are released when the chooser closes, and unavailable window surfaces show the app icon. Minimized windows remain minimized while their previews are displayed; their last available compositor contents may be shown. See the [changelog](CHANGELOG.md) for the full change list.

## Compatibility

* The modern package declares GNOME Shell **46, 47, 48, 49, 50, and 51** support.
* GNOME Shell **42, 43, and 44** use the separate [legacy build](#gnome-shell-42-44).
* Other Shell versions are not covered by these build targets. Declared compatibility still requires testing in the target desktop session.
* Integrations include Compiz Magic Lamp Animation and Blur My Shell.

The Show Apps button can be placed at the front of horizontal docks. This option is not implemented for vertical docks.

## Features

* Animated, resizable dock icons and multi-monitor support
* Bottom, top, left, and right dock positions
* Autohide/intellihide and panel mode
* Window thumbnails, scrollwheel cycling, single-window toggling, and native app menus
* Favorite reordering and an optional Show Apps button
* Analog clock, dynamic calendar and Trash icons, mounted devices, and a Downloads fan
* Top panel styling, icon tint/monochrome effects, themes, and custom icons

## Installation

Build requirements are Git, Make, zip, GNOME's `gnome-extensions` CLI, and GLib schema tools. Run installation commands in your normal desktop session.

Clone this fork and build the modern extension archive:

```sh
git clone --branch main https://github.com/m-arson/dash2dock-lite.git
cd dash2dock-lite
make publish
```

For a **new installation**:

```sh
gnome-extensions install dash2dock-lite@icedman.github.com.zip
```

Log out and back in so GNOME Shell discovers the extension, then enable it through the Extensions app or:

```sh
gnome-extensions enable dash2dock-lite@icedman.github.com
```

### Updating an Existing Installation

For an existing installation, build the archive with `make publish`, then use the update helper. It requires Python 3.9 or newer, `dconf`, and `gnome-extensions`:

```sh
python3 tools/apply_update.py dash2dock-lite@icedman.github.com.zip \
  --backup-root "$HOME/.local/share/dash2dock-lite-backups"
```

The helper backs up installed files, extension preferences, custom configuration, and relevant Shell settings. It validates the archive, verifies installed files and preserved extension preferences, and restores the previous installation and preferences if installation fails. It prints the backup location and records the result in `manifest.json` there.

This helper requires an existing extension directory that is not a symlink and an unchanged settings schema. A schema change requires a reviewed migration. Log out and back in after a successful update to load the new code.

For direct development installation, `make build` compiles schemas and `make install` copies the working tree into the user extension directory. The default `make` target also installs the extension and runs ESLint, which must be installed separately. For development and release commands, see [HACKING.md](HACKING.md).

### Other Distribution Channels

The [GNOME Extensions listing](https://extensions.gnome.org/extension/4994/dash2dock-lite/) and the [Arch AUR package](https://aur.archlinux.org/packages/gnome-shell-extension-dash2dock-lite) distribute upstream versions; they may not include this fork's changes.

## Theme Support

Export settings through **Style > Themes > Export**. The preferences window reports the output path, `/tmp/<username>-theme.json`.

Edit the JSON and save it with a `.json` extension under `~/.config/d2da/themes/`. Bundled themes live under `<extension_path>/themes/`. Reopen preferences to load newly added themes.

## Custom Icons

Create `~/.config/d2da/icons/` for SVG icons and map them in `~/.config/d2da/icons.json`:

```json
{
  "icons": {
    "view-app-grid-symbolic": "icons/show-apps-icon.svg",
    "user-trash": "icons/my-own-trash.svg",
    "user-trash-full": "icons/my-own-trash-full.svg"
  }
}
```

Paths are relative to `~/.config/d2da/`. You can also use names from your installed icon theme:

```json
{
  "icons": {
    "view-app-grid-symbolic": "show-apps-icon",
    "user-trash": "trash",
    "user-trash-full": "trash-full"
  }
}
```

The named icons must exist in your icon theme. To override an application icon, use its desktop-file ID with the `.desktop` suffix removed:

```json
{
  "apps": {
    "spotify_spotify": "icons/spotify.svg"
  }
}
```

Disable and re-enable the extension after changing custom icons.

## Custom Config

Create `~/.config/d2da/config.json`:

```json
{
  "file-explorer": "nemo",
  "icon-size": 24
}
```

* `file-explorer` supplies a preferred folder-opening command. Without an override, the extension tries `nautilus`, `xdg-open`, then `gio open`.
* `icon-size` overrides the icon size from preferences with a positive numeric value.
* Disable and re-enable the extension to reload the file.

## Custom CSS

Create `~/.config/d2da/style.css` and disable/re-enable the extension to load it. Use GNOME Shell's Looking Glass inspector to find actor names and style classes.

## Blurred Background

Dock background blur uses **Blur My Shell**. Install and enable that extension, enable its Dash to Dock integration, and enable this dock's blurred-background preference. The integration supports older blur geometry hooks and newer signal-driven dock surfaces. ImageMagick is not required.

## GNOME Shell 42-44

Legacy transpilation also requires Python 3. Build a legacy archive without installing it:

```sh
make publish-g44
```

Install the generated `dash2dock-lite@icedman.github.com.zip` using the GNOME CLI instructions above. For an existing installation, the update helper applies only when its settings schema matches.

For direct legacy development installation:

```sh
make g44
```

Log out and back in after replacing installed extension code.

## Development and Testing

Development uses `main`. The automated checks require Node.js 18 or newer, GJS, Python 3.9 or newer, Make, GLib schema tools, zip, and unzip:

```sh
npm test
npm run check
glib-compile-schemas --strict --dry-run schemas
```

See [tests/README.md](tests/README.md) for regression coverage and [CHECKLIST.md](CHECKLIST.md) for desktop release checks. [DESIGN.md](DESIGN.md) describes the current modules and lifecycle contracts. Automated tests cover activation, magnified input, zoom exit handling, lifecycle cleanup, settings, packaging, and upgrade rollback. Live compositor input, Shell compatibility, rendering, CPU use, and RAM use require verification in a GNOME desktop session.

## Bug Reporting

See [ERRORS.md](ERRORS.md) for troubleshooting and collecting diagnostics. Include:

* Distribution and version
* GNOME Shell version and Wayland/X11 session type
* Dash2Dock Animated version, dock position, and display scaling
* Steps to reproduce, relevant settings, and screenshots when useful
* Other enabled extensions, especially integrations

Watch the Shell journal for errors:

```sh
journalctl /usr/bin/gnome-shell -f -o cat
```

When investigating an extension conflict, repeat the steps with other extensions disabled. For performance reports, compare idle and stationary-hover CPU and memory before and after repeated hover, menu, and lock/unlock cycles. You can monitor the Shell process with:

```sh
top -d 0.5
```

## License and Attribution

Originally authored by **icedman**. This fork retains the upstream project's attribution and donation link. Distributed under the **GPL 3.0 License**; see [LICENSE](LICENSE).
