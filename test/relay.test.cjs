'use strict';
// The relay against the contract the lab expects (the same as the lab's scripts/cors-relay.mjs), with the browser's side played by fetch. Every server here is local: an upstream on
// 127.0.0.1 (reached with allowPrivate, as only the tests need) and the relay itself; no request leaves this computer.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const { createRelay, privateAddress, parseArguments, resolveSettings, configDir, loadSettings, saveSettings, DEFAULT_ORIGINS } = require('../src/relay.cjs');

const ORIGIN = 'https://lab.example.test', TOKEN = 'test-token-123';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const upstream = http.createServer((req, res) => {
  const chunks = []; req.on('data', chunk => chunks.push(chunk)); req.on('end', () => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/final' }); return res.end(); }
    if (req.url === '/see-other') { res.writeHead(303, { Location: '/final' }); return res.end(); }
    if (req.url === '/away') { res.writeHead(302, { Location: `http://localhost:${upstreamPort}/final` }); return res.end(); }
    if (req.url === '/gzip') { res.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Type': 'text/plain' }); return res.end(gzipSync('compressed body')); }
    res.setHeader('Set-Cookie', ['session=abc; Path=/', 'theme=dark; HttpOnly']);
    res.setHeader('Access-Control-Allow-Origin', 'https://not-the-lab.example');   // the upstream's own CORS headers never reach the page
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }));
  });
});
let upstreamPort;
const relays = [];
async function relay(options = {}) { const server = createRelay({ token: TOKEN, origins: [ORIGIN], ...options }); relays.push(server); const port = await listen(server); return { server, port, base: `http://127.0.0.1:${port}` }; }
const target = p => `http://127.0.0.1:${upstreamPort}${p}`;
const via = (base, url, init = {}) => fetch(`${base}/${TOKEN}/?url=${encodeURIComponent(url)}`, { ...init, headers: { origin: ORIGIN, ...(init.headers ?? {}) } });
test.before(async () => { upstreamPort = await listen(upstream); });
test.after(() => { upstream.close(); for (const server of relays) server.close(); });

test("a GET goes out with the app's own Cookie and User-Agent (x-apkweb-*) and none of the page's; both Set-Cookie values come back; CORS for the page only", async () => {
  const { base } = await relay({ allowPrivate: true });
  const response = await via(base, target('/hello?x=1'), { headers: { 'x-apkweb-user-agent': 'Dalvik/2.1.0 (Linux; U; Android 13)', 'x-apkweb-cookie': 'a=1', 'X-App': 'yes', 'sec-fetch-mode': 'cors' } });
  assert.equal(response.status, 200);
  const seen = await response.json();
  assert.equal(seen.url, '/hello?x=1'); assert.equal(seen.headers['user-agent'], 'Dalvik/2.1.0 (Linux; U; Android 13)'); assert.equal(seen.headers.cookie, 'a=1'); assert.equal(seen.headers['x-app'], 'yes');
  assert.equal(seen.headers.origin, undefined, "the page's origin does not reach the server"); assert.equal(seen.headers['sec-fetch-mode'], undefined); assert.equal(seen.headers['accept-encoding'], undefined);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.deepEqual(JSON.parse(response.headers.get('x-apkweb-set-cookie')), ['session=abc; Path=/', 'theme=dark; HttpOnly']);
  assert.match(response.headers.get('access-control-expose-headers'), /x-apkweb-set-cookie/); assert.match(response.headers.get('access-control-expose-headers'), /content-type/i);
});

test('a POST body passes through; redirects are followed (303 turns into GET) and credentials do not follow to another host', async () => {
  const { base } = await relay({ allowPrivate: true });
  const posted = await (await via(base, target('/echo'), { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })).json();
  assert.deepEqual([posted.method, posted.body, posted.headers['content-type']], ['POST', '{"a":1}', 'application/json']);
  assert.equal((await (await via(base, target('/redirect'))).json()).url, '/final');
  const other = await (await via(base, target('/see-other'), { method: 'POST', body: 'x' })).json(); assert.deepEqual([other.method, other.body], ['GET', '']);
  const away = await (await via(base, target('/away'), { headers: { 'x-apkweb-cookie': 'secret=1', authorization: 'Bearer t' } })).json();
  assert.equal(away.headers.cookie, undefined); assert.equal(away.headers.authorization, undefined);
});

test('a compressed body is passed as the server sent it, with its Content-Encoding', async () => {
  const { port } = await relay({ allowPrivate: true });
  const raw = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: `/${TOKEN}/?url=${encodeURIComponent(target('/gzip'))}`, headers: { origin: ORIGIN } }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) })); }).on('error', reject));
  assert.equal(raw.headers['content-encoding'], 'gzip'); assert.equal(gunzipSync(raw.body).toString(), 'compressed body');
});

test('the preflight answers what the browser asks, private network access included', async () => {
  const { base } = await relay({ allowPrivate: true });
  const response = await fetch(`${base}/${TOKEN}/?url=x`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-apkweb-cookie, content-type', 'access-control-request-private-network': 'true' } });
  assert.equal(response.status, 204);
  assert.deepEqual([response.headers.get('access-control-allow-methods'), response.headers.get('access-control-allow-headers'), response.headers.get('access-control-allow-private-network'), response.headers.get('access-control-allow-origin')], ['PUT', 'x-apkweb-cookie, content-type', 'true', ORIGIN]);
});

test('refusals: a wrong token, another page, a bad url; private targets unless allowed; an unreachable target is a 502 with the code the lab maps', async () => {
  const { base } = await relay();
  assert.equal((await fetch(`${base}/wrong/?url=${encodeURIComponent(target('/'))}`, { headers: { origin: ORIGIN } })).status, 404);
  const other = await fetch(`${base}/${TOKEN}/?url=${encodeURIComponent(target('/'))}`, { headers: { origin: 'https://evil.example' } }); assert.equal(other.status, 403); assert.equal(other.headers.get('access-control-allow-origin'), null);
  assert.equal((await via(base, 'nota url')).status, 400); assert.equal((await via(base, 'file:///etc/passwd')).status, 400);
  const blocked = await via(base, target('/'));
  assert.equal(blocked.status, 403); assert.equal(blocked.headers.get('x-apkweb-relay-error-code'), 'APKWEB_RELAY_PRIVATE');
  const resolved = await relay({ lookup: async () => [{ address: '10.0.0.5' }] });   // a public name that resolves to a private address is refused too
  assert.equal((await via(resolved.base, 'http://intranet.example.test/')).headers.get('x-apkweb-relay-error-code'), 'APKWEB_RELAY_PRIVATE');
  const unknown = await relay({ lookup: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND nowhere.invalid'), { code: 'ENOTFOUND' }); } });
  const missing = await via(unknown.base, 'http://nowhere.invalid/');
  assert.equal(missing.status, 502); assert.equal(missing.headers.get('x-apkweb-relay-error-code'), 'ENOTFOUND'); assert.match(missing.headers.get('access-control-expose-headers'), /x-apkweb-relay-error-code/);
  const closed = http.createServer(); const closedPort = await listen(closed); closed.close();
  const { base: open } = await relay({ allowPrivate: true });
  const refused = await via(open, `http://127.0.0.1:${closedPort}/`); assert.equal(refused.status, 502); assert.equal(refused.headers.get('x-apkweb-relay-error-code'), 'ECONNREFUSED');
});

test('the status page: only for this computer\'s own names, with the proxy address and the recent requests (no query strings)', async () => {
  const { base, port, server } = await relay({ allowPrivate: true, port: 9999 });
  await via(base, target('/logged?key=secret'));
  const page = await fetch(`${base}/`); assert.equal(page.status, 200); const html = await page.text();
  assert.match(html, new RegExp(`http://127\\.0\\.0\\.1:9999/${TOKEN}/\\?url=\\{url\\}`)); assert.match(html, /lab\.example\.test/);
  const status = await (await fetch(`${base}/status.json`)).json(); assert.equal(status.recent.at(-1).url, target('/logged')); assert.equal(status.recent.at(-1).status, 200);
  assert.ok(!JSON.stringify(server.recent).includes('secret'));
  const rebound = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'attacker.example:80' } }, res => { res.resume(); resolve(res.statusCode); }));
  assert.equal(rebound, 403, 'a page reached through another name (DNS rebinding) gets nothing');
});

test('private addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:192.168.0.1']) assert.equal(privateAddress(address), true, address);
  for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:4860:4860::8888', 'example.com']) assert.equal(privateAddress(address), false, address);
});

test('settings: the command line over the saved ones, a token kept between runs, the config folder of each system', () => {
  assert.deepEqual(parseArguments([]), { port: null, origins: [], token: null, newToken: false, allowPrivate: null, open: true });
  const parsed = parseArguments(['--port', '9000', '--origin', 'http://localhost:5173/', '--allow-private', '--no-open', '-psn_0_123']);
  assert.deepEqual([parsed.port, parsed.origins, parsed.allowPrivate, parsed.open], [9000, ['http://localhost:5173'], true, false]);
  for (const bad of [['--port', '0'], ['--port'], ['--origin', 'http://x.example/path'], ['--token', 'a b'], ['--what']]) assert.throws(() => parseArguments(bad), undefined, bad.join(' '));
  const first = resolveSettings({}, parseArguments([])); assert.match(first.token, /^[0-9a-f]{24}$/); assert.deepEqual([first.port, first.origins, first.allowPrivate], [8787, DEFAULT_ORIGINS, false]);
  assert.equal(resolveSettings(first, parseArguments([])).token, first.token, 'the same address next time');
  assert.notEqual(resolveSettings(first, parseArguments(['--new-token'])).token, first.token);
  assert.equal(resolveSettings({ ...first, allowPrivate: true }, parseArguments(['--no-allow-private'])).allowPrivate, false);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-test-'));
  try { assert.equal(saveSettings(dir, first), true); assert.deepEqual(loadSettings(dir), first); assert.deepEqual(loadSettings(path.join(dir, 'none')), {}); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(configDir({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32', 'C:\\Users\\a'), path.join('C:\\Users\\a\\AppData\\Roaming', 'apk-lab-relay'));
  assert.equal(configDir({}, 'darwin', '/Users/a'), path.join('/Users/a', 'Library', 'Application Support', 'apk-lab-relay'));
  assert.equal(configDir({ XDG_CONFIG_HOME: '/x' }, 'linux', '/home/a'), path.join('/x', 'apk-lab-relay'));
});

test('the TCP tunnel: a WebSocket on /<token>/tcp connects to the target and copies bytes both ways; private targets, closed ports and other pages are refused', async () => {
  const net = require('node:net');
  const target = net.createServer(socket => socket.on('data', chunk => socket.write(Buffer.concat([Buffer.from('<'), chunk, Buffer.from('>')]))));
  const targetPort = await listen(target);
  const open = (port, query, origin = ORIGIN) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/${TOKEN}/tcp?${query}`, { headers: { origin } }), messages = []; socket.binaryType = 'arraybuffer';
    socket.onmessage = event => messages.push(typeof event.data === 'string' ? JSON.parse(event.data) : Buffer.from(event.data).toString());
    const until = async (check, what) => { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`${what}: ${JSON.stringify(messages)}`); };
    return { socket, messages, until };
  };
  const { port, server } = await relay({ allowPrivate: true });
  const live = open(port, `host=127.0.0.1&port=${targetPort}&tls=0`);
  await live.until(() => live.messages.length, 'connected'); assert.deepEqual(live.messages[0], { connected: true, alpn: null });
  live.socket.send(new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'));
  await live.until(() => live.messages.length > 1, 'the echo'); assert.equal(live.messages.slice(1).join(''), '<PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n>');
  assert.equal(server.recent.at(-1).method, 'TCP', 'the status page lists the tunnel');
  live.socket.close();
  const strict = await relay(), refused = open(strict.port, `host=127.0.0.1&port=${targetPort}`);
  await refused.until(() => refused.messages.length, 'refused'); assert.equal(refused.messages[0].error.code, 'APKWEB_RELAY_PRIVATE');
  const stranger = new WebSocket(`ws://127.0.0.1:${port}/${TOKEN}/tcp?host=127.0.0.1&port=${targetPort}`, { headers: { origin: 'https://evil.example' } });
  assert.equal(await new Promise(resolve => { stranger.onopen = () => resolve('open'); stranger.onerror = () => resolve('refused'); }), 'refused');
  refused.socket.close(); target.close(); for (const s of [server, strict.server]) s.closeAllConnections?.();
});
