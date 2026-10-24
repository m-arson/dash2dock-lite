import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {closeSync, cpSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, posix} from 'node:path';
import {fileURLToPath} from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const stage = mkdtempSync(join(tmpdir(), 'd2da-packaging-tests-'));
const bundle = 'dash2dock-lite@icedman.github.com.zip';
function run(command, args, options = {}) {
  // Files also work in restricted runtimes that disallow subprocess pipes.
  const {input, ...spawnOptions} = options;
  const output = join(stage, '.command-output');
  const errors = join(stage, '.command-errors');
  const descriptors = [openSync(output, 'w'), openSync(errors, 'w')];
  let stdin = 'ignore';
  if (input !== undefined) {
    writeFileSync(join(stage, '.command-input'), input);
    stdin = openSync(join(stage, '.command-input'), 'r');
  }
  let result;
  try {
    result = spawnSync(command, args, {cwd: stage, ...spawnOptions,
      stdio: [stdin, ...descriptors]});
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor);
    if (typeof stdin === 'number') closeSync(stdin);
  }
  const stdout = readFileSync(output, 'utf8');
  const stderr = readFileSync(errors, 'utf8');
  assert.ifError(result.error);
  assert.equal(result.status, 0,
    `${command} ${args.join(' ')} failed:\n${stdout}${stderr}`);
  return stdout;
}
function entries() {
  return new Set(run('unzip', ['-Z1', bundle]).trim().split('\n'));
}
function archiveText(name) {
  return run('unzip', ['-p', bundle, name]);
}
function syntax(name, text, legacy) {
  run(process.execPath, ['--input-type=' + (legacy ? 'commonjs' : 'module'), '--check'], {input: text});
  if (legacy) assert.doesNotMatch(text, /^\s*(?:import |export )/m, name);
}
function portableContents(packaged) {
  assert.equal(archiveText('my-custom.dconf'), readFileSync(join(source, 'my-custom.dconf'), 'utf8'),
    'both archives retain the optional personal settings snapshot unchanged');
  assert.ok(packaged.has('schemas/org.gnome.shell.extensions.dash2dock-lite.gschema.xml'),
    'bundles retain portable settings schema source');
  assert.ok(!packaged.has('schemas/gschemas.compiled'),
    'the official installer compiles schema source for the destination system');
  for (const name of packaged) {
    assert.ok(!name.startsWith('ui/legacy/'), 'unused GTK layouts stay out of bundles');
    assert.ok(!/^apps\/.*\.(?:desktop|sh)$/.test(name),
      'obsolete launcher templates and shell helpers stay out of bundles');
  }
  assert.equal(archiveText('LICENSE'), readFileSync(join(source, 'LICENSE'), 'utf8'),
    'the original project license is preserved');
  const metadata = JSON.parse(archiveText('metadata.json'));
  assert.ok(metadata['original-authors'].includes('icedman'));
  assert.equal(metadata.donations.buymeacoffee, 'icedman',
    'GNOME extension support metadata still points to the original author');
  assert.match(archiveText('ui/general.ui'), /https:\/\/www\.buymeacoffee\.com\/icedman/);
  assert.ok(packaged.has('ui/images/qr_icedman.png'), 'icedman support QR is preserved');
  // Extract binary assets directly rather than decoding them as command output.
  run('unzip', ['-oq', bundle, 'ui/images/qr_icedman.png', '-d', 'credit-check']);
  assert.deepEqual(readFileSync(join(stage, 'credit-check/ui/images/qr_icedman.png')),
    readFileSync(join(source, 'ui/images/qr_icedman.png')));
}
function installedBundle(shellVersions) {
  const installed = JSON.parse(readFileSync(join(stage, 'extension-cli-calls.json'), 'utf8'));
  assert.deepEqual(installed.args, ['install', '--force', bundle],
    'installation uses the official CLI so local schemas are compiled');
  assert.deepEqual(installed.shellVersions, shellVersions,
    'installation receives the requested modern or legacy archive');
  assert.equal(installed.schemaSource, true);
  assert.equal(installed.compiledSchema, false);
}

try {
  for (const entry of readdirSync(source, {withFileTypes: true})) {
    if (entry.isFile() && (entry.name.endsWith('.js') || [
      'Makefile', 'metadata.json', 'my-custom.dconf', 'stylesheet.css', 'LICENSE', 'README.md', 'CHANGELOG.md',
    ].includes(entry.name)) || entry.isDirectory() && [
      'apps', 'effects', 'preferences', 'schemas', 'themes', 'tools', 'ui',
    ].includes(entry.name)) {
      cpSync(join(source, entry.name), join(stage, entry.name), {recursive: true});
    }
  }

  const guards = join(stage, 'guards');
  mkdirSync(guards);
  // Keep the real home untouched even if a packaging dependency accidentally
  // starts an install recipe. Guard all filesystem commands used by Makefile.
  const guard = `#!/usr/bin/env python3
import json, os, sys, zipfile
from pathlib import Path
root = Path(os.environ['D2DA_PACKAGE_STAGE']).resolve()
command = Path(sys.argv[0]).name
if command == 'gnome-extensions':
    if os.environ.get('D2DA_TEST_INSTALL_CLI') != '1':
        sys.exit('Unexpected extension installation during a build')
    with zipfile.ZipFile(sys.argv[-1]) as bundle:
        names = set(bundle.namelist())
        result = {
            'args': sys.argv[1:],
            'shellVersions': json.loads(bundle.read('metadata.json'))['shell-version'],
            'schemaSource': 'schemas/org.gnome.shell.extensions.dash2dock-lite.gschema.xml' in names,
            'compiledSchema': 'schemas/gschemas.compiled' in names,
        }
    (root / 'extension-cli-calls.json').write_text(json.dumps(result))
    sys.exit(0)
for argument in sys.argv[1:]:
    if argument.startswith('-'):
        continue
    path = Path(argument).resolve()
    if path != root and root not in path.parents:
        sys.exit('Packaging attempted a filesystem operation outside staging: ' + str(path))
os.execv('/usr/bin/' + command, [command] + sys.argv[1:])
`;
  for (const command of ['cp', 'mkdir', 'rm', 'gnome-extensions']) {
    writeFileSync(join(guards, command), guard, {mode: 0o755});
  }
  const env = {...process.env, PATH: `${guards}:${process.env.PATH}`, D2DA_PACKAGE_STAGE: stage};
  const sentinel = Buffer.from('Existing unrelated archive must survive publishing.');
  writeFileSync(join(stage, 'unrelated-backup.zip'), sentinel);

  rmSync(join(stage, 'schemas/gschemas.compiled'), {force: true});
  run('make', [], {env});
  assert.ok(existsSync(join(stage, 'schemas/gschemas.compiled')),
    'plain make compiles the local settings schema');
  assert.ok(!existsSync(join(stage, bundle)) && !existsSync(join(stage, 'build')),
    'plain make does not package or install an extension');
  assert.ok(!existsSync(join(stage, 'extension-cli-calls.json')),
    'plain make never invokes the extension installer');

  run('make', ['publish'], {env});
  let packaged = entries();
  for (const name of ['themes/dark.json', 'themes/light.json', 'dragOrder.js', 'windowPreviewMenu.js', 'pointerWatcher.js']) {
    assert.ok(packaged.has(name), `Modern package is missing ${name}`);
  }
  portableContents(packaged);
  for (const name of packaged) {
    if (!name.endsWith('.js')) continue;
    const text = archiveText(name);
    syntax(name, text, false);
    for (const [, target] of text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) {
      if (!target.startsWith('.')) continue;
      assert.ok(packaged.has(posix.normalize(posix.join(posix.dirname(name), target))),
        `${name} references missing packaged module ${target}`);
    }
  }
  assert.match(archiveText('dock.js'), /from\s+['"]\.\/windowPreviewMenu\.js['"]/,
    'modern dock loads its thumbnail chooser component');
  assert.match(archiveText('dock.js'), /from\s+['"]\.\/pointerWatcher\.js['"]/,
    'modern dock uses its bundled watcher instead of a removed Shell module');
  assert.deepEqual(readFileSync(join(stage, 'unrelated-backup.zip')), sentinel);
  const modernArchive = readFileSync(join(stage, bundle));
  writeFileSync(join(stage, 'modern-backup.zip'), modernArchive);

  run('make', ['publish-g44'], {env});
  packaged = entries();
  portableContents(packaged);
  assert.ok(packaged.has('themes/dark.json') && packaged.has('themes/light.json'));
  assert.deepEqual(JSON.parse(archiveText('metadata.json'))['shell-version'], ['42', '43', '44']);
  assert.ok(packaged.has('dragOrder.js'));
  assert.ok(packaged.has('windowPreviewMenu.js'), 'legacy package contains the thumbnail chooser');
  assert.ok(packaged.has('pointerWatcher.js'), 'legacy package contains the pointer watcher');
  assert.match(archiveText('dock.js'), /Me\.imports\.windowPreviewMenu/,
    'legacy dock loads its generated thumbnail chooser component');
  assert.match(archiveText('dock.js'), /Me\.imports\.pointerWatcher/,
    'legacy dock loads its generated pointer watcher');
  for (const name of packaged) {
    assert.ok(!name.includes('recents'), 'removed recent-files helpers must stay absent');
    if (!name.endsWith('.js')) continue;
    const text = archiveText(name);
    syntax(name, text, true);
    for (const [, target] of text.matchAll(/Me\.imports\.([A-Za-z0-9_.]+)/g)) {
      assert.ok(packaged.has(target.replaceAll('.', '/') + '.js'),
        `${name} references missing generated module ${target}`);
    }
  }
  assert.deepEqual(readFileSync(join(stage, 'unrelated-backup.zip')), sentinel);
  assert.deepEqual(readFileSync(join(stage, 'modern-backup.zip')), modernArchive,
    'publishing legacy cannot delete or replace an unrelated modern backup');
  assert.ok(!readdirSync(stage).includes('extension-cli-calls.json'),
    'publishing either package must never invoke an installation command');

  const installEnv = {...env, D2DA_TEST_INSTALL_CLI: '1'};
  run('make', ['install-zip'], {env: installEnv});
  installedBundle(['42', '43', '44']);
  run('make', ['--jobs=2', 'install'], {env: installEnv});
  installedBundle(JSON.parse(readFileSync(join(source, 'metadata.json'), 'utf8'))['shell-version']);
  run('make', ['--jobs=2', 'g44'], {env: installEnv});
  installedBundle(['42', '43', '44']);
  console.log('Modern and legacy packaging regressions passed (isolated; no home or live extension writes)');
} finally {
  rmSync(stage, {recursive: true, force: true});
}
