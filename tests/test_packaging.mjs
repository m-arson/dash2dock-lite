import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {closeSync, cpSync, mkdtempSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

try {
  for (const entry of readdirSync(source, {withFileTypes: true})) {
    if (entry.isFile() && (entry.name.endsWith('.js') || [
      'Makefile', 'metadata.json', 'stylesheet.css', 'LICENSE', 'README.md', 'CHANGELOG.md',
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
import json, os, sys
from pathlib import Path
root = Path(os.environ['D2DA_PACKAGE_STAGE']).resolve()
command = Path(sys.argv[0]).name
if command == 'gnome-extensions':
    (root / 'extension-cli-calls.json').write_text(json.dumps(sys.argv[1:]))
    sys.exit(0 if os.environ.get('D2DA_TEST_INSTALL_CLI') == '1' else 98)
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

  run('make', ['publish'], {env});
  let packaged = entries();
  for (const name of ['themes/dark.json', 'themes/light.json', 'dragOrder.js']) {
    assert.ok(packaged.has(name), `Modern package is missing ${name}`);
  }
  assert.ok(!packaged.has('schemas/gschemas.compiled'),
    'modern bundles contain portable schema source for the official installer to compile');
  for (const name of packaged) {
    if (name.endsWith('.js')) syntax(name, archiveText(name), false);
  }
  assert.deepEqual(readFileSync(join(stage, 'unrelated-backup.zip')), sentinel);
  const modernArchive = readFileSync(join(stage, bundle));
  writeFileSync(join(stage, 'modern-backup.zip'), modernArchive);

  run('make', ['publish-g44'], {env});
  packaged = entries();
  assert.ok(packaged.has('themes/dark.json') && packaged.has('themes/light.json'));
  assert.deepEqual(JSON.parse(archiveText('metadata.json'))['shell-version'], ['42', '43', '44']);
  assert.ok(packaged.has('dragOrder.js'));
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

  run('make', ['install-zip'], {env: {...env, D2DA_TEST_INSTALL_CLI: '1'}});
  assert.deepEqual(JSON.parse(readFileSync(join(stage, 'extension-cli-calls.json'), 'utf8')),
    ['install', '--force', bundle],
    'zip installation uses the official CLI so local schemas are compiled');
  console.log('Modern and legacy packaging regressions passed (isolated; no home or live extension writes)');
} finally {
  rmSync(stage, {recursive: true, force: true});
}
