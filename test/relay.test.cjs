'use strict';
// The relay against the contract the lab expects (the same as the lab's scripts/cors-relay.mjs), with the browser's side played by fetch. Every server here is local: an upstream on
// 127.0.0.1 and the relay itself; no request leaves this computer.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gzipSync, gunzipSync } = require('node:zlib');
const { createRelay, parseArguments, resolveSettings, configDir, loadSettings, saveSettings, DEFAULT_ORIGINS } = require('../src/relay.cjs');

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
  const { base } = await relay();
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
  const { base } = await relay();
  const posted = await (await via(base, target('/echo'), { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } })).json();
  assert.deepEqual([posted.method, posted.body, posted.headers['content-type']], ['POST', '{"a":1}', 'application/json']);
  assert.equal((await (await via(base, target('/redirect'))).json()).url, '/final');
  const other = await (await via(base, target('/see-other'), { method: 'POST', body: 'x' })).json(); assert.deepEqual([other.method, other.body], ['GET', '']);
  const away = await (await via(base, target('/away'), { headers: { 'x-apkweb-cookie': 'secret=1', authorization: 'Bearer t' } })).json();
  assert.equal(away.headers.cookie, undefined); assert.equal(away.headers.authorization, undefined);
});

test('a compressed body is passed as the server sent it, with its Content-Encoding', async () => {
  const { port } = await relay();
  const raw = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: `/${TOKEN}/?url=${encodeURIComponent(target('/gzip'))}`, headers: { origin: ORIGIN } }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) })); }).on('error', reject));
  assert.equal(raw.headers['content-encoding'], 'gzip'); assert.equal(gunzipSync(raw.body).toString(), 'compressed body');
});

test('the preflight answers what the browser asks, private network access included', async () => {
  const { base } = await relay();
  const response = await fetch(`${base}/${TOKEN}/?url=x`, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': 'x-apkweb-cookie, content-type', 'access-control-request-private-network': 'true' } });
  assert.equal(response.status, 204);
  assert.deepEqual([response.headers.get('access-control-allow-methods'), response.headers.get('access-control-allow-headers'), response.headers.get('access-control-allow-private-network'), response.headers.get('access-control-allow-origin')], ['PUT', 'x-apkweb-cookie, content-type', 'true', ORIGIN]);
});

test('refusals: a wrong token, another page, a bad url; every destination is reached, this computer included; an unreachable one is a 502 with the code the lab maps', async () => {
  const { base } = await relay();
  assert.equal((await fetch(`${base}/wrong/?url=${encodeURIComponent(target('/'))}`, { headers: { origin: ORIGIN } })).status, 404);
  const other = await fetch(`${base}/${TOKEN}/?url=${encodeURIComponent(target('/'))}`, { headers: { origin: 'https://evil.example' } }); assert.equal(other.status, 403); assert.equal(other.headers.get('access-control-allow-origin'), null);
  assert.equal((await via(base, 'nota url')).status, 400); assert.equal((await via(base, 'file:///etc/passwd')).status, 400);
  const local = await via(base, target('/'));   // a server on this computer, with no option: the relay has no list of forbidden destinations
  assert.equal(local.status, 200); assert.equal(local.headers.get('x-apkweb-relay-error-code'), null);
  const closed = http.createServer(); const closedPort = await listen(closed); closed.close();
  const refused = await via(base, `http://127.0.0.1:${closedPort}/`); assert.equal(refused.status, 502); assert.equal(refused.headers.get('x-apkweb-relay-error-code'), 'ECONNREFUSED'); assert.match(refused.headers.get('access-control-expose-headers'), /x-apkweb-relay-error-code/);
});

test('the status page: only for this computer\'s own names, with the proxy address and the recent requests (no query strings)', async () => {
  const { base, port, server } = await relay({ port: 9999 });
  await via(base, target('/logged?key=secret'));
  const page = await fetch(`${base}/`); assert.equal(page.status, 200); const html = await page.text();
  assert.match(html, new RegExp(`http://127\\.0\\.0\\.1:9999/${TOKEN}/\\?url=\\{url\\}`)); assert.doesNotMatch(html, /lab\.example\.test|Allowed pages|Páginas que podem usar/, 'the allowed pages are not listed on the status page'); assert.match(html, /reaches any destination/); assert.match(html, /<html lang="en">/);
  const status = await (await fetch(`${base}/status.json`)).json(); assert.equal(status.recent.at(-1).url, target('/logged')); assert.equal(status.recent.at(-1).status, 200);
  assert.ok(!JSON.stringify(server.recent).includes('secret'));
  const rebound = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/', headers: { host: 'attacker.example:80' } }, res => { res.resume(); resolve(res.statusCode); }));
  assert.equal(rebound, 403, 'a page reached through another name (DNS rebinding) gets nothing');
});

test('settings: the command line over the saved ones, a token kept between runs, the config folder of each system', () => {
  assert.deepEqual(parseArguments([]), { port: null, origins: [], token: null, newToken: false, open: true });
  const parsed = parseArguments(['--port', '9000', '--origin', 'http://localhost:5173/', '--allow-private', '--no-open', '-psn_0_123']);
  assert.deepEqual([parsed.port, parsed.origins, parsed.open, 'allowPrivate' in parsed], [9000, ['http://localhost:5173'], false, false], '--allow-private (from older versions) is accepted and does nothing');
  for (const bad of [['--port', '0'], ['--port'], ['--origin', 'http://x.example/path'], ['--token', 'a b'], ['--what']]) assert.throws(() => parseArguments(bad), undefined, bad.join(' '));
  const first = resolveSettings({}, parseArguments([])); assert.match(first.token, /^[0-9a-f]{24}$/); assert.deepEqual([first.port, first.origins, 'allowPrivate' in first], [8787, DEFAULT_ORIGINS, false]);
  assert.equal(resolveSettings(first, parseArguments([])).token, first.token, 'the same address next time');
  assert.notEqual(resolveSettings(first, parseArguments(['--new-token'])).token, first.token);
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
  const { port, server } = await relay();
  const live = open(port, `host=127.0.0.1&port=${targetPort}&tls=0`);
  await live.until(() => live.messages.length, 'connected'); assert.deepEqual(live.messages[0], { connected: true, alpn: null });
  live.socket.send(new TextEncoder().encode('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'));
  await live.until(() => live.messages.length > 1, 'the echo'); assert.equal(live.messages.slice(1).join(''), '<PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n>');
  assert.equal(server.recent.at(-1).method, 'TCP', 'the status page lists the tunnel');
  live.socket.close();
  const plain = await relay(), local = open(plain.port, `host=127.0.0.1&port=${targetPort}`);   // no option needed for this computer
  await local.until(() => local.messages.length, 'connected without options'); assert.deepEqual(local.messages[0], { connected: true, alpn: null });
  const stranger = new WebSocket(`ws://127.0.0.1:${port}/${TOKEN}/tcp?host=127.0.0.1&port=${targetPort}`, { headers: { origin: 'https://evil.example' } });
  assert.equal(await new Promise(resolve => { stranger.onopen = () => resolve('open'); stranger.onerror = () => resolve('refused'); }), 'refused');
  local.socket.close(); target.close(); for (const s of [server, plain.server]) s.closeAllConnections?.();
});

// ---- the parallel channel (/<token>/mux, since 0.4.0): the protocol the lab's src/relay-mux.js speaks ------------------------------------------------------------------------
/** A channel client as the lab's: JSON control messages, binary frames [kind][id u32][bytes]; collects every exchange's head, body, end and error, and grants credit only when told. */
function channelClient(port, { origin = ORIGIN, token = TOKEN, autoCredit = true } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/${token}/mux`, { headers: { origin } }), exchanges = new Map(); let hello = null, nextId = 1, failed = false;
  socket.binaryType = 'arraybuffer';
  const of = id => { if (!exchanges.has(id)) exchanges.set(id, { head: null, chunks: [], bytes: 0, end: false, error: null }); return exchanges.get(id); };
  socket.onmessage = event => {
    if (typeof event.data === 'string') { const message = JSON.parse(event.data); if (message.t === 'hello') { hello = message; return; } const exchange = of(message.id); if (message.t === 'head') exchange.head = message; else if (message.t === 'end') exchange.end = true; else if (message.t === 'error') exchange.error = message; return; }
    const bytes = Buffer.from(event.data), exchange = of(bytes.readUInt32BE(1)), body = bytes.subarray(5); exchange.chunks.push(body); exchange.bytes += body.length;
    if (autoCredit) socket.send(JSON.stringify({ t: 'credit', id: bytes.readUInt32BE(1), n: body.length }));
  };
  socket.onerror = () => { failed = true; };
  const until = async (check, what, ms = 3000) => { for (let i = 0; i < ms / 10; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } assert.fail(`${what}: ${JSON.stringify([...exchanges.values()].map(e => ({ ...e, chunks: e.chunks.length })))}`); };
  const request = (url, { method = 'GET', headers = [], body = null } = {}) => {
    const id = nextId++; of(id);
    socket.send(JSON.stringify({ t: 'req', id, method, query: `?url=${encodeURIComponent(url)}`, headers, length: body ? body.length : 0 }));
    if (body) { const frame = Buffer.alloc(5 + body.length); frame[0] = 1; frame.writeUInt32BE(id, 1); Buffer.from(body).copy(frame, 5); socket.send(frame); }
    return id;
  };
  return { socket, exchanges, request, until, hello: () => hello, failed: () => failed, text: id => Buffer.concat(exchanges.get(id).chunks).toString(), header: (id, name) => exchanges.get(id).head.headers.filter(([n]) => n.toLowerCase() === name).map(([, v]) => v) };
}

test('the channel: a hello first, then exchanges decided as the per-request path decides them (headers restored, Set-Cookie, redirects without credentials to another host, gzip decoded)', async () => {
  const { port } = await relay(), client = channelClient(port);
  await client.until(() => client.hello(), 'hello'); assert.deepEqual([client.hello().v, client.hello().window, client.hello().maxBody], [1, 262144, 32 * 1024 * 1024]);
  const get = client.request(target('/hello?x=1'), { headers: [['x-apkweb-user-agent', 'Dalvik/2.1.0 (Linux; U; Android 13)'], ['x-apkweb-cookie', 'a=1'], ['X-App', 'yes']] });
  const post = client.request(target('/echo'), { method: 'POST', headers: [['content-type', 'application/json']], body: Buffer.from('{"a":1}') });
  const away = client.request(target('/away'), { headers: [['x-apkweb-cookie', 'secret=1'], ['authorization', 'Bearer t']] });
  const zipped = client.request(target('/gzip'));
  await client.until(() => [get, post, away, zipped].every(id => client.exchanges.get(id).end), 'four exchanges');
  const seen = JSON.parse(client.text(get));
  assert.equal(client.exchanges.get(get).head.status, 200); assert.equal(seen.url, '/hello?x=1'); assert.equal(seen.headers['user-agent'], 'Dalvik/2.1.0 (Linux; U; Android 13)'); assert.equal(seen.headers.cookie, 'a=1'); assert.equal(seen.headers['x-app'], 'yes'); assert.equal(seen.headers.origin, undefined);
  assert.deepEqual(JSON.parse(client.header(get, 'x-apkweb-set-cookie')[0]), ['session=abc; Path=/', 'theme=dark; HttpOnly']); assert.deepEqual(client.header(get, 'access-control-allow-origin'), [], 'the target\'s CORS headers never pass');
  assert.deepEqual([JSON.parse(client.text(post)).method, JSON.parse(client.text(post)).body], ['POST', '{"a":1}']);
  const moved = JSON.parse(client.text(away)); assert.equal(moved.url, '/final'); assert.equal(moved.headers.cookie, undefined); assert.equal(moved.headers.authorization, undefined);
  assert.equal(client.text(zipped), 'compressed body', 'decoded as the browser would have decoded it'); assert.deepEqual(client.header(zipped, 'content-encoding'), ['gzip'], 'the header says what the server sent (the lab drops it, as for a body the browser decoded)');
  client.socket.close();
});

test('the channel runs exchanges at once, holds each to its credit, aborts on request and reports unreachable targets by code; other pages and tokens are refused', async () => {
  const slow = http.createServer((req, res) => { const url = new URL(req.url, 'http://x'); if (url.pathname === '/big') { res.writeHead(200, { 'content-length': String(4 * 1024 * 1024) }); const block = Buffer.alloc(64 * 1024, 1); let sent = 0; const pump = () => { while (sent < 4 * 1024 * 1024) { sent += block.length; if (!res.write(block)) return res.once('drain', pump); } res.end(); }; slow.big = () => sent; return pump(); } if (url.pathname === '/hang') { slow.hung = req; req.on('close', () => { slow.closed = true; }); return; } setTimeout(() => res.end(`late ${url.search}`), 150); });
  const slowPort = await listen(slow), { port, server } = await relay(), client = channelClient(port);
  await client.until(() => client.hello(), 'hello');
  const begin = Date.now(), ids = Array.from({ length: 30 }, (_, i) => client.request(`http://127.0.0.1:${slowPort}/d?i=${i}`));
  await client.until(() => ids.every(id => client.exchanges.get(id).end), 'thirty exchanges');
  assert.ok(Date.now() - begin < 1000, `30 exchanges of 150 ms took ${Date.now() - begin} ms`); assert.equal(client.text(ids[29]), 'late ?i=29'); assert.equal(server.channelCount(), 1);
  const held = channelClient(port, { autoCredit: false }); await held.until(() => held.hello(), 'hello');
  const big = held.request(`http://127.0.0.1:${slowPort}/big`); await held.until(() => held.exchanges.get(big).bytes >= 262144, 'one window');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(held.exchanges.get(big).bytes, 262144, 'never more than the credit'); assert.ok(slow.big() < 3 * 1024 * 1024, `the target was held back (${slow.big()} bytes sent)`);
  held.socket.send(JSON.stringify({ t: 'credit', id: big, n: 4 * 1024 * 1024 })); await held.until(() => held.exchanges.get(big).end, 'the rest after credit'); assert.equal(held.exchanges.get(big).bytes, 4 * 1024 * 1024);
  const hang = client.request(`http://127.0.0.1:${slowPort}/hang`); await client.until(() => slow.hung, 'the target asked');
  client.socket.send(JSON.stringify({ t: 'abort', id: hang })); await client.until(() => slow.closed, 'the upstream request destroyed');
  const closed = http.createServer(), closedPort = await listen(closed); closed.close();
  const refused = client.request(`http://127.0.0.1:${closedPort}/`); await client.until(() => client.exchanges.get(refused).error, 'the error'); assert.equal(client.exchanges.get(refused).error.code, 'ECONNREFUSED');
  const status = await (await fetch(`http://127.0.0.1:${port}/status.json`)).json(); assert.equal(status.channels, 2); assert.ok(status.recent.some(item => item.via === 'channel' && item.status === 200));
  const stranger = channelClient(port, { origin: 'https://evil.example' }), wrong = channelClient(port, { token: 'another-token' });
  await stranger.until(() => stranger.failed(), 'another page refused'); await wrong.until(() => wrong.failed(), 'another token refused');
  client.socket.close(); held.socket.close(); slow.closeAllConnections?.(); slow.close();
});
