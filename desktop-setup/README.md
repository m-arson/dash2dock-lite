# My GNOME desktop setup

**This desktop uses [Dash2Dock Animated by icedman](https://github.com/icedman/dash2dock-lite), with this personal fork's fixes and configuration.** icedman created the original project, design, and foundation. If you enjoy this cool project, you can **[support him on Buy Me a Coffee](https://www.buymeacoffee.com/icedman)**.

This optional profile saves the maintainer's eight extensions, their installed versions, and their current settings. It was captured on October 22, 2026, on **Debian GNU/Linux 13.7, GNOME Shell 48.7, Wayland, kernel `7.1.13+deb13-amd64`, x86_64**. It has only been used on this machine. The setup helper accepts GNOME Shell **48**; these pinned versions are not a profile for other Shell releases.

## What is included

| Extension | Saved version | Original project and authors | Version record |
| --- | --- | --- | --- |
| [AppIndicator and KStatusNotifierItem Support](https://extensions.gnome.org/extension/615/appindicator-support/) | 66 | [Ubuntu / AppIndicator contributors](https://github.com/ubuntu/gnome-shell-extension-appindicator) | [66](https://extensions.gnome.org/review/75340) |
| [Blur my Shell](https://extensions.gnome.org/extension/3193/blur-my-shell/) | 76 | [aunetx and contributors](https://github.com/aunetx/blur-my-shell) | [76](https://extensions.gnome.org/review/76770) |
| [Compiz alike magic lamp effect](https://extensions.gnome.org/extension/3740/compiz-alike-magic-lamp-effect/) | 25 | [hermes83 / Mauro Pepe](https://github.com/hermes83/compiz-alike-magic-lamp-effect) | [25](https://extensions.gnome.org/review/76122) |
| [Compiz windows effect](https://extensions.gnome.org/extension/3210/compiz-windows-effect/) | 29 | [hermes83 / Mauro Pepe](https://github.com/hermes83/compiz-windows-effect) | [29](https://extensions.gnome.org/review/67396) |
| [Coverflow Alt-Tab](https://extensions.gnome.org/extension/97/coverflow-alt-tab/) | 82 | [dsheeler and contributors](https://github.com/dsheeler/CoverflowAltTab) | [82](https://extensions.gnome.org/review/65231) |
| Dash2Dock Animated | **109, this fork** | [icedman](https://github.com/icedman/dash2dock-lite), with [m-arson's fork](https://github.com/m-arson/dash2dock-lite) | [Fork changelog](../CHANGELOG.md) |
| [User Themes](https://extensions.gnome.org/extension/19/user-themes/) | 64 | [GNOME Shell Extensions contributors](https://gitlab.gnome.org/GNOME/gnome-shell-extensions) | [64](https://extensions.gnome.org/review/63741) |
| [Vitals](https://extensions.gnome.org/extension/1460/vitals/) | 86 | [Core Coding and contributors](https://github.com/corecoding/Vitals) | [86](https://extensions.gnome.org/review/76696) |

[manifest.json](manifest.json) records the UUIDs, pinned official download URLs, versions, schema hashes, snapshot hashes, and offline archive hashes. The files in [settings/](settings/) contain **277 extension preferences**, including current default values, plus **20 selected desktop settings** covering appearance and the dock's favorite-app order. Runtime messages, detected monitor counts, and obsolete keys are excluded.

The saved appearance includes:

- The left-side animated dock and its window behavior, autohide, magnification, and optional icons.
- Blur settings for the panel, dock, overview, app folders, popups, lock screen, screenshots, window list, and Coverflow; application-window blur is disabled.
- A compact AppIndicator area on the right, with legacy tray support.
- Vitals on the right with memory, CPU, and maximum temperature, Celsius units, and a five-second refresh interval.
- Adwaita GTK, icon, and cursor themes; Cantarell 11, Monospace 11, and Adwaita Sans Bold 11 title text.
- The supplied [wallpaper](assets/wallpaper.png), centered on a solid black background, plus window buttons and clock options.

The fonts, applications, display size, and hardware also affect the result. Vitals readings and available sensors will differ on another computer. Tiling Assistant 51 was also configured on the source machine, but it is outside the requested eight extensions and is not installed or configured by this profile.

## Requirements

Run the helper as your normal user in a **GNOME 48 desktop session**, with Python **3.9 or newer**, `dconf`, and GNOME's `gnome-extensions` CLI installed. Do not run it with `sudo`. Building the fork also needs Make and zip.

For Vitals on Debian, its [upstream installation guide](https://github.com/corecoding/Vitals#installation) recommends `gir1.2-gtop-2.0` and `lm-sensors`. Install them if needed:

```sh
sudo apt install gir1.2-gtop-2.0 lm-sensors
```

GTop supplies storage statistics; temperature availability depends on the hardware and kernel sensor drivers. Some tray applications also need an AppIndicator library, as explained by the [AppIndicator project](https://github.com/ubuntu/gnome-shell-extension-appindicator#applications-dependencies).

## Restore from the complete offline bundle

Copy `dist/my-desktop-setup.tar.gz` to the new machine. It contains this profile, the helper, and the eight matching extension archives, including this fork's version 109. The third-party archives are locally repacked copies of the installed versions; their hashes are recorded in the manifest. Extract it and enter its directory:

```sh
tar -xzf my-desktop-setup.tar.gz
cd my-desktop-setup
```

Preview the installation, then apply it:

```sh
python3 tools/desktop_setup.py install --archives extensions
python3 tools/desktop_setup.py install --archives extensions --apply
```

**Log out and back in** so GNOME discovers the extensions. From the same directory, validate the installed versions and preview the settings restore:

```sh
python3 tools/desktop_setup.py check
python3 tools/desktop_setup.py restore
```

Apply the profile when the preview is correct:

```sh
python3 tools/desktop_setup.py restore --apply
```

Log out and back in once more to refresh the desktop.

## Restore from this repository

This historical GNOME 48 profile pins fork version **109**. Current `main` builds a newer dock, so use the offline bundle above or build the recorded version from its original source snapshot. From the repository root:

```sh
desktop_profile_source="$(mktemp -d)"
git archive 85c73a1 | tar -xf - -C "$desktop_profile_source"
make -C "$desktop_profile_source" publish
mkdir -p dist
cp "$desktop_profile_source/dash2dock-lite@icedman.github.com.zip" dist/dash2dock-lite-modern.zip
```

The helper uses `dist/dash2dock-lite-modern.zip` when present, or the root archive produced by `make publish`. Both must match the profile's pinned fork version and schema. For GNOME 51, use the current dock's [update instructions](../README.md#updating) instead of this GNOME 48 profile.

Preview installation, then install:

```sh
python3 tools/desktop_setup.py install
python3 tools/desktop_setup.py install --apply
```

The other seven extensions are downloaded from their pinned GNOME Extensions URLs. Installation verifies each archive's UUID, exact version, Shell compatibility, and schema hashes before installing any of them. An unavailable or mismatched version stops installation; the helper does not substitute a newer version. The original Dash2Dock store package does not contain this fork's changes.

Log out and back in, then run:

```sh
python3 tools/desktop_setup.py check
python3 tools/desktop_setup.py restore
python3 tools/desktop_setup.py restore --apply
```

Log out and back in after restoring. If the eight matching versions are already installed, start with `check` and skip installation.

## What the helper changes

`install` and `restore` are **dry runs unless you add `--apply`**. Installation dry runs do not download files. `check` validates compatibility and profile files; it does not compare your current preference values with the snapshot.

Installation replaces only missing or mismatched versions of the eight listed extensions. Restore applies their saved preferences, the selected desktop appearance keys, and favorite-app order, then enables those eight extensions. Other extensions and unrelated desktop settings retain their existing state.

The wallpaper is copied to `~/.local/share/backgrounds/dash2dock-desktop.png`. Wallpaper URLs and the dock's Downloads folder are adapted to the current user's home directory. The raw snapshots contain helper placeholders for these paths; use the helper to restore the full profile. For the dock alone, the repository's [my-custom.dconf instructions](../README.md#restore-my-custom-settings) remain available.

Before applying changes, the helper creates a timestamped backup under `~/.local/state/dash2dock-desktop/backups/` and prints its location. Installation backs up the extension directories it replaces; restore backs up the selected settings, extension enable states, and any wallpaper at the destination. If an operation fails, it attempts to restore the previous files or settings and reports any rollback problem. Keep the backup if you want to undo a successful restore later.

## Applications and icons

The saved dock order is: **Files, Brave, DBeaver, Google Chrome, Ptyxis, Geany, IntelliJ IDEA, Bruno, Packet Sender, WhatsApp Web, Microsoft Teams, Outlook**. Install these applications separately if you want the same icons. Bruno uses its Flatpak desktop ID in this snapshot.

The last three entries are Chrome web apps. Recreate those web apps on the new machine, then pin them in the desired order if Chrome assigns different desktop IDs. Browser profiles and application data are not included. A favorite whose application is missing cannot supply its icon or launch that application.

## Credits and verification

All extensions remain the work of their respective authors, linked above. The offline archives retain their original license and author notices. **icedman remains the original creator of Dash2Dock Animated**; this profile does not change that attribution. [m-arson](https://github.com/m-arson) supplied the personal configuration and desktop testing. OpenAI Codex assisted with the profile tooling, validation, and documentation; see [CONTRIBUTORS.md](../CONTRIBUTORS.md).

The version records above establish the seven official pinned releases. The download mechanism is documented by [GNOME's extension server implementation](https://github.com/GNOME/extensions-web/blob/master/sweettooth/extensions/views.py). Automated checks can verify profile integrity and helper behavior; a fresh-machine installation and the resulting visual appearance still require testing in a real GNOME desktop session.
