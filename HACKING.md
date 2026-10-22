# Contributing and local development

Work on `main`; this fork uses a single maintained branch. Read [DESIGN.md](DESIGN.md) before changing rendering, activation, or lifecycle code. Use [ERRORS.md](ERRORS.md) to collect a reproducible desktop failure.

## Checks

The checks require Node.js 18 or newer, GJS, Python 3.9 or newer, Make, GLib schema tools, zip, and unzip. No npm dependencies are required for the test or syntax scripts.

```sh
npm test
npm run check
glib-compile-schemas --strict --dry-run schemas
```

`npm test` discovers the Node `.mjs` suites and runs the three selected GJS lifecycle/drag suites. Packaging and upgrade checks operate in temporary directories. `npm run check` parses JavaScript; it does not lint or execute the GNOME UI. See [tests/README.md](tests/README.md) for scope and focused commands.

## Build archives

Modern and legacy targets write the same archive filename and recreate `build/`. Copy the first archive before building the second:

```sh
mkdir -p dist
make publish
cp dash2dock-lite@icedman.github.com.zip dist/dash2dock-lite-modern.zip
make publish-g44
cp dash2dock-lite@icedman.github.com.zip dist/dash2dock-lite-legacy.zip
```

The modern archive declares Shell 46–51. The legacy archive declares 42–44 and uses `tools/transpile.py` plus the legacy entry points in `tools/imports_extension.js` and `tools/imports_prefs.js`. Keep new JavaScript compatible with that conversion. Build outputs under `build/`, `dist/`, and ZIP archives are ignored by Git.

`make publish` and `make publish-g44` package local archives; they do not upload a release or install the extension. `make build` compiles the settings schema. `make install` and `make g44` replace the user extension files; the default `make` target also installs and runs a separately installed ESLint. For preference-preserving upgrades, use the helper in [README.md](README.md) instead.

## Desktop development

Use a disposable GNOME session for changes to actors, input, menus, or teardown. Install the matching archive, log out/in to load changed Shell code, and open preferences with:

```sh
gnome-extensions prefs dash2dock-lite@icedman.github.com
```

Watch the Shell journal as described in [ERRORS.md](ERRORS.md). On Wayland, logging out/in is needed to replace already loaded extension modules. Disabling and re-enabling is useful for lifecycle tests and reloading custom configuration, but does not reliably load changed source modules.

Run nested Shell sessions only with flags supported by the installed Shell version. The existing `test-shell*` Make targets install into the user's extension directory and contain host-specific session cleanup; inspect them before use. They are not isolated automated tests.

The scripts under `tests/` outside the automated runner include graphical experiments. Inspect a script's imports and purpose before running it; old deep-private panel or overview paths are not stable APIs.

## Change and release review

- Add a regression when changing a failure-prone behavior such as actor ownership, activation, timer cleanup, or async ordering. Verify the reported trigger rather than duplicating the implementation in a test.
- Keep single-window toggling, thumbnail selection, Show Desktop restoration, native modifiers, magnified hit targets, and edge reveal consistent when changing nearby code.
- Check settings keys in `preferences/keys.js` and `schemas/` together. The update helper intentionally refuses schema changes; migrations need separate review.
- Review all relevant Markdown, increment `metadata.json` when preparing a release, and record the final behavior in [CHANGELOG.md](CHANGELOG.md). Extension versions come from `metadata.json`, not the older npm package version.
- Complete [CHECKLIST.md](CHECKLIST.md) and record what was tested. Build success and declared Shell targets do not establish rendering, compatibility, or measured performance.
- Review the diff before committing and use a normal push to `main`. Packaging does not imply that code is installed or published remotely.
