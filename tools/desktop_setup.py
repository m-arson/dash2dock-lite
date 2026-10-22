#!/usr/bin/env python3
"""Install or restore the checked-in personal desktop profile. Dry-run by default."""

import argparse
import configparser
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zipfile


REPO = Path(__file__).resolve().parents[1]
DEFAULT_PROFILE = REPO / "desktop-setup"
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_UNPACKED_BYTES = 250 * 1024 * 1024
DASH_UUID = "dash2dock-lite@icedman.github.com"
WALLPAPER_TOKEN = "__MY_DESKTOP_WALLPAPER_URI__"
DOWNLOADS_TOKEN = "__MY_DESKTOP_DOWNLOADS__"
ENABLE_KEYS = ("/org/gnome/shell/enabled-extensions", "/org/gnome/shell/disabled-extensions")
APPEARANCE_PREFIXES = {"/org/gnome/desktop/interface/", "/org/gnome/desktop/background/",
                       "/org/gnome/desktop/wm/preferences/", "/org/gnome/shell/"}


class SetupError(Exception):
    """A failed preflight or restore, with an actionable message."""


def run(*args, input=None):
    try:
        return subprocess.run(args, input=input, text=True, capture_output=True, check=True).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        detail = getattr(exc, "stderr", "") or str(exc)
        raise SetupError(f"{' '.join(map(str, args))}: {detail.strip()}") from exc


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def confined(root, relative):
    relative = str(relative)
    parts = PurePosixPath(relative).parts
    if not relative or "\\" in relative or relative.startswith("/") or ".." in parts:
        raise SetupError(f"Unsafe relative path: {relative!r}")
    path = (root / relative).resolve()
    if not path.is_relative_to(root.resolve()):
        raise SetupError(f"Path escapes its directory: {relative!r}")
    return path


def settings_prefix(value):
    if not isinstance(value, str) or not re.fullmatch(r"/(?:[A-Za-z0-9_.-]+/)+", value):
        raise SetupError(f"Invalid settings prefix: {value!r}")
    return value


def wallpaper_target(home, wallpaper):
    target = confined(home, wallpaper["destination"])
    # Check the lexical leaf: confined() resolves symlinks for containment.
    if (home / wallpaper["destination"]).is_symlink():
        raise SetupError(f"Refusing to overwrite a symlinked wallpaper: {home / wallpaper['destination']}")
    return target


def key_path(prefix, key):
    settings_prefix(prefix)
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9-]+", key):
        raise SetupError(f"Invalid settings key: {key!r}")
    return prefix + key


def load_profile(directory):
    directory = Path(directory).resolve()
    try:
        profile = json.loads((directory / "manifest.json").read_text())
        if profile.get("format", profile.get("format_version")) != 1:
            raise SetupError("Unsupported desktop profile format; expected format 1.")
        int(profile["tested_environment"]["shell_major"])
        seen = set()
        for ext in profile["extensions"]:
            uuid = ext["uuid"]
            if not re.fullmatch(r"[A-Za-z0-9_.+@-]+", uuid) or uuid in seen:
                raise SetupError(f"Invalid or duplicate extension UUID: {uuid!r}")
            seen.add(uuid)
            if not isinstance(ext["version"], int) or isinstance(ext["version"], bool):
                raise SetupError(f"Invalid pinned version for {uuid}")
            settings_prefix(ext["settings_path"])
            if (not ext["settings_path"].startswith("/org/gnome/shell/extensions/") or
                    ext["settings_path"] == "/org/gnome/shell/extensions/"):
                raise SetupError(f"Extension settings prefix is not scoped to one extension: {uuid}")
            confined(directory, ext["settings_file"])
            if Path(ext["archive"]).name != ext["archive"]:
                raise SetupError(f"Archive must be a filename: {ext['archive']!r}")
            if not ext.get("schemas"):
                raise SetupError(f"No settings schemas recorded for {uuid}")
            for schema in ext["schemas"]:
                settings_prefix(schema["path"])
                if not schema["path"].startswith(ext["settings_path"]):
                    raise SetupError(f"Schema path is outside {uuid}'s settings prefix")
                if not re.fullmatch(r"[0-9a-f]{64}", schema["sha256"]):
                    raise SetupError(f"Invalid schema SHA-256 for {uuid}")
        if not seen:
            raise SetupError("The desktop profile has no extensions.")
        appearance = profile["appearance"]
        if appearance["settings_path"] != "/":
            raise SetupError("Appearance settings must use root-relative sections.")
        confined(directory, appearance["settings_file"])
        for prefix, keys in appearance["keys"].items():
            if prefix not in APPEARANCE_PREFIXES:
                raise SetupError(f"Unexpected appearance settings prefix: {prefix}")
            for key in keys:
                key_path(prefix, key)
        wallpaper = profile.get("wallpaper")
        if wallpaper:
            path = confined(directory, wallpaper["file"])
            if not path.is_file() or digest(path) != wallpaper["sha256"]:
                raise SetupError("Profile wallpaper is missing or its SHA-256 does not match.")
            wallpaper_target(Path.home(), wallpaper)
        return directory, profile
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SetupError(f"Invalid desktop profile: {exc}") from exc


def shell_major():
    output = run("gnome-shell", "--version")
    match = re.search(r"(?:GNOME Shell\s+)?(\d+)\.", output)
    if not match:
        raise SetupError(f"Cannot determine GNOME Shell version from {output.strip()!r}")
    return int(match.group(1))


def require_shell(profile):
    actual = shell_major()
    expected = int(profile["tested_environment"]["shell_major"])
    if actual != expected:
        raise SetupError(f"This desktop profile was tested on GNOME {expected}; detected GNOME {actual}.")
    return expected


def extension_root(home):
    # GNOME also supports XDG_DATA_HOME; preserve that on the same machine.
    data = Path(os.environ.get("XDG_DATA_HOME", str(home / ".local/share"))).expanduser()
    return data / "gnome-shell/extensions"


def schema_filename(schema):
    filename = schema["file"]
    return filename if "/" in filename else "schemas/" + filename


def installed_issues(ext, root, major):
    location = root / ext["uuid"]
    try:
        metadata = json.loads((location / "metadata.json").read_text())
        if (metadata.get("uuid") != ext["uuid"] or type(metadata.get("version")) is not int or
                metadata["version"] != ext["version"]):
            return [f"{ext['name']}: install pinned version {ext['version']}"]
        if str(major) not in list(map(str, metadata.get("shell-version", []))):
            return [f"{ext['name']}: installed metadata does not support GNOME {major}"]
        issues = []
        for filename, expected in {(schema_filename(s), s["sha256"]) for s in ext["schemas"]}:
            path = confined(location, filename)
            if not path.is_file() or digest(path) != expected:
                issues.append(f"{ext['name']}: schema source mismatch: {filename}")
        return issues
    except (OSError, ValueError) as exc:
        return [f"{ext['name']}: not installed or metadata unreadable ({exc})"]


def parse_dconf(text):
    parser = configparser.ConfigParser(interpolation=None, strict=True, delimiters=("=",),
                                       comment_prefixes=("#", ";"), inline_comment_prefixes=None)
    parser.optionxform = str
    try:
        parser.read_string(text)
        if parser.defaults():
            raise SetupError("DEFAULT sections are not permitted in a settings snapshot.")
        return {section: dict(parser.items(section)) for section in parser.sections()}
    except configparser.Error as exc:
        raise SetupError(f"Invalid dconf snapshot: {exc}") from exc


def validate_snapshot(path, prefix, allowed, excluded=()):
    text = path.read_text()
    sections = parse_dconf(text)
    if not sections:
        raise SetupError(f"Settings snapshot is empty: {path}")
    for section, values in sections.items():
        if section == "/":
            section_prefix = prefix
        else:
            if section.startswith("/") or ".." in PurePosixPath(section).parts or "\\" in section:
                raise SetupError(f"Unsafe dconf section: {section!r}")
            section_prefix = prefix + section.rstrip("/") + "/"
        for key, value in values.items():
            full_key = key_path(section_prefix, key)
            relative = full_key[len(prefix):]
            if full_key not in allowed or key in excluded or relative in excluded:
                raise SetupError(f"Snapshot contains an unapproved settings key: {full_key}")
            if not value:
                raise SetupError(f"Empty GVariant value in {path}: {full_key}")
    return text


def extension_allowed_keys(ext, root):
    allowed = set()
    for schema in ext["schemas"]:
        try:
            document = ET.parse(confined(root / ext["uuid"], schema_filename(schema)))
            matching = [s for s in document.getroot().findall("schema")
                        if s.get("id") == schema["id"] and s.get("path") == schema["path"]]
            if len(matching) != 1:
                raise SetupError(f"Schema ID/path mismatch for {schema['id']}")
            allowed.update(key_path(schema["path"], key.get("name")) for key in matching[0].findall("key"))
        except (OSError, ET.ParseError) as exc:
            raise SetupError(f"Cannot read schema {schema['id']}: {exc}") from exc
    return allowed


def appearance_keys(profile):
    return {key_path(prefix, key) for prefix, keys in profile["appearance"]["keys"].items() for key in keys}


def downloads_directory(home):
    try:
        output = run("xdg-user-dir", "DOWNLOAD").strip()
        if output and Path(output).is_absolute():
            return output
    except SetupError:
        pass
    return str(home / "Downloads")


def variant_string(value):
    # GVariant strings accept single quotes, with backslash escaping.
    return "'" + str(value).replace("\\", "\\\\").replace("'", "\\'") + "'"


def substitute(text, home, wallpaper):
    # Tokens occupy an entire quoted string, so paths containing quotes remain valid.
    replacements = {DOWNLOADS_TOKEN: downloads_directory(home)}
    if wallpaper:
        replacements[WALLPAPER_TOKEN] = wallpaper.as_uri()
    for token, value in replacements.items():
        for quote in ("'", '"'):
            text = text.replace(quote + token + quote, variant_string(value))
    if WALLPAPER_TOKEN in text or DOWNLOADS_TOKEN in text:
        raise SetupError("Unresolved or incorrectly quoted settings placeholder.")
    return text


def validated_settings(directory, profile, root, home):
    wallpaper = wallpaper_target(home, profile["wallpaper"]) if profile.get("wallpaper") else None
    documents = []
    for ext in profile["extensions"]:
        path = confined(directory, ext["settings_file"])
        if ext.get("settings_sha256") and digest(path) != ext["settings_sha256"]:
            raise SetupError(f"Settings snapshot SHA-256 does not match: {path.name}")
        text = validate_snapshot(path, ext["settings_path"],
                                 extension_allowed_keys(ext, root), ext.get("excluded_keys", []))
        documents.append((ext["settings_path"], substitute(text, home, wallpaper)))
    appearance = profile["appearance"]
    path = confined(directory, appearance["settings_file"])
    if appearance.get("settings_sha256") and digest(path) != appearance["settings_sha256"]:
        raise SetupError(f"Settings snapshot SHA-256 does not match: {path.name}")
    text = validate_snapshot(path, "/", appearance_keys(profile))
    documents.append(("/", substitute(text, home, wallpaper)))
    return documents


def validate_archive(path, ext, major):
    if path.stat().st_size > MAX_ARCHIVE_BYTES:
        raise SetupError(f"Archive exceeds size limit: {path.name}")
    try:
        with zipfile.ZipFile(path) as bundle:
            seen, total = set(), 0
            for item in bundle.infolist():
                name = item.filename
                mode = item.external_attr >> 16
                if (name in seen or name.startswith("/") or "\\" in name or
                        ".." in PurePosixPath(name).parts or "\x00" in name or stat.S_ISLNK(mode)):
                    raise SetupError(f"Unsafe ZIP entry: {name!r}")
                seen.add(name)
                total += item.file_size
                if total > MAX_UNPACKED_BYTES:
                    raise SetupError(f"Unpacked archive exceeds size limit: {path.name}")
            metadata_item = bundle.getinfo("metadata.json")
            if metadata_item.file_size > 1024 * 1024:
                raise SetupError("Archive metadata exceeds size limit.")
            metadata = json.loads(bundle.read("metadata.json"))
            if (metadata.get("uuid") != ext["uuid"] or type(metadata.get("version")) is not int or
                    metadata["version"] != ext["version"]):
                raise SetupError(f"Archive must contain {ext['uuid']} version {ext['version']}: {path.name}")
            if str(major) not in list(map(str, metadata.get("shell-version", []))):
                raise SetupError(f"Archive {path.name} does not declare GNOME {major} support.")
            for schema in ext["schemas"]:
                filename = schema_filename(schema)
                if hashlib.sha256(bundle.read(filename)).hexdigest() != schema["sha256"]:
                    raise SetupError(f"Archive schema differs from saved profile: {filename}")
            bad = bundle.testzip()
            if bad:
                raise SetupError(f"Corrupt ZIP entry: {bad}")
    except (OSError, ValueError, KeyError, zipfile.BadZipFile, RuntimeError) as exc:
        raise SetupError(f"Invalid extension archive {path}: {exc}") from exc


def source_for(ext, archives):
    if archives:
        source = confined(Path(archives).resolve(), ext["archive"])
        if not source.is_file():
            raise SetupError(f"Missing pinned archive: {source}")
        if ext.get("archive_sha256") and digest(source) != ext["archive_sha256"]:
            raise SetupError(f"Offline archive SHA-256 does not match the saved profile: {source}")
        return source
    if ext["uuid"] == DASH_UUID:
        for source in (REPO / "dist/dash2dock-lite-modern.zip", REPO / (DASH_UUID + ".zip")):
            if source.is_file():
                return source
        raise SetupError("Build this fork first (make publish), or provide its archive with --archives DIR.")
    url = ext.get("download_url", "")
    parsed = urllib.parse.urlparse(url)
    query = urllib.parse.parse_qs(parsed.query)
    if (parsed.scheme != "https" or not parsed.netloc or not query.get("version_tag") or
            "shell_version" in query):
        raise SetupError(f"No HTTPS download pinned by version_tag for {ext['name']}; provide --archives DIR.")
    return url


def download(url, destination):
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Dash2Dock-personal-desktop-setup/1"})
        with urllib.request.urlopen(request, timeout=60) as response, destination.open("wb") as output:
            total = 0
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ARCHIVE_BYTES:
                    raise SetupError("Downloaded extension exceeds size limit.")
                output.write(chunk)
    except OSError as exc:
        raise SetupError(f"Cannot download pinned extension: {url}: {exc}") from exc


def backup_directory(home):
    parent = home / ".local/state/dash2dock-desktop/backups"
    parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory = Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime("%Y%m%d-%H%M%S-"), dir=parent))
    directory.chmod(0o700)
    return directory


def remove_tree(path):
    if path.is_symlink() or path.is_file():
        path.unlink()
    elif path.exists():
        shutil.rmtree(path)


def install(directory, profile, root, home, apply=False, archives=None):
    major = require_shell(profile)
    pending = [ext for ext in profile["extensions"] if installed_issues(ext, root, major)]
    if not pending:
        print("All pinned extensions and schema sources are already installed.")
        return
    sources = [(ext, source_for(ext, archives)) for ext in pending]
    for ext, source in sources:
        if isinstance(source, Path):
            validate_archive(source, ext, major)
        print(f"Install {ext['name']} {ext['version']} from {source}")
    if not apply:
        print("Dry-run: no downloads, installations, or settings changes. Add --apply to install.")
        return
    with tempfile.TemporaryDirectory(prefix="dash2dock-pinned-extensions-") as temporary:
        bundles = []
        for ext, source in sources:
            target = Path(temporary) / ext["archive"]
            if isinstance(source, Path):
                shutil.copy2(source, target)
            else:
                download(source, target)
            validate_archive(target, ext, major)
            bundles.append((ext, target))
        # Every bundle is validated before making a backup or installing the first one.
        backup = backup_directory(home)
        originals = []
        for ext, _ in bundles:
            location = root / ext["uuid"]
            saved = backup / ext["uuid"]
            existed = location.exists() or location.is_symlink()
            if existed:
                if location.is_symlink():
                    raise SetupError(f"Refusing to replace a symlinked extension: {location}")
                shutil.copytree(location, saved, symlinks=True)
            originals.append((location, saved, existed))
        (backup / "install.json").write_text(json.dumps({"extensions": [ext["uuid"] for ext, _ in bundles]}, indent=2) + "\n")
        try:
            for ext, bundle in bundles:
                run("gnome-extensions", "install", "--force", str(bundle))
                issues = installed_issues(ext, root, major)
                if issues:
                    raise SetupError("; ".join(issues))
        except Exception as exc:
            errors = []
            for location, saved, existed in originals:
                try:
                    remove_tree(location)
                    if existed:
                        shutil.copytree(saved, location, symlinks=True)
                except OSError as rollback_exc:
                    errors.append(str(rollback_exc))
            suffix = f" Rollback errors: {'; '.join(errors)}" if errors else " Existing extension files restored."
            raise SetupError(f"Installation failed: {exc}.{suffix} Backup: {backup}") from exc
        print(f"Installed pinned versions. Backup: {backup}")
        print("Log out and back in so GNOME discovers them, then run restore --apply.")


def read_key(path):
    return run("dconf", "read", path).strip()


def write_key(path, value):
    if value:
        run("dconf", "write", path, value)
    else:
        run("dconf", "reset", path)


def restore(directory, profile, root, home, apply=False):
    major = require_shell(profile)
    issues = [issue for ext in profile["extensions"] for issue in installed_issues(ext, root, major)]
    if issues:
        raise SetupError("Restore preflight failed; run install first:\n" + "\n".join(issues))
    if read_key("/org/gnome/shell/disable-user-extensions") == "true":
        raise SetupError("GNOME extensions are globally disabled. Turn them on in the Extensions app, then retry restore.")
    documents = validated_settings(directory, profile, root, home)
    print(f"Restore {len(profile['extensions'])} pinned extension settings and selected appearance keys.")
    if not apply:
        print("Dry-run: no settings or extension enable states changed. Add --apply to restore.")
        return
    backup = backup_directory(home)
    dumps = []
    for index, ext in enumerate(profile["extensions"]):
        text = run("dconf", "dump", ext["settings_path"])
        (backup / f"extension-{index}.dconf").write_text(text)
        dumps.append((ext["settings_path"], text))
    keys = {key: read_key(key) for key in sorted(appearance_keys(profile) | set(ENABLE_KEYS))}
    (backup / "appearance-and-enable-keys.json").write_text(json.dumps(keys, indent=2) + "\n")
    wallpaper = profile.get("wallpaper")
    target = wallpaper_target(home, wallpaper) if wallpaper else None
    existed = bool(target and target.exists())
    if existed:
        shutil.copy2(target, backup / "wallpaper-original")
    (backup / "restore.json").write_text(json.dumps({"wallpaper": str(target) if target else None,
                                                    "wallpaper_existed": existed,
                                                    "settings_paths": [path for path, _ in dumps]}, indent=2) + "\n")
    try:
        if wallpaper:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(confined(directory, wallpaper["file"]), target)
        for prefix, text in documents:
            run("dconf", "load", prefix, input=text)
        for ext in profile["extensions"]:
            run("gnome-extensions", "enable", ext["uuid"])
    except Exception as exc:
        errors = []
        for prefix, text in dumps:
            try:
                run("dconf", "reset", "-f", prefix)
                if text.strip():
                    run("dconf", "load", prefix, input=text)
            except SetupError as rollback_exc:
                errors.append(str(rollback_exc))
        for key, value in keys.items():
            try:
                write_key(key, value)
            except SetupError as rollback_exc:
                errors.append(str(rollback_exc))
        try:
            if target:
                if existed:
                    shutil.copy2(backup / "wallpaper-original", target)
                elif target.exists():
                    target.unlink()
        except OSError as rollback_exc:
            errors.append(str(rollback_exc))
        suffix = f" Rollback errors: {'; '.join(errors)}" if errors else " Previous settings and wallpaper restored."
        raise SetupError(f"Restore failed: {exc}.{suffix} Backup: {backup}") from exc
    print(f"Desktop profile restored; unrelated settings and enabled extensions retained. Backup: {backup}")
    print("Log out and back in to refresh the desktop.")


def check(directory, profile, root, home):
    major = require_shell(profile)
    issues = [issue for ext in profile["extensions"] for issue in installed_issues(ext, root, major)]
    if issues:
        raise SetupError("\n".join(issues))
    validated_settings(directory, profile, root, home)
    print(f"Profile is ready: GNOME {major}, all {len(profile['extensions'])} pinned versions, schema hashes and settings validated.")
    print("This checks compatibility and profile files; it does not change settings or compare current values.")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check", "install", "restore"))
    parser.add_argument("--profile", type=Path, default=DEFAULT_PROFILE)
    parser.add_argument("--apply", action="store_true", help="perform installation or restore (default: dry-run)")
    parser.add_argument("--archives", type=Path, help="offline directory of exact pinned UUID.shell-extension.zip bundles")
    args = parser.parse_args(argv)
    try:
        directory, profile = load_profile(args.profile)
        home = Path.home()
        root = extension_root(home)
        if args.command == "install":
            install(directory, profile, root, home, args.apply, args.archives)
        elif args.command == "restore":
            restore(directory, profile, root, home, args.apply)
        else:
            check(directory, profile, root, home)
        return 0
    except (SetupError, OSError) as exc:
        print(f"desktop-setup: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
