import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, openSync, closeSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const uuid = 'dash2dock-lite@icedman.github.com';
const schemaName = 'schemas/org.gnome.shell.extensions.dash2dock-lite.gschema.xml';
const settings = '[/]\ndock-location=1\nicon-effect=2\napps-icon=false\n';
const schema = readFileSync(join(root, schemaName), 'utf8');
const sandbox = mkdtempSync(join(tmpdir(), 'd2da-upgrade-test-'));
let invocation = 0;
function run(command, args, options = {}) {
  const output = join(sandbox, `output-${invocation++}`);
  const errors = `${output}-errors`;
  const descriptors = [openSync(output, 'w'), openSync(errors, 'w')];
  let result;
  try {
    result = spawnSync(command, args, {...options, stdio: ['ignore', ...descriptors]});
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
  }
  return {...result, stdout: readFileSync(output, 'utf8'), stderr: readFileSync(errors, 'utf8')};
}
const fakeDconf = `#!/usr/bin/env python3
import os, sys
from pathlib import Path
state = Path(os.environ['D2DA_TEST_SETTINGS'])
if sys.argv[1] == 'read':
    print('[]')
else:
    assert sys.argv[-1] == '/org/gnome/shell/extensions/dash2dock-lite/'
    if sys.argv[1] == 'dump': sys.stdout.buffer.write(state.read_bytes())
    elif sys.argv[1] == 'reset': state.write_bytes(b'')
    elif sys.argv[1] == 'load': state.write_bytes(sys.stdin.buffer.read())
    else: raise AssertionError(sys.argv)
`;
const fakeInstaller = `#!/usr/bin/env python3
import os, shutil, sys
from pathlib import Path
from zipfile import ZipFile
assert sys.argv[1:3] == ['install', '--force']
Path(os.environ['D2DA_TEST_CALLED']).write_text('called')
installed = Path(os.environ['XDG_DATA_HOME']) / 'gnome-shell/extensions/${uuid}'
shutil.rmtree(installed)
installed.mkdir()
mode = os.environ['D2DA_TEST_MODE']
if mode == 'partial':
    (installed / 'extension.js').write_text('incomplete install')
    Path(os.environ['D2DA_TEST_SETTINGS']).write_text('[/]\\nnew-setting=true\\n')
    sys.exit(7)
with ZipFile(sys.argv[3]) as archive: archive.extractall(installed)
if mode == 'corrupt': (installed / 'dock.js').write_text('wrong bytes')
if mode == 'settings':
    Path(os.environ['D2DA_TEST_SETTINGS']).write_text('[/]\\nnew-setting=true\\n')
`;

function fixture(name, mode = name, changedSchema = false, inside = null) {
  const base = join(sandbox, name);
  const installed = join(base, 'data/gnome-shell/extensions', uuid);
  const bin = join(base, 'bin');
  mkdirSync(join(installed, 'schemas'), {recursive: true});
  mkdirSync(bin, {recursive: true});
  const oldFiles = {
    'metadata.json': JSON.stringify({uuid, version: 92}),
    'extension.js': 'old extension code', 'dock.js': 'old dock code',
    'old-only.txt': 'retain on rollback', [schemaName]: schema,
  };
  for (const [name, value] of Object.entries(oldFiles)) writeFileSync(join(installed, name), value);
  writeFileSync(join(bin, 'dconf'), fakeDconf, {mode: 0o700});
  writeFileSync(join(bin, 'gnome-extensions'), fakeInstaller, {mode: 0o700});
  const state = join(base, 'settings');
  writeFileSync(state, settings);
  const bundle = join(base, 'update.zip');
  const files = {'metadata.json': JSON.stringify({uuid, version: 100}),
    'extension.js': 'new extension code', 'dock.js': 'new dock code',
    [schemaName]: changedSchema ? 'unreviewed settings schema' : schema};
  const contents = join(base, 'bundle-files.json');
  writeFileSync(contents, JSON.stringify(files));
  const zip = run('python3', ['-c',
    'import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],"w") as z:\n for k,v in json.load(open(sys.argv[2])).items(): z.writestr(k,v)', bundle, contents],
  {encoding: 'utf8', timeout: 5000});
  assert.equal(zip.status, 0, zip.stderr);
  const backupRoot = inside === 'extension' ? join(installed, 'backups')
    : inside === 'config' ? join(base, 'config/d2da/backups') : join(base, 'backups');
  const result = run('python3', [join(root, 'tools/apply_update.py'), bundle,
    '--backup-root', backupRoot], {
    encoding: 'utf8', timeout: 15000, env: {...process.env, PATH: `${bin}:${process.env.PATH}`,
      XDG_DATA_HOME: join(base, 'data'), XDG_CONFIG_HOME: join(base, 'config'),
      D2DA_TEST_SETTINGS: state, D2DA_TEST_CALLED: join(base, 'called'), D2DA_TEST_MODE: mode},
  });
  return {base, installed, state, backupRoot, result, oldFiles, files};
}

try {
  for (const mode of ['success', 'settings']) {
    const f = fixture(mode);
    assert.equal(f.result.status, 0, f.result.stderr);
    assert.equal(readFileSync(f.state, 'utf8'), settings, 'exact preferences survive installation');
    for (const [name, value] of Object.entries(f.files))
      assert.equal(readFileSync(join(f.installed, name), 'utf8'), value);
    const backups = readdirSync(f.backupRoot);
    assert.equal(backups.length, 1);
    const backup = join(f.backupRoot, backups[0]);
    assert.equal(readFileSync(join(backup, 'settings.dconf'), 'utf8'), settings);
    assert.equal(readFileSync(join(backup, 'installed-extension/extension.js'), 'utf8'), 'old extension code');
    assert.equal(JSON.parse(readFileSync(join(backup, 'manifest.json'))).status,
      'installed_and_settings_verified');
  }
  for (const mode of ['partial', 'corrupt']) {
    const f = fixture(mode);
    assert.equal(f.result.status, 1, 'failed upgrades must not report success');
    assert.equal(readFileSync(f.state, 'utf8'), settings, 'rollback restores exact preferences');
    for (const [name, value] of Object.entries(f.oldFiles))
      assert.equal(readFileSync(join(f.installed, name), 'utf8'), value, `rollback restores ${name}`);
    const backup = join(f.backupRoot, readdirSync(f.backupRoot)[0]);
    assert.equal(JSON.parse(readFileSync(join(backup, 'manifest.json'))).status, 'rolled_back');
  }
  const rejected = fixture('schema-change', 'success', true);
  assert.equal(rejected.result.status, 1);
  assert.match(rejected.result.stderr, /reviewed migration/);
  assert.deepEqual(readdirSync(rejected.installed).sort(), ['dock.js', 'extension.js', 'metadata.json', 'old-only.txt', 'schemas']);
  assert.equal(readFileSync(rejected.state, 'utf8'), settings);
  assert.equal(existsSync(join(rejected.base, 'called')), false, 'schema validation happens before installation');
  for (const inside of ['extension', 'config']) {
    const rejected = fixture(`recursive-${inside}`, 'success', false, inside);
    assert.equal(rejected.result.status, 1);
    assert.match(rejected.result.stderr, /Backup directory must be outside/);
    assert.equal(existsSync(rejected.backupRoot), false, 'recursive backup destinations are rejected before writing');
    assert.equal(existsSync(join(rejected.base, 'called')), false);
    assert.equal(readFileSync(rejected.state, 'utf8'), settings);
  }
  console.log('Upgrade regressions passed (isolated install, exact settings preservation, partial/corrupt rollback, schema preflight)');
} finally {
  rmSync(sandbox, {recursive: true, force: true});
}
