// Builds the single executable of this computer's system and architecture (Node.js Single Executable Applications): src/relay.cjs is injected into a copy of the running
// node binary. The CI runs it once per system (.github/workflows/build.yml).
//   node scripts/build-sea.mjs [--target <name>]   -> release/apk-lab-relay-<target>(.exe | .tar.gz)
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), at = args.indexOf('--target');
const platform = process.platform, arch = process.arch;
const target = at >= 0 ? args[at + 1] : `${platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform}-${arch}`;
const build = path.join(root, 'build'), release = path.join(root, 'release');
rmSync(build, { recursive: true, force: true }); mkdirSync(build, { recursive: true }); mkdirSync(release, { recursive: true });
const run = (command, list, options = {}) => { console.log(`> ${command} ${list.join(' ')}`); execFileSync(command, list, { stdio: 'inherit', cwd: root, ...options }); };

// 1. the blob: the app's script (CommonJS, Node built-ins only) prepared for injection. A single executable's require() has only the built-ins, so the app's own modules
//    (src/webview.cjs) are put into one file first: each local require('./x.cjs') becomes that file's module.exports, evaluated once.
const blob = path.join(build, 'sea-prep.blob'), config = path.join(build, 'sea-config.json'), bundled = path.join(build, 'relay-bundle.cjs');
const local = name => `(() => { const module = { exports: {} }; (function (module, exports) {\n${readFileSync(path.join(root, 'src', name), 'utf8')}\n})(module, module.exports); return module.exports; })()`;
const main = readFileSync(path.join(root, 'src', 'relay.cjs'), 'utf8').replace(/require\('\.\/([a-z-]+\.cjs)'\)/g, (whole, name) => local(name));
if (/require\('\.\//.test(main)) throw new Error('a local require is left in the bundle');
writeFileSync(bundled, main);
// the same file is also a release file of its own: the relay as one Node.js script (Node 22+, no dependency), for whoever prefers `node apk-lab-relay.cjs` to an executable
mkdirSync(release, { recursive: true }); writeFileSync(path.join(release, 'apk-lab-relay.cjs'), `#!/usr/bin/env node\n${main}`); console.log('release/apk-lab-relay.cjs');
writeFileSync(config, JSON.stringify({ main: bundled, output: blob, disableExperimentalSEAWarning: true, useCodeCache: true }, null, 2));
run(process.execPath, ['--experimental-sea-config', config]);

// 2. a copy of node with the blob injected (the signature of the copy is removed first and, on macOS, an ad-hoc one put back: the system runs only signed arm64 binaries)
const exe = path.join(build, platform === 'win32' ? 'apk-lab-relay.exe' : 'apk-lab-relay');
copyFileSync(process.execPath, exe); if (platform !== 'win32') chmodSync(exe, 0o755);
if (platform === 'darwin') run('codesign', ['--remove-signature', exe]);
const postject = path.join(path.dirname(createRequire(import.meta.url).resolve('postject/package.json')), 'dist', 'cli.js');
run(process.execPath, [postject, exe, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2', ...(platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
if (platform === 'darwin') run('codesign', ['--sign', '-', exe]);

// 3. the release file: the .exe as it is on Windows; a .tar.gz elsewhere (it keeps the executable bit, which a plain download loses)
const name = `apk-lab-relay-${target}`;
if (platform === 'win32') { copyFileSync(exe, path.join(release, `${name}.exe`)); console.log(`release/${name}.exe`); }
else {
  const folder = path.join(build, name); mkdirSync(folder); copyFileSync(exe, path.join(folder, 'apk-lab-relay')); chmodSync(path.join(folder, 'apk-lab-relay'), 0o755);
  for (const file of ['README.md', 'LICENSE']) if (existsSync(path.join(root, file))) copyFileSync(path.join(root, file), path.join(folder, file));
  run('tar', ['-czf', path.join(release, `${name}.tar.gz`), '-C', build, name]);
  console.log(`release/${name}.tar.gz`);
}
