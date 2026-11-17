'use strict';
// APK Lab Relay: a small desktop app that lets APK Browser Lab reach any server without CORS errors.
//
// A browser refuses every response whose server does not authorise the page's origin (CORS), and the servers a real Android app talks to never authorise the lab. The lab can send
// its requests through a relay instead (Controles > Dispositivo > Proxy, a URL with the `{url}` placeholder), and this is that relay: it repeats each request from this computer,
// as the device would send it, and answers the page with CORS headers. It is the same contract as the lab's own scripts/cors-relay.mjs:
//  - the target is the `url` query parameter; headers a browser may not send (Cookie, User-Agent, Origin, Referer ...) arrive as `x-apkweb-<name>` and go out under their own name;
//  - redirects are followed here (a browser hides redirect responses from the page); credentials never follow a redirect to another host;
//  - Set-Cookie, which a browser never exposes, comes back as `x-apkweb-set-cookie`: a JSON array of the Set-Cookie values;
//  - a failure to reach the target is a 502 with `x-apkweb-relay-error-code` (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, ECONNRESET, CERT_..., the codes Node uses) and
//    `x-apkweb-relay-error`, which the lab turns into the exception an Android device would throw (UnknownHostException, ConnectException, SSLHandshakeException ...).
//
// Safety: it listens on 127.0.0.1 only; every relayed request must carry the random token in its path and come from one of the allowed page origins, so another site open in the
// same browser cannot use it. Targets on this computer or the local network are refused unless "allow private" is on. Nothing is stored but the settings (token, port, origins):
// what the app sends passes through and is forgotten. The status page (http://127.0.0.1:<port>/) answers only to a Host of 127.0.0.1 or localhost (no DNS rebinding).
// The status page's icon (assets/icon-64.png, embedded: the executable is a single file).
const STATUS_ICON = 'data:image/png;base64,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';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const { isIP } = net;
const { spawn } = require('node:child_process');

const VERSION = '0.2.0';
const DEFAULT_PORT = 8787;
const DEFAULT_ORIGINS = ['https://madmax-dev-br.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length', 'expect']);
const FROM_BROWSER = new Set(['origin', 'referer', 'cookie', 'accept-encoding', 'user-agent']);   // the browser's own values (the app's, if it set them, come as x-apkweb-*)
const RESPONSE_DROP = new Set(['transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);   // Content-Encoding stays: the browser decodes the body as it would from the server itself
const MAX_BODY = 32 * 1024 * 1024;
const RECENT = 50;


/** One upstream exchange over node:http(s), following redirects the way fetch does (at most 20; 303, and 301/302 after a POST, continue as GET without a body). */
function send(url, method, headers, body, timeoutMs, hops = 0) {
  return new Promise((resolve, reject) => {
    const outgoing = {}; headers.forEach((value, name) => { outgoing[name] = name.toLowerCase() === 'cookie' ? value : (outgoing[name] ? `${outgoing[name]}, ${value}` : value); });
    if (body) outgoing['content-length'] = String(body.length);
    const request = (url.protocol === 'https:' ? https : http).request(url, { method, headers: outgoing, timeout: timeoutMs }, response => {
      const status = response.statusCode, location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        if (hops >= 20) return reject(Object.assign(new Error('Too many follow-up requests: 21'), { code: 'EREDIRECT' }));
        const next = new URL(location, url), asGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
        const nextHeaders = new Headers(headers); if (asGet) { nextHeaders.delete('content-type'); nextHeaders.delete('content-length'); }
        if (next.host !== url.host) { nextHeaders.delete('authorization'); nextHeaders.delete('cookie'); }
        return resolve(send(next, asGet ? 'GET' : method, nextHeaders, asGet ? undefined : body, timeoutMs, hops + 1));
      }
      resolve(response);
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error(`connect to ${url.host} timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
    request.end(body);
  });
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function statusPage({ proxyUrl, port }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>APK Lab Relay</title><link rel="icon" type="image/png" href="${STATUS_ICON}">
<style>
:root{--bg:#f6f7fb;--card:#fff;--ink:#1d2130;--muted:#667085;--line:#e3e6ee;--accent:#4f46e5;--ok:#1a7f4b;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1117;--card:#171a23;--ink:#e6e8ef;--muted:#98a0b3;--line:#272b38;--accent:#8b84ff;--ok:#4cc38a;--bad:#ff7b72}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:28px 16px 48px}h1{font-size:20px;margin:0 0 4px}p{margin:0 0 12px;color:var(--muted)}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-top:16px}h2{font-size:14px;margin:0 0 10px}
.url{display:flex;gap:8px}.url input{flex:1;min-width:0;font:13px ui-monospace,SFMono-Regular,Menlo,monospace;padding:9px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink)}
button{font:600 13px system-ui,sans-serif;padding:9px 14px;border-radius:7px;border:0;background:var(--accent);color:#fff;cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
ul{margin:0;padding-left:18px}table{width:100%;border-collapse:collapse;font-size:12px}td,th{text-align:left;padding:5px 6px;border-bottom:1px solid var(--line);white-space:nowrap}
td.url-cell{white-space:normal;word-break:break-all}.ok{color:var(--ok)}.bad{color:var(--bad)}.empty{color:var(--muted)}
</style></head><body><main>
<h1>APK Lab Relay ${VERSION}</h1>
<p>Running on 127.0.0.1:${port}. While this program is open, APK Browser Lab reaches any server without CORS errors.</p>
<section><h2>Address for the Proxy field</h2><p>In the lab: Controls › Device › Proxy. Paste the address below.</p>
<div class="url"><input id="proxy" readonly value="${escapeHtml(proxyUrl)}" aria-label="Proxy address"><button id="copy" type="button">Copy</button></div>
<p style="margin:10px 0 0">The relay reaches any destination: the internet, this computer and the local network.</p></section>
<section><h2>Recent requests</h2><table><thead><tr><th>Time</th><th>Method</th><th>Status</th><th>ms</th><th>Destination</th></tr></thead><tbody id="log"><tr><td colspan="5" class="empty">None yet.</td></tr></tbody></table></section>
</main><script>
document.getElementById('copy').addEventListener('click', async () => { const input = document.getElementById('proxy'); try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); } document.getElementById('copy').textContent = 'Copied'; setTimeout(() => { document.getElementById('copy').textContent = 'Copy'; }, 1500); });
const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
async function refresh() {
  try {
    const data = await (await fetch('/status.json', { cache: 'no-store' })).json(), body = document.getElementById('log');
    if (!data.recent.length) return;
    body.replaceChildren(...data.recent.slice().reverse().map(item => { const tr = document.createElement('tr'); tr.append(cell(new Date(item.at).toLocaleTimeString()), cell(item.method), cell(item.error || String(item.status), item.error || item.status >= 400 ? 'bad' : 'ok'), cell(String(item.ms)), cell(item.url, 'url-cell')); return tr; }));
  } catch {}
}
refresh(); setInterval(refresh, 2000);
</script></body></html>`;
}

/**
 * The relay as an http.Server (not listening yet). `token`: the path segment every relayed request must carry; `origins`: the page origins allowed to use it; `port`: for the status page's texts. `server.recent` keeps the last requests (method, target, status, time) for the page.
 */
function createRelay({ token, origins = DEFAULT_ORIGINS, timeoutMs = 60000, port = DEFAULT_PORT } = {}) {
  if (!token) throw new Error('createRelay needs a token');
  const allowed = new Set(origins.map(origin => origin.replace(/\/$/, '')));
  const recent = [];
  const note = item => { recent.push({ at: Date.now(), ...item }); if (recent.length > RECENT) recent.splice(0, recent.length - RECENT); };
  const cors = (origin, res, extra = {}) => { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); for (const [name, value] of Object.entries(extra)) res.setHeader(name, value); };
  const fail = (res, status, message) => { res.statusCode = status; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(message); };
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin ?? '';
    const url = new URL(req.url, 'http://relay.invalid');
    // the status page and its data: only to this computer's own names (a site that rebinds its domain to 127.0.0.1 gets nothing)
    if (url.pathname === '/' || url.pathname === '/status.json') {
      const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return fail(res, 403, 'forbidden host');
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'");
      if (url.pathname === '/status.json') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ version: VERSION, recent })); }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(statusPage({ proxyUrl: `http://127.0.0.1:${port}/${token}/?url={url}`, port }));
    }
    if (url.pathname !== `/${token}/` && url.pathname !== `/${token}`) return fail(res, 404, 'unknown path');
    if (!allowed.has(origin)) return fail(res, 403, `origin not allowed: ${origin || '(none)'}; start the relay with --origin ${origin || '<origin>'}`);
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {   // the browser's preflight
      cors(origin, res, { 'Access-Control-Allow-Methods': req.headers['access-control-request-method'], 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '', 'Access-Control-Max-Age': '600', ...(req.headers['access-control-request-private-network'] ? { 'Access-Control-Allow-Private-Network': 'true' } : {}) });
      res.statusCode = 204; return res.end();
    }
    const target = url.searchParams.get('url'), started = Date.now();
    let parsed; try { parsed = new URL(target ?? ''); } catch { cors(origin, res); return fail(res, 400, 'missing or invalid url parameter'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { cors(origin, res); return fail(res, 400, `unsupported scheme ${parsed.protocol}`); }
    const shown = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;   // the log keeps no query string (it may carry keys or tokens)
    const relayError = (code, message) => { note({ method: req.method, url: shown, status: 502, error: code, ms: Date.now() - started }); cors(origin, res, { 'x-apkweb-relay-error-code': code, 'x-apkweb-relay-error': message.replace(/[\r\n]+/g, ' ').slice(0, 300), 'Access-Control-Expose-Headers': 'x-apkweb-relay-error-code, x-apkweb-relay-error' }); fail(res, 502, `${code}: ${message}`); };
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      const lower = name.toLowerCase(), values = Array.isArray(value) ? value : [value];
      if (lower.startsWith('x-apkweb-')) { const original = lower.slice('x-apkweb-'.length); if (original !== 'accept-encoding' && !HOP_BY_HOP.has(original)) for (const v of values) headers.append(original, v); continue; }
      if (HOP_BY_HOP.has(lower) || FROM_BROWSER.has(lower) || lower.startsWith('sec-') || lower.startsWith('access-control-')) continue;
      for (const v of values) headers.append(name, v);
    }
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { cors(origin, res); return fail(res, 413, 'request body over 32 MiB'); } chunks.push(chunk); }
      body = Buffer.concat(chunks);
    }
    let response;
    try { response = await send(parsed, req.method, headers, body, timeoutMs); }
    catch (error) { return relayError(error?.code ?? 'EFETCH', String(error?.message ?? error)); }
    const exposed = [];
    for (const [name, value] of Object.entries(response.headers)) { const lower = name.toLowerCase(); if (RESPONSE_DROP.has(lower) || lower.startsWith('access-control-')) continue; res.setHeader(name, value); exposed.push(name); }
    const cookies = response.headers['set-cookie'] ?? [];
    if (cookies.length) { res.setHeader('x-apkweb-set-cookie', JSON.stringify(cookies)); exposed.push('x-apkweb-set-cookie'); }
    cors(origin, res, exposed.length ? { 'Access-Control-Expose-Headers': exposed.join(', ') } : {});
    res.statusCode = response.statusCode; res.statusMessage = response.statusMessage || res.statusMessage;
    note({ method: req.method, url: shown, status: response.statusCode, ms: Date.now() - started });
    if (req.method === 'HEAD') { response.resume(); return res.end(); }
    response.on('error', () => res.destroy()).pipe(res);
  });
  server.recent = recent;
  server.on('upgrade', (req, socket) => tunnel({ req, socket, token, allowed, timeoutMs, note }));
  return server;
}

// ---- TCP tunnel (/<token>/tcp): a TCP stream for a socket of the lab whose conversation is not HTTP/1.1 (HTTP/2 with prior knowledge, as gRPC clients speak; MQTT; a database
// protocol). The page opens a WebSocket here (ws://127.0.0.1:<port>/<token>/tcp?host=&port=&tls=0|1&alpn=), the relay connects to the target from this machine and copies the bytes
// both ways. First message (text JSON): {"connected":true,"alpn":...} or {"error":{"code","message"}}; then binary messages are the TCP bytes. tls=1: the relay does the TLS (the lab
// hands the app's plaintext, as its fetch path does) with the ALPN list asked for, and reports the protocol the server chose. Same origin, token and private-address rules as above.
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsFrame(opcode, payload) {
  const n = payload.length, head = n < 126 ? 2 : n < 65536 ? 4 : 10, out = Buffer.alloc(head + n);
  out[0] = 0x80 | opcode; if (n < 126) out[1] = n; else if (n < 65536) { out[1] = 126; out.writeUInt16BE(n, 2); } else { out[1] = 127; out.writeUInt32BE(Math.floor(n / 0x100000000), 2); out.writeUInt32BE(n >>> 0, 6); }
  payload.copy?.(out, head) ?? out.set(payload, head); return out;
}
/** The client frames (masked) of a WebSocket byte stream: push(chunk) -> [{ opcode, payload }] (fragments joined). */
function wsDecoder() {
  let buffer = Buffer.alloc(0), parts = null, partsOpcode = 0;
  return chunk => {
    buffer = Buffer.concat([buffer, chunk]); const out = [];
    for (;;) {
      if (buffer.length < 2) break;
      const fin = (buffer[0] & 0x80) !== 0, opcode = buffer[0] & 0x0f, masked = (buffer[1] & 0x80) !== 0; let length = buffer[1] & 0x7f, at = 2;
      if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); at = 4; } else if (length === 127) { if (buffer.length < 10) break; length = buffer.readUInt32BE(2) * 0x100000000 + buffer.readUInt32BE(6); at = 10; }
      const mask = at; if (masked) at += 4; if (buffer.length < at + length) break;
      const payload = Buffer.from(buffer.subarray(at, at + length)); if (masked) for (let i = 0; i < length; i++) payload[i] ^= buffer[mask + (i & 3)];
      buffer = buffer.subarray(at + length);
      if (opcode >= 0x8) { out.push({ opcode, payload }); continue; }
      if (opcode === 0) parts?.push(payload); else { parts = [payload]; partsOpcode = opcode; }
      if (fin && parts) { out.push({ opcode: partsOpcode, payload: Buffer.concat(parts) }); parts = null; }
    }
    return out;
  };
}
async function tunnel({ req, socket, token, allowed, timeoutMs, note = () => {} }) {
  const url = new URL(req.url, 'http://relay.invalid'), origin = req.headers.origin ?? '';
  const refuse = (status, text, message) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${message}`); };
  if (url.pathname !== `/${token}/tcp`) return refuse(404, 'Not Found', 'unknown path');
  if (!allowed.has(origin)) return refuse(403, 'Forbidden', `origin not allowed: ${origin || '(none)'}`);
  const key = req.headers['sec-websocket-key']; if (!key || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return refuse(400, 'Bad Request', 'a WebSocket upgrade is expected');
  const host = url.searchParams.get('host') ?? '', port = Number(url.searchParams.get('port')), secure = url.searchParams.get('tls') === '1', alpn = (url.searchParams.get('alpn') ?? '').split(',').map(p => p.trim()).filter(Boolean);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return refuse(400, 'Bad Request', 'host and port are required');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${createHash('sha1').update(key + WS_GUID).digest('base64')}`, '', ''].join('\r\n'));
  socket.setNoDelay?.(true);
  const say = value => { if (!socket.destroyed) socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(value)))); };
  const closeFrame = code => wsFrame(0x8, Buffer.from([code >> 8, code & 255]));
  const fail = (code, message) => { say({ error: { code, message: String(message).replace(/[\r\n]+/g, ' ').slice(0, 300) } }); socket.end(closeFrame(1011)); };
  socket.on('error', () => {});
  let connected = false; const started = Date.now();
  const upstream = secure ? tls.connect({ host, port, servername: isIP(host) ? undefined : host, ALPNProtocols: alpn.length ? alpn : undefined }) : net.connect({ host, port });
  const timer = setTimeout(() => { if (!connected) { upstream.destroy(); fail('ETIMEDOUT', `connect to ${host}:${port} timed out after ${timeoutMs} ms`); } }, timeoutMs);
  upstream.once(secure ? 'secureConnect' : 'connect', () => { connected = true; clearTimeout(timer); upstream.setNoDelay?.(true); say({ connected: true, alpn: secure ? upstream.alpnProtocol || null : null }); note({ method: 'TCP', url: `${secure ? 'tls' : 'tcp'}://${host}:${port}`, status: 101, ms: Date.now() - started }); });
  upstream.on('data', chunk => { if (!socket.destroyed) socket.write(wsFrame(0x2, chunk)); });
  upstream.on('error', error => { clearTimeout(timer); if (!connected) { note({ method: 'TCP', url: `tcp://${host}:${port}`, status: 502, error: error.code ?? 'ECONNREFUSED', ms: Date.now() - started }); } if (!connected) fail(error.code ?? 'ECONNREFUSED', error.message); else socket.destroy(); });
  upstream.on('close', () => { clearTimeout(timer); if (connected && !socket.destroyed) socket.end(closeFrame(1000)); });
  const decode = wsDecoder();
  socket.on('data', chunk => {
    for (const { opcode, payload } of decode(chunk)) {
      if (opcode === 0x2 || opcode === 0x1) { if (!upstream.destroyed) upstream.write(payload); }
      else if (opcode === 0x9) socket.write(wsFrame(0xA, payload));
      else if (opcode === 0x8) { upstream.end(); if (!socket.destroyed) socket.end(closeFrame(1000)); }
    }
  });
  socket.on('close', () => { clearTimeout(timer); upstream.destroy(); });
}



// ---- the desktop app: settings kept between runs, the command line, the browser opened on the status page ----------------------------------------------------------------
function configDir(env = process.env, platform = process.platform, home = os.homedir()) {
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'apk-lab-relay');
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'apk-lab-relay');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'apk-lab-relay');
}
function loadSettings(dir) {
  let saved = {}; try { saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')); } catch { saved = {}; }
  return saved && typeof saved === 'object' ? saved : {};
}
function saveSettings(dir, settings) {
  try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 }); return true; } catch { return false; }
}
const HELP = `APK Lab Relay ${VERSION}: APK Browser Lab requests without CORS errors.

Usage: apk-lab-relay [options]
  --port <n>           port on 127.0.0.1 (default ${DEFAULT_PORT}; saved)
  --origin <url>       a page that may use the relay (repeat for several; saved; default: the published lab and a local copy)
  --token <text>       use this token in the address (saved)
  --new-token          make a new token (the Proxy address changes)
  --no-open            do not open the status page in the browser
  --version, --help`;
function parseArguments(argv) {
  const options = { port: null, origins: [], token: null, newToken: false, open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = () => { if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`); return argv[++i]; };
    if (arg === '--port') options.port = Number(value());
    else if (arg === '--origin') options.origins.push(value().replace(/\/$/, ''));
    else if (arg === '--token') options.token = value();
    else if (arg === '--new-token') options.newToken = true;
    else if (arg === '--allow-private' || arg === '--no-allow-private') continue;   // older versions blocked private destinations; every destination is reachable now, so the option does nothing
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg.startsWith('-psn_')) continue;   // macOS adds a process serial number when the app is opened from Finder
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error('--port must be 1 to 65535');
  if (options.token !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(options.token)) throw new Error('--token: 8 to 128 letters, digits, _ or -');
  for (const origin of options.origins) { let parsed; try { parsed = new URL(origin); } catch { throw new Error(`invalid --origin: ${origin}`); } if (parsed.origin !== origin) throw new Error(`--origin must be only scheme, host and port (e.g. ${parsed.origin})`); }
  return options;
}
/** The settings of this run: saved ones, overridden by the command line (which is saved for the next runs). */
function resolveSettings(saved, options) {
  const token = options.token ?? (options.newToken || typeof saved.token !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(saved.token) ? randomBytes(12).toString('hex') : saved.token);
  return { token, port: options.port ?? (Number.isInteger(saved.port) ? saved.port : DEFAULT_PORT), origins: options.origins.length ? options.origins : Array.isArray(saved.origins) && saved.origins.length ? saved.origins.map(String) : DEFAULT_ORIGINS };
}
function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try { const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true }); child.on('error', () => {}); child.unref(); } catch { /* no browser to open: the address is printed */ }
}
const pause = () => new Promise(resolve => { if (!process.stdin.isTTY) return resolve(); process.stdout.write('\nPress Enter to exit.'); process.stdin.resume(); process.stdin.once('data', () => resolve()); });

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArguments(argv); } catch (error) { console.error(`${error.message}\n\n${HELP}`); await pause(); process.exitCode = 2; return; }
  if (options.help) { console.log(HELP); return; }
  if (options.version) { console.log(VERSION); return; }
  const dir = configDir(), settings = resolveSettings(loadSettings(dir), options);
  const saved = saveSettings(dir, settings);
  const server = createRelay({ token: settings.token, origins: settings.origins, port: settings.port });
  const page = `http://127.0.0.1:${settings.port}/`, proxyUrl = `http://127.0.0.1:${settings.port}/${settings.token}/?url={url}`;
  server.on('error', async error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${settings.port} is already in use. If it is another APK Lab Relay, use that one (${page}); otherwise start with --port <another>.`);
      if (options.open) openBrowser(page);
    } else console.error(`Could not start: ${error.message}`);
    await pause(); process.exit(1);
  });
  server.listen(settings.port, '127.0.0.1', () => {
    console.log(`APK Lab Relay ${VERSION} on http://127.0.0.1:${settings.port} (only this computer can reach it)`);
    console.log(`Allowed pages: ${settings.origins.join(', ')}`);
    console.log('Destinations: any (the internet, this computer and the local network)');
    console.log(`\nPaste into the lab's Proxy field (Controls > Device > Proxy):\n  ${proxyUrl}\n`);
    console.log(`Status page: ${page}${saved ? '' : '\n(the settings could not be saved: the token changes next time)'}`);
    console.log('Keep this window open while you use the lab. Ctrl+C stops it.');
    if (options.open) openBrowser(page);
  });
  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

module.exports = { VERSION, DEFAULT_PORT, DEFAULT_ORIGINS, createRelay, configDir, loadSettings, saveSettings, parseArguments, resolveSettings, main };
const isSea = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();   // the single executable built by scripts/build-sea.mjs
if (isSea || require.main === module) main();
