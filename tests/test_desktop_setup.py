"""Offline regression tests; no commands, network, or live desktop settings are used."""

import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import zipfile


SPEC = importlib.util.spec_from_file_location("desktop_setup", Path(__file__).resolve().parents[1] / "tools/desktop_setup.py")
setup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup)


class FakeDesktop:
    def __init__(self, test):
        self.test = test
        self.calls = []
        self.values = {"/org/gnome/shell/enabled-extensions": "['unrelated@example.com']",
                       "/org/gnome/shell/disabled-extensions": "['disabled@example.com']",
                       "/org/gnome/desktop/interface/color-scheme": "'default'"}
        self.fail_load = None
        self.fail_enable = False

    def run(self, *args, input=None):
        self.calls.append((args, input))
        if args == ("gnome-shell", "--version"):
            return "GNOME Shell 48.4\n"
        if args == ("xdg-user-dir", "DOWNLOAD"):
            return str(self.test.home / "My Downloads") + "\n"
        if args[:2] == ("dconf", "dump"):
            prefix = args[2]
            values = {key[len(prefix):]: value for key, value in self.values.items() if key.startswith(prefix)}
            return "[/]\n" + "".join(f"{key}={value}\n" for key, value in values.items()) if values else ""
        if args[:2] == ("dconf", "read"):
            return self.values.get(args[2], "") + "\n"
        if args[:2] == ("dconf", "write"):
            self.values[args[2]] = args[3]
            return ""
        if args[:2] == ("dconf", "reset"):
            if args[2] == "-f":
                self.values = {key: value for key, value in self.values.items() if not key.startswith(args[3])}
            else:
                self.values.pop(args[2], None)
            return ""
        if args[:2] == ("dconf", "load"):
            if self.fail_load == args[2]:
                self.fail_load = None
                raise setup.SetupError("injected load failure")
            for section, values in setup.parse_dconf(input).items():
                prefix = args[2] if section == "/" else args[2] + section + "/"
                for key, value in values.items():
                    self.values[prefix + key] = value
            return ""
        if args[:2] == ("gnome-extensions", "enable"):
            if self.fail_enable:
                self.fail_enable = False
                raise setup.SetupError("injected enable failure")
            old = self.values[setup.ENABLE_KEYS[0]]
            self.values[setup.ENABLE_KEYS[0]] = old[:-1] + ", '" + args[2] + "']"
            return ""
        if args[:2] == ("gnome-extensions", "install"):
            with zipfile.ZipFile(args[3]) as bundle:
                metadata = json.loads(bundle.read("metadata.json"))
                destination = self.test.root / metadata["uuid"]
                if destination.exists():
                    setup.remove_tree(destination)
                bundle.extractall(destination)
            return ""
        raise AssertionError(f"Unexpected command: {args}")


class DesktopSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.home = self.base / "home"
        self.home.mkdir()
        self.directory = self.base / "profile"
        (self.directory / "settings").mkdir(parents=True)
        (self.directory / "assets").mkdir()
        self.root = self.home / ".local/share/gnome-shell/extensions"
        self.root.mkdir(parents=True)
        self.archives = self.base / "archives"
        self.archives.mkdir()
        wallpaper = self.directory / "assets/wallpaper.png"
        wallpaper.write_bytes(b"profile wallpaper")
        self.extensions = []
        for number in (1, 2):
            uuid = f"extension{number}@example.com"
            prefix = f"/org/gnome/shell/extensions/example{number}/"
            schema_id = f"org.gnome.shell.extensions.example{number}"
            schema_file = "schemas/" + schema_id + ".gschema.xml"
            schema = (f'<schemalist><schema id="{schema_id}" path="{prefix}">'
                      '<key name="enabled" type="b"><default>true</default></key>'
                      '<key name="downloads-path" type="s"><default>""</default></key>'
                      '<key name="runtime-message" type="s"><default>""</default></key>'
                      '</schema></schemalist>').encode()
            location = self.root / uuid
            (location / "schemas").mkdir(parents=True)
            (location / schema_file).write_bytes(schema)
            (location / "metadata.json").write_text(json.dumps({"uuid": uuid, "version": number, "shell-version": ["48"]}))
            settings_file = f"settings/{uuid}.dconf"
            (self.directory / settings_file).write_text("[/]\nenabled=false\ndownloads-path='__MY_DESKTOP_DOWNLOADS__'\n")
            self.extensions.append({"uuid": uuid, "name": f"Extension {number}", "version": number,
                                    "shell_versions": ["48"], "archive": uuid + ".shell-extension.zip",
                                    "download_url": f"https://extensions.gnome.org/download-extension/{uuid}.shell-extension.zip?version_tag={100 + number}",
                                    "settings_file": settings_file, "settings_path": prefix,
                                    "schemas": [{"id": schema_id, "path": prefix, "file": schema_file,
                                                 "sha256": hashlib.sha256(schema).hexdigest()}],
                                    "excluded_keys": ["runtime-message"]})
        (self.directory / "settings/appearance.dconf").write_text(
            "[org/gnome/desktop/interface]\ncolor-scheme='prefer-dark'\n\n"
            "[org/gnome/desktop/background]\npicture-uri='__MY_DESKTOP_WALLPAPER_URI__'\n\n"
            "[org/gnome/shell]\nfavorite-apps=['example.desktop']\n")
        self.profile = {"format": 1, "tested_environment": {"shell_major": 48}, "extensions": self.extensions,
                        "appearance": {"settings_path": "/", "settings_file": "settings/appearance.dconf",
                                       "paths": ["/org/gnome/desktop/interface/", "/org/gnome/desktop/background/", "/org/gnome/shell/"],
                                       "keys": {"/org/gnome/desktop/interface/": ["color-scheme"],
                                                "/org/gnome/desktop/background/": ["picture-uri"],
                                                "/org/gnome/shell/": ["favorite-apps"]}},
                        "wallpaper": {"file": "assets/wallpaper.png", "sha256": setup.digest(wallpaper),
                                      "destination": ".local/share/backgrounds/dash2dock-desktop.png"}}
        self.write_manifest()
        self.desktop = FakeDesktop(self)
        patcher = mock.patch.object(setup, "run", side_effect=self.desktop.run)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(mock.patch.stopall)

    def write_manifest(self):
        (self.directory / "manifest.json").write_text(json.dumps(self.profile))

    def archive(self, extension, metadata=None, extra=None, schema=None):
        destination = self.archives / extension["archive"]
        with zipfile.ZipFile(destination, "w") as bundle:
            bundle.writestr("metadata.json", json.dumps(metadata or {"uuid": extension["uuid"], "version": extension["version"], "shell-version": ["48"]}))
            for item in extension["schemas"]:
                bundle.writestr(item["file"], schema or (self.root / extension["uuid"] / item["file"]).read_bytes())
            if extra:
                bundle.writestr(*extra)
        return destination

    def no_writes(self):
        return all(args[:2] not in (("dconf", "load"), ("dconf", "write"), ("dconf", "reset"),
                                   ("gnome-extensions", "install"), ("gnome-extensions", "enable"))
                   for args, _ in self.desktop.calls)

    def test_load_profile_and_check_are_read_only(self):
        directory, profile = setup.load_profile(self.directory)
        setup.check(directory, profile, self.root, self.home)
        self.assertTrue(self.no_writes())
        self.assertFalse((self.home / ".local/state").exists())

    def test_profile_cannot_escape_with_relative_or_symlink_paths(self):
        for path in ("../outside", "/tmp/outside", "x/../../outside", "x\\..\\outside"):
            with self.subTest(path=path), self.assertRaises(setup.SetupError):
                setup.confined(self.directory, path)
        (self.directory / "escape").symlink_to(self.base)
        with self.assertRaises(setup.SetupError):
            setup.confined(self.directory, "escape/file")

    def test_wallpaper_hash_verified(self):
        (self.directory / "assets/wallpaper.png").write_bytes(b"changed")
        with self.assertRaisesRegex(setup.SetupError, "wallpaper"):
            setup.load_profile(self.directory)

    def test_existing_wallpaper_symlink_is_not_followed(self):
        original = self.home / "existing-wallpaper.png"
        original.write_bytes(b"keep original wallpaper")
        target = self.home / self.profile["wallpaper"]["destination"]
        target.parent.mkdir(parents=True)
        target.symlink_to(original)
        with self.assertRaisesRegex(setup.SetupError, "symlinked wallpaper"):
            setup.restore(self.directory, self.profile, self.root, self.home, apply=True)
        self.assertEqual(original.read_bytes(), b"keep original wallpaper")
        self.assertTrue(target.is_symlink())
        self.assertTrue(self.no_writes())
        self.assertFalse((self.home / ".local/state").exists())

    def test_manifest_appearance_and_extension_paths_are_scoped(self):
        self.profile["appearance"]["keys"]["/org/gnome/desktop/privacy/"] = ["remember-recent-files"]
        self.write_manifest()
        with self.assertRaisesRegex(setup.SetupError, "Unexpected appearance"):
            setup.load_profile(self.directory)
        del self.profile["appearance"]["keys"]["/org/gnome/desktop/privacy/"]
        self.extensions[0]["settings_path"] = "/org/gnome/shell/"
        self.write_manifest()
        with self.assertRaisesRegex(setup.SetupError, "not scoped"):
            setup.load_profile(self.directory)

    def test_shell_mismatch_prevents_all_writes(self):
        self.profile["tested_environment"]["shell_major"] = 49
        with self.assertRaisesRegex(setup.SetupError, "GNOME 49"):
            setup.restore(self.directory, self.profile, self.root, self.home, apply=True)
        self.assertTrue(self.no_writes())

    def test_global_extension_switch_is_preserved_and_reported(self):
        self.desktop.values["/org/gnome/shell/disable-user-extensions"] = "true"
        with self.assertRaisesRegex(setup.SetupError, "globally disabled"):
            setup.restore(self.directory, self.profile, self.root, self.home, apply=True)
        self.assertEqual(self.desktop.values["/org/gnome/shell/disable-user-extensions"], "true")
        self.assertTrue(self.no_writes())
        self.assertFalse((self.home / ".local/state").exists())

    def test_installed_version_and_source_hash_are_required(self):
        extension = self.extensions[0]
        metadata_path = self.root / extension["uuid"] / "metadata.json"
        metadata = json.loads(metadata_path.read_text())
        metadata["version"] = 999
        metadata_path.write_text(json.dumps(metadata))
        self.assertIn("pinned version", setup.installed_issues(extension, self.root, 48)[0])
        metadata["version"] = extension["version"]
        metadata_path.write_text(json.dumps(metadata))
        (self.root / extension["uuid"] / extension["schemas"][0]["file"]).write_text("modified")
        with self.assertRaisesRegex(setup.SetupError, "schema source mismatch"):
            setup.restore(self.directory, self.profile, self.root, self.home, apply=True)
        self.assertTrue(self.no_writes())

    def test_exact_schema_id_and_path_are_required(self):
        self.extensions[0]["schemas"][0]["id"] = "wrong.id"
        with self.assertRaisesRegex(setup.SetupError, "Schema ID/path mismatch"):
            setup.restore(self.directory, self.profile, self.root, self.home)

    def test_unknown_excluded_and_other_extension_settings_rejected(self):
        extension = self.extensions[0]
        target = self.directory / extension["settings_file"]
        for text in ("[/]\nunknown=true\n", "[/]\nruntime-message='old'\n",
                     "[../../other]\nenabled=true\n", "[/]\nDEFAULT=true\n"):
            target.write_text(text)
            with self.subTest(text=text), self.assertRaises(setup.SetupError):
                setup.restore(self.directory, self.profile, self.root, self.home, apply=True)
            self.assertTrue(self.no_writes())

    def test_appearance_does_not_allow_other_shell_settings(self):
        target = self.directory / self.profile["appearance"]["settings_file"]
        target.write_text("[org/gnome/shell]\nenabled-extensions=[]\n")
        with self.assertRaisesRegex(setup.SetupError, "unapproved"):
            setup.restore(self.directory, self.profile, self.root, self.home, apply=True)
        self.assertTrue(self.no_writes())

    def test_restore_dry_run_does_not_create_backups_or_mutate(self):
        setup.restore(self.directory, self.profile, self.root, self.home)
        self.assertTrue(self.no_writes())
        self.assertFalse((self.home / ".local/state").exists())

    def test_modified_snapshot_stops_before_any_writes(self):
        extension = self.extensions[0]
        target = self.directory / extension["settings_file"]
        extension["settings_sha256"] = setup.digest(target)
        target.write_text(target.read_text().replace("enabled=false", "enabled=true"))
        with self.assertRaisesRegex(setup.SetupError, "snapshot SHA-256"):
            setup.restore(self.directory, self.profile, self.root, self.home, apply=True)
        self.assertTrue(self.no_writes())

    def test_modified_appearance_stops_before_any_writes(self):
        appearance = self.profile["appearance"]
        target = self.directory / appearance["settings_file"]
        appearance["settings_sha256"] = setup.digest(target)
        target.write_text(target.read_text().replace("prefer-dark", "default"))
        with self.assertRaisesRegex(setup.SetupError, "snapshot SHA-256"):
            setup.restore(self.directory, self.profile, self.root, self.home, apply=True)
        self.assertTrue(self.no_writes())

    def test_restore_scopes_backups_and_resolves_placeholders(self):
        original_enabled = self.desktop.values[setup.ENABLE_KEYS[0]]
        self.desktop.values["/org/gnome/shell/extensions/unrelated/option"] = "true"
        setup.restore(self.directory, self.profile, self.root, self.home, apply=True)
        self.assertEqual(self.desktop.values["/org/gnome/shell/extensions/unrelated/option"], "true")
        self.assertIn("unrelated@example.com", self.desktop.values[setup.ENABLE_KEYS[0]])
        self.assertIn(self.extensions[0]["uuid"], self.desktop.values[setup.ENABLE_KEYS[0]])
        self.assertEqual(self.desktop.values[self.extensions[0]["settings_path"] + "downloads-path"],
                         setup.variant_string(self.home / "My Downloads"))
        wallpaper = self.home / self.profile["wallpaper"]["destination"]
        self.assertEqual(wallpaper.read_bytes(), b"profile wallpaper")
        self.assertEqual(self.desktop.values["/org/gnome/desktop/background/picture-uri"], setup.variant_string(wallpaper.as_uri()))
        self.assertNotIn((("dconf", "dump", "/org/gnome/shell/"), None), self.desktop.calls)
        backups = list((self.home / ".local/state/dash2dock-desktop/backups").iterdir())
        self.assertEqual(len(backups), 1)
        keys = json.loads((backups[0] / "appearance-and-enable-keys.json").read_text())
        self.assertEqual(keys[setup.ENABLE_KEYS[0]], original_enabled)
        loads = [i for i, (args, _) in enumerate(self.desktop.calls) if args[:2] == ("dconf", "load")]
        reads = [i for i, (args, _) in enumerate(self.desktop.calls) if args[:2] in (("dconf", "dump"), ("dconf", "read"))]
        self.assertLess(max(reads), min(loads))

    def test_restore_load_failure_rolls_back_keys_and_wallpaper(self):
        original = dict(self.desktop.values)
        target = self.home / self.profile["wallpaper"]["destination"]
        target.parent.mkdir(parents=True)
        target.write_bytes(b"original wallpaper")
        self.desktop.fail_load = self.extensions[1]["settings_path"]
        with self.assertRaisesRegex(setup.SetupError, "Previous settings and wallpaper restored"):
            setup.restore(self.directory, self.profile, self.root, self.home, apply=True)
        self.assertEqual(self.desktop.values, original)
        self.assertEqual(target.read_bytes(), b"original wallpaper")
        self.assertFalse(any(args[:3] == ("dconf", "reset", "-f") and args[3] == "/org/gnome/shell/"
                             for args, _ in self.desktop.calls))

    def test_enable_failure_restores_enable_lists_and_removes_new_wallpaper(self):
        original = dict(self.desktop.values)
        self.desktop.fail_enable = True
        with self.assertRaisesRegex(setup.SetupError, "Restore failed"):
            setup.restore(self.directory, self.profile, self.root, self.home, apply=True)
        self.assertEqual(self.desktop.values, original)
        self.assertFalse((self.home / self.profile["wallpaper"]["destination"]).exists())

    def test_substitution_escapes_quotes(self):
        with mock.patch.object(setup, "downloads_directory", return_value="/home/o'connor/Downloads"):
            result = setup.substitute("downloads-path='__MY_DESKTOP_DOWNLOADS__'", self.home, None)
        self.assertEqual(result, "downloads-path='/home/o\\'connor/Downloads'")
        with self.assertRaises(setup.SetupError):
            setup.substitute("uri='prefix__MY_DESKTOP_WALLPAPER_URI__'", self.home, None)

    def test_archive_requires_exact_uuid_version_and_shell(self):
        extension = self.extensions[0]
        valid = {"uuid": extension["uuid"], "version": extension["version"], "shell-version": ["48"]}
        for changes in ({"uuid": "other@example.com"}, {"version": 999}, {"shell-version": ["49"]}):
            with self.subTest(changes=changes), self.assertRaises(setup.SetupError):
                setup.validate_archive(self.archive(extension, dict(valid, **changes)), extension, 48)

    def test_archive_rejects_path_traversal_symlinks_and_schema_mismatch(self):
        extension = self.extensions[0]
        for name in ("../outside", "/outside", "nested/../../outside", "nested\\outside"):
            with self.subTest(name=name), self.assertRaisesRegex(setup.SetupError, "Unsafe ZIP"):
                setup.validate_archive(self.archive(extension, extra=(name, "bad")), extension, 48)
        path = self.archive(extension)
        with zipfile.ZipFile(path, "a") as bundle:
            link = zipfile.ZipInfo("symlink")
            link.external_attr = (0o120777 << 16)
            bundle.writestr(link, "/tmp/other")
        with self.assertRaisesRegex(setup.SetupError, "Unsafe ZIP"):
            setup.validate_archive(path, extension, 48)
        with self.assertRaisesRegex(setup.SetupError, "schema differs"):
            setup.validate_archive(self.archive(extension, schema=b"different"), extension, 48)

    def test_archive_size_limit(self):
        extension = self.extensions[0]
        path = self.archive(extension)
        with mock.patch.object(setup, "MAX_ARCHIVE_BYTES", 10), self.assertRaisesRegex(setup.SetupError, "size limit"):
            setup.validate_archive(path, extension, 48)

    def test_downloads_are_pinned_and_dash_requires_local_fork(self):
        extension = copy.deepcopy(self.extensions[0])
        self.assertIn("version_tag=", setup.source_for(extension, None))
        extension["download_url"] = "https://extensions.gnome.org/download-extension/latest.zip"
        with self.assertRaisesRegex(setup.SetupError, "version_tag"):
            setup.source_for(extension, None)
        extension["uuid"] = setup.DASH_UUID
        pinned = copy.deepcopy(self.extensions[0])
        pinned["download_url"] += "&shell_version=48"
        with self.assertRaisesRegex(setup.SetupError, "version_tag"):
            setup.source_for(pinned, None)
        with mock.patch.object(setup, "REPO", self.base), self.assertRaisesRegex(setup.SetupError, "Build this fork"):
            setup.source_for(extension, None)

    def test_offline_archive_hash_is_verified(self):
        extension = self.extensions[0]
        archive = self.archive(extension)
        extension["archive_sha256"] = setup.digest(archive)
        self.assertEqual(setup.source_for(extension, self.archives), archive)
        extension["archive_sha256"] = "0" * 64
        with self.assertRaisesRegex(setup.SetupError, "Offline archive SHA-256"):
            setup.source_for(extension, self.archives)

    def test_install_dry_run_skips_matching_and_never_downloads(self):
        with mock.patch.object(setup, "download") as download:
            setup.install(self.directory, self.profile, self.root, self.home)
            download.assert_not_called()
            setup.remove_tree(self.root / self.extensions[0]["uuid"])
            setup.install(self.directory, self.profile, self.root, self.home)
            download.assert_not_called()
        self.assertTrue(self.no_writes())

    def test_all_archives_validated_before_first_install(self):
        for extension in self.extensions:
            self.archive(extension)
        self.archive(self.extensions[1], schema=b"bad")
        for extension in self.extensions:
            setup.remove_tree(self.root / extension["uuid"])
        with self.assertRaisesRegex(setup.SetupError, "schema differs"):
            setup.install(self.directory, self.profile, self.root, self.home, apply=True, archives=self.archives)
        self.assertTrue(self.no_writes())
        self.assertFalse((self.home / ".local/state").exists())

    def test_install_exact_offline_bundles_and_backup_old_version(self):
        for extension in self.extensions:
            self.archive(extension)
            metadata_path = self.root / extension["uuid"] / "metadata.json"
            metadata = json.loads(metadata_path.read_text())
            metadata["version"] = 0
            metadata_path.write_text(json.dumps(metadata))
        setup.install(self.directory, self.profile, self.root, self.home, apply=True, archives=self.archives)
        self.assertEqual(setup.installed_issues(self.extensions[0], self.root, 48), [])
        backup = next((self.home / ".local/state/dash2dock-desktop/backups").iterdir())
        saved = json.loads((backup / self.extensions[0]["uuid"] / "metadata.json").read_text())
        self.assertEqual(saved["version"], 0)

    def test_install_failure_rolls_back_old_extension_files(self):
        for extension in self.extensions:
            self.archive(extension)
            metadata_path = self.root / extension["uuid"] / "metadata.json"
            metadata = json.loads(metadata_path.read_text())
            metadata["version"] = 0
            metadata_path.write_text(json.dumps(metadata))
        original_run = self.desktop.run

        def fail_second(*args, input=None):
            if args[:2] == ("gnome-extensions", "install") and self.extensions[1]["uuid"] in args[3]:
                raise setup.SetupError("injected install failure")
            return original_run(*args, input=input)

        with mock.patch.object(setup, "run", side_effect=fail_second), self.assertRaisesRegex(setup.SetupError, "Existing extension files restored"):
            setup.install(self.directory, self.profile, self.root, self.home, apply=True, archives=self.archives)
        for extension in self.extensions:
            metadata = json.loads((self.root / extension["uuid"] / "metadata.json").read_text())
            self.assertEqual(metadata["version"], 0)


if __name__ == "__main__":
    unittest.main()
