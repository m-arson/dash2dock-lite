#!/usr/bin/env python3
"""Apply a reviewed bundle while preserving settings and rolling back failures."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tempfile
from zipfile import ZipFile

UUID = 'dash2dock-lite@icedman.github.com'
SETTINGS_PATH = '/org/gnome/shell/extensions/dash2dock-lite/'
SCHEMA = 'schemas/org.gnome.shell.extensions.dash2dock-lite.gschema.xml'


def command(*args, data=None):
    return subprocess.run(args, input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, check=True).stdout


def fingerprint(directory):
    result = {}
    for path in sorted(directory.rglob('*')):
        name = str(path.relative_to(directory))
        if path.is_symlink():
            result[name] = ('link', os.readlink(path))
        elif path.is_file():
            result[name] = ('file', hashlib.sha256(path.read_bytes()).hexdigest())
    return result


def restore_settings(settings):
    if command('dconf', 'dump', SETTINGS_PATH) == settings:
        return
    # Limit restoration to this extension's own settings subtree. Reset first
    # so keys introduced by a failed upgrade do not survive the rollback.
    command('dconf', 'reset', '-f', SETTINGS_PATH)
    command('dconf', 'load', SETTINGS_PATH, data=settings)
    if command('dconf', 'dump', SETTINGS_PATH) != settings:
        raise RuntimeError('Restored settings differ from the saved preferences')


def apply(bundle, backup_root):
    data_root = Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share')
    installed = data_root / 'gnome-shell/extensions' / UUID
    if installed.is_symlink() or not installed.is_dir():
        raise RuntimeError('Expected an existing extension directory, not a symlink')
    if backup_root.resolve().is_relative_to(installed.resolve()):
        raise RuntimeError('Backup directory must be outside the installed extension')
    config_root = Path(os.environ.get('XDG_CONFIG_HOME') or Path.home() / '.config')
    if backup_root.resolve().is_relative_to((config_root / 'd2da').resolve()):
        raise RuntimeError('Backup directory must be outside the custom configuration')
    before_metadata = json.loads((installed / 'metadata.json').read_text())
    with ZipFile(bundle) as archive:
        if archive.testzip() is not None:
            raise RuntimeError('The update archive failed its integrity check')
        for entry in archive.infolist():
            name = PurePosixPath(entry.filename)
            if name.is_absolute() or '..' in name.parts or stat.S_ISLNK(entry.external_attr >> 16):
                raise RuntimeError(f'Unsafe archive entry: {entry.filename}')
        metadata = json.loads(archive.read('metadata.json'))
        if metadata['uuid'] != UUID or before_metadata['uuid'] != UUID:
            raise RuntimeError('The update UUID does not match the installed extension')
        if archive.read(SCHEMA) != (installed / SCHEMA).read_bytes():
            raise RuntimeError('Settings schema changed; a reviewed migration is required')
        expected_files = {entry.filename: hashlib.sha256(archive.read(entry)).digest()
                          for entry in archive.infolist() if not entry.is_dir()}

    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup = Path(tempfile.mkdtemp(prefix=f'before-install-{stamp}-', dir=backup_root))
    settings = command('dconf', 'dump', SETTINGS_PATH)
    (backup / 'settings.dconf').write_bytes(settings)
    old_files = fingerprint(installed)
    shutil.copytree(installed, backup / 'installed-extension', symlinks=True)
    if fingerprint(backup / 'installed-extension') != old_files:
        raise RuntimeError(f'Installed files changed while backing up; retry. Backup: {backup}')
    shell_state = {key: command('dconf', 'read', '/org/gnome/shell/' + key).decode()
                   for key in ('enabled-extensions', 'disabled-extensions',
                               'disable-user-extensions', 'favorite-apps')}
    (backup / 'shell-state.json').write_text(json.dumps(shell_state, indent=2) + '\n')
    if (config_root / 'd2da').exists():
        shutil.copytree(config_root / 'd2da', backup / 'custom-config', symlinks=True)
    manifest = {'old_version': before_metadata['version'], 'new_version': metadata['version'],
                'bundle_sha256': hashlib.sha256(bundle.read_bytes()).hexdigest(),
                'status': 'backup_complete', 'backup': str(backup)}

    def save_manifest():
        (backup / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')

    save_manifest()
    try:
        command('gnome-extensions', 'install', '--force', str(bundle))
        actual = json.loads((installed / 'metadata.json').read_text())
        if actual['uuid'] != UUID or actual['version'] != metadata['version']:
            raise RuntimeError('Installed version does not match the reviewed bundle')
        for name, digest in expected_files.items():
            if name == 'metadata.json':
                continue  # The installer may add its own metadata fields.
            if hashlib.sha256((installed / name).read_bytes()).digest() != digest:
                raise RuntimeError(f'Installed file differs from the bundle: {name}')
        restore_settings(settings)
        manifest['status'] = 'installed_and_settings_verified'
        save_manifest()
    except (Exception, KeyboardInterrupt) as error:
        manifest['status'] = 'upgrade_failed'
        manifest['error'] = str(error)
        try:
            if fingerprint(installed) != old_files:
                if installed.exists():
                    shutil.rmtree(installed)
                shutil.copytree(backup / 'installed-extension', installed, symlinks=True)
            restore_settings(settings)
            if fingerprint(installed) != old_files:
                raise RuntimeError('Restored extension files differ from the verified backup')
            manifest['status'] = 'rolled_back'
            print(f'Upgrade failed; old extension and settings restored. Backup: {backup}', file=sys.stderr)
        except Exception as rollback_error:
            manifest['status'] = 'rollback_failed'
            manifest['rollback_error'] = str(rollback_error)
            print(f'Upgrade and automatic rollback failed. Keep this backup: {backup}', file=sys.stderr)
        save_manifest()
        raise
    print(f"Version {metadata['version']} installed; files and settings verified. Backup: {backup}")
    print('Log out and back in to load the updated extension code.')
    return backup


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--backup-root', type=Path)
    args = parser.parse_args()
    bundle = args.bundle.resolve(strict=True)
    backup_root = (args.backup_root or bundle.parent).resolve()
    try:
        apply(bundle, backup_root)
    except (Exception, KeyboardInterrupt) as error:
        detail = error.stderr.decode(errors='replace').strip() if isinstance(error, subprocess.CalledProcessError) else str(error)
        print(f'Update did not complete: {detail}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
