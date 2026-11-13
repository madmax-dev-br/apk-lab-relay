// Starts the built executable (build/apk-lab-relay[.exe]) on a spare port and checks that it answers: its version, the status page, and a refused relay request (no network
// is used: the target is a private address, which the relay refuses by default). The CI runs it after each build.
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exe = path.join(root, 'build', process.platform === 'win32' ? 'apk-lab-relay.exe' : 'apk-lab-relay');
const { VERSION } = await import(pathToFileURL(path.join(root, 'src', 'relay.cjs')).href).then(m => m.default ?? m);
const version = execFileSync(exe, ['--version'], { encoding: 'utf8' }).trim();
if (version !== VERSION) throw new Error(`--version answered ${version}, expected ${VERSION}`);

const home = mkdtempSync(path.join(os.tmpdir(), 'relay-smoke-')), port = 18787 + Math.floor(Math.random() * 1000);
const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, XDG_CONFIG_HOME: home };   // the settings of this run stay in a temporary folder
const child = spawn(exe, ['--no-open', '--port', String(port), '--token', 'smoke-token-1'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
let output = ''; child.stdout.on('data', chunk => { output += chunk; });
try {
  let status = null;
  for (let i = 0; i < 100 && !status; i++) { await new Promise(resolve => setTimeout(resolve, 100)); try { status = await (await fetch(`http://127.0.0.1:${port}/status.json`)).json(); } catch { status = null; } }
  if (!status || status.version !== VERSION) throw new Error(`the status page did not answer:\n${output}`);
  const page = await (await fetch(`http://127.0.0.1:${port}/`)).text();
  if (!page.includes(`http://127.0.0.1:${port}/smoke-token-1/?url={url}`)) throw new Error('the status page does not show the proxy address');
  const refused = await fetch(`http://127.0.0.1:${port}/smoke-token-1/?url=${encodeURIComponent('http://127.0.0.1:9/')}`, { headers: { origin: 'https://madmax-dev-br.github.io' } });
  if (refused.headers.get('x-apkweb-relay-error-code') !== 'APKWEB_RELAY_PRIVATE') throw new Error(`a private target was not refused: ${refused.status}`);
  console.log(`smoke test passed: ${exe} ${VERSION} on port ${port}`);
} finally { child.kill(); await new Promise(resolve => setTimeout(resolve, 300)); try { rmSync(home, { recursive: true, force: true }); } catch { /* still in use on Windows */ } }
