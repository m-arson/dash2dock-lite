import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const nodeTests = readdirSync(new URL('./', import.meta.url))
  .filter(name => name.endsWith('.mjs') && !['run.mjs', 'check.mjs'].includes(name))
  .sort();
const gjsTests = ['test_timer_lifecycle.js', 'test_background_lifecycle.js', 'test_drag_order.js'];
const pythonTests = ['test_desktop_setup.py'];
for (const [command, args] of [
  ...nodeTests.map(name => [process.execPath, [`tests/${name}`]]),
  ...gjsTests.map(name => ['gjs', ['-m', `tests/${name}`]]),
  ...pythonTests.map(name => ['python3', [`tests/${name}`]]),
]) {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit'});
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Passed ${nodeTests.length + gjsTests.length + pythonTests.length} regression suites`);
