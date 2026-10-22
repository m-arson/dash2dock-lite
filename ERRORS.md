# Troubleshooting and diagnostic reports

This is a troubleshooting guide, not a list of unresolved errors. Previous activation, autohide, magnified-input, and lifecycle fixes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Establish the running version

```sh
gnome-shell --version
gnome-extensions info dash2dock-lite@icedman.github.com
```

Record the distribution, Wayland/X11 session, extension version, dock position, enabled integrations, monitor arrangement, and scaling. If files were just updated, log out/in before reproducing: installed files and already loaded Shell modules can have different versions. On Shell 42–44, use the legacy archive; the modern archive declares 46–51.

## Capture a focused Shell log

Start this in a terminal, reproduce the issue once, and copy the relevant messages plus their timestamps:

```sh
journalctl /usr/bin/gnome-shell -f -o cat
```

For a report, describe the exact starting state and pointer/click/key sequence. Include whether windows were focused, minimized, on another workspace/monitor, or hidden by Show Desktop. Screenshots help with geometry or preview problems; the log helps with exceptions and teardown failures. When checking an extension conflict, repeat with unrelated extensions disabled and record the difference.

## Common checks

| Symptom | Check |
| --- | --- |
| Update appears to have no effect | Confirm installed version and log out/in to reload source modules. For helper installs, inspect its backup `manifest.json`. |
| Extension will not enable | Confirm the archive's Shell targets match the desktop and inspect the first enable error in the journal. |
| Enlarged icons miss clicks or zoom stays enlarged | Reproduce at the same dock edge and scaling; include the click point outside the frame and whether the pointer moved away immediately. |
| Hidden dock reveals before reaching the edge | Record pressure sense, fullscreen/overlap state, and whether it occurs immediately after hiding. Include the monitor's dock edge and scaling. |
| App does not return after Show Desktop | Record the shortcut, number of app windows, workspace/monitor, and whether a second click behaves differently. Normal selection should activate one window. |
| Preview displays an app icon | This is the fallback when a compositor surface is missing or has invalid dimensions. Report the app/window state if it persists for an ordinary visible window. |
| Previews block other icons or shrink their source while browsing | Version 107 keeps previews dismissible without a selection and retains source zoom. Include the dock edge, scaling, exact pointer path, input type, and whether the first click on another icon is delivered. |
| Blur is absent or misplaced | Confirm Blur My Shell and its Dash to Dock integration are enabled, along with this dock's blur setting. Record both extension versions and enable order. |
| Custom icons, CSS, or config are ignored | Check JSON syntax, the documented `~/.config/d2da/` paths, and disable/re-enable after editing. App-icon keys omit `.desktop`. |
| Show Apps cannot move to the front on a vertical dock | This remains a layout limitation; the front-position option applies to horizontal docks. |

## Performance reports

Measure the same desktop workload before and after a change: idle, stationary hover, repeated hover/pullout actions, menu open/close, and lock/unlock. Record the measurement duration, Shell PID, other enabled extensions, open apps, scaling, and CPU/RAM observations. `top -d 0.5` is one way to monitor the Shell process.

Whole-Shell CPU or RSS includes other Shell features and extensions. Regression tests check resource lifetimes and operation counts; they cannot demonstrate a live GPU, CPU, or memory improvement by themselves.

## Update helper failures

The helper in `tools/apply_update.py` prints its backup path and writes `manifest.json`. A failed install should report `rolled_back` when the previous files and extension settings were restored. Keep the backup and the full error if it reports `rollback_failed`.

The helper requires an existing nonsymlink installation and an unchanged settings schema. A refusal before installation does not mean the extension code failed. Review schema migrations separately, and keep custom configuration and preference backups outside the installed extension directory. See [README.md](README.md) for the supported update command.
