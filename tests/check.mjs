import {readdirSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
function sources(directory) {
  return readdirSync(directory, {withFileTypes: true}).flatMap(entry => {
    if (['.git', 'node_modules', 'build'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.m?js$/.test(entry.name) ? [path] : [];
  });
}
const files = sources(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: readFileSync(file), encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(file, result.stderr);
    process.exit(1);
  }
}
console.log(`Parsed ${files.length} JavaScript files successfully`);
