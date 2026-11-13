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
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { isIP } = require('node:net');
const dns = require('node:dns/promises');
const { spawn } = require('node:child_process');

const VERSION = '0.1.0';
const DEFAULT_PORT = 8787;
const DEFAULT_ORIGINS = ['https://madmax-dev-br.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length', 'expect']);
const FROM_BROWSER = new Set(['origin', 'referer', 'cookie', 'accept-encoding', 'user-agent']);   // the browser's own values (the app's, if it set them, come as x-apkweb-*)
const RESPONSE_DROP = new Set(['transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);   // Content-Encoding stays: the browser decodes the body as it would from the server itself
const MAX_BODY = 32 * 1024 * 1024;
const RECENT = 50;

/** True for addresses on this computer or the local network: loopback, RFC 1918, link-local, CGNAT, unique-local IPv6, unspecified. */
function privateAddress(address) {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (kind === 6) {
    const v = address.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v); if (mapped) return privateAddress(mapped[1]);
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  return false;
}

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
function statusPage({ proxyUrl, origins, allowPrivate, port }) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>APK Lab Relay</title>
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
<p>Rodando em 127.0.0.1:${port}. Enquanto este programa estiver aberto, o APK Browser Lab alcança qualquer servidor sem erro de CORS.</p>
<section><h2>Endereço para o campo Proxy</h2><p>No lab: Controles › Dispositivo › Proxy. Cole o endereço abaixo.</p>
<div class="url"><input id="proxy" readonly value="${escapeHtml(proxyUrl)}" aria-label="Endereço do proxy"><button id="copy" type="button">Copiar</button></div></section>
<section><h2>Páginas que podem usar o relay</h2><ul>${origins.map(origin => `<li>${escapeHtml(origin)}</li>`).join('')}</ul>
<p style="margin-top:10px">Destinos na rede local: ${allowPrivate ? 'permitidos' : 'bloqueados (inicie com --allow-private para liberar)'}.</p></section>
<section><h2>Últimas requisições</h2><table><thead><tr><th>Hora</th><th>Método</th><th>Status</th><th>ms</th><th>Destino</th></tr></thead><tbody id="log"><tr><td colspan="5" class="empty">Nenhuma ainda.</td></tr></tbody></table></section>
</main><script>
document.getElementById('copy').addEventListener('click', async () => { const input = document.getElementById('proxy'); try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); } document.getElementById('copy').textContent = 'Copiado'; setTimeout(() => { document.getElementById('copy').textContent = 'Copiar'; }, 1500); });
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
 * The relay as an http.Server (not listening yet). `token`: the path segment every relayed request must carry; `origins`: the page origins allowed to use it; `allowPrivate`: also
 * relay to private addresses; `lookup`: injectable for tests; `port`: for the status page's texts. `server.recent` keeps the last requests (method, target, status, time) for the page.
 */
function createRelay({ token, origins = DEFAULT_ORIGINS, allowPrivate = false, lookup = dns.lookup, timeoutMs = 60000, port = DEFAULT_PORT } = {}) {
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
      return res.end(statusPage({ proxyUrl: `http://127.0.0.1:${port}/${token}/?url={url}`, origins: [...allowed], allowPrivate, port }));
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
    if (!allowPrivate) {
      const host = parsed.hostname.replace(/^\[|\]$/g, '');
      let addresses;
      try { addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }); } catch (error) { return relayError(error.code ?? 'ENOTFOUND', error.message ?? String(error)); }
      if (addresses.some(entry => privateAddress(entry.address))) {   // named in the relay-error headers too, so the lab reports it as a connect failure instead of handing the app a 403
        const message = `${host} is on this machine or the local network; start the relay with --allow-private to reach it`;
        note({ method: req.method, url: shown, status: 403, error: 'APKWEB_RELAY_PRIVATE', ms: Date.now() - started });
        cors(origin, res, { 'x-apkweb-relay-error-code': 'APKWEB_RELAY_PRIVATE', 'x-apkweb-relay-error': message, 'Access-Control-Expose-Headers': 'x-apkweb-relay-error-code, x-apkweb-relay-error' }); return fail(res, 403, message);
      }
    }
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
  return server;
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
const HELP = `APK Lab Relay ${VERSION}: requisições do APK Browser Lab sem erro de CORS.

Uso: apk-lab-relay [opções]
  --port <n>           porta em 127.0.0.1 (padrão ${DEFAULT_PORT}; fica salva)
  --origin <url>       página que pode usar o relay (repita para várias; fica salva; padrão: o lab publicado e uma cópia local)
  --allow-private      permite destinos neste computador e na rede local (fica salvo; --no-allow-private desliga)
  --token <texto>      usa este token no endereço (fica salvo)
  --new-token          gera um token novo (o endereço do Proxy muda)
  --no-open            não abre o navegador na página de status
  --version, --help`;
function parseArguments(argv) {
  const options = { port: null, origins: [], token: null, newToken: false, allowPrivate: null, open: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = () => { if (i + 1 >= argv.length) throw new Error(`${arg} precisa de um valor`); return argv[++i]; };
    if (arg === '--port') options.port = Number(value());
    else if (arg === '--origin') options.origins.push(value().replace(/\/$/, ''));
    else if (arg === '--token') options.token = value();
    else if (arg === '--new-token') options.newToken = true;
    else if (arg === '--allow-private') options.allowPrivate = true;
    else if (arg === '--no-allow-private') options.allowPrivate = false;
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg.startsWith('-psn_')) continue;   // macOS adds a process serial number when the app is opened from Finder
    else throw new Error(`opção desconhecida: ${arg}`);
  }
  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error('--port precisa ser de 1 a 65535');
  if (options.token !== null && !/^[A-Za-z0-9_-]{8,128}$/.test(options.token)) throw new Error('--token: 8 a 128 letras, números, _ ou -');
  for (const origin of options.origins) { let parsed; try { parsed = new URL(origin); } catch { throw new Error(`--origin inválida: ${origin}`); } if (parsed.origin !== origin) throw new Error(`--origin precisa ser só esquema, host e porta (ex.: ${parsed.origin})`); }
  return options;
}
/** The settings of this run: saved ones, overridden by the command line (which is saved for the next runs). */
function resolveSettings(saved, options) {
  const token = options.token ?? (options.newToken || typeof saved.token !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(saved.token) ? randomBytes(12).toString('hex') : saved.token);
  return { token, port: options.port ?? (Number.isInteger(saved.port) ? saved.port : DEFAULT_PORT), origins: options.origins.length ? options.origins : Array.isArray(saved.origins) && saved.origins.length ? saved.origins.map(String) : DEFAULT_ORIGINS,
    allowPrivate: options.allowPrivate ?? saved.allowPrivate === true };
}
function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try { const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true }); child.on('error', () => {}); child.unref(); } catch { /* no browser to open: the address is printed */ }
}
const pause = () => new Promise(resolve => { if (!process.stdin.isTTY) return resolve(); process.stdout.write('\nPressione Enter para sair.'); process.stdin.resume(); process.stdin.once('data', () => resolve()); });

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArguments(argv); } catch (error) { console.error(`${error.message}\n\n${HELP}`); await pause(); process.exitCode = 2; return; }
  if (options.help) { console.log(HELP); return; }
  if (options.version) { console.log(VERSION); return; }
  const dir = configDir(), settings = resolveSettings(loadSettings(dir), options);
  const saved = saveSettings(dir, settings);
  const server = createRelay({ token: settings.token, origins: settings.origins, allowPrivate: settings.allowPrivate, port: settings.port });
  const page = `http://127.0.0.1:${settings.port}/`, proxyUrl = `http://127.0.0.1:${settings.port}/${settings.token}/?url={url}`;
  server.on('error', async error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`A porta ${settings.port} já está em uso. Se for outro APK Lab Relay aberto, use aquele (${page}); senão, inicie com --port <outra>.`);
      if (options.open) openBrowser(page);
    } else console.error(`Não foi possível iniciar: ${error.message}`);
    await pause(); process.exit(1);
  });
  server.listen(settings.port, '127.0.0.1', () => {
    console.log(`APK Lab Relay ${VERSION} em http://127.0.0.1:${settings.port} (só este computador alcança)`);
    console.log(`Páginas permitidas: ${settings.origins.join(', ')}`);
    console.log(`Destinos na rede local: ${settings.allowPrivate ? 'permitidos' : 'bloqueados'}`);
    console.log(`\nCole no campo Proxy do lab (Controles > Dispositivo > Proxy):\n  ${proxyUrl}\n`);
    console.log(`Página de status: ${page}${saved ? '' : '\n(as configurações não puderam ser salvas: o token muda na próxima vez)'}`);
    console.log('Deixe esta janela aberta enquanto usa o lab. Ctrl+C encerra.');
    if (options.open) openBrowser(page);
  });
  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

module.exports = { VERSION, DEFAULT_PORT, DEFAULT_ORIGINS, privateAddress, createRelay, configDir, loadSettings, saveSettings, parseArguments, resolveSettings, main };
const isSea = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();   // the single executable built by scripts/build-sea.mjs
if (isSea || require.main === module) main();
