'use strict';
// WebView documents through the relay (src/webview.cjs): the lab's side is played by a WebSocket client, the frame's by http requests with the slot's Host header. Every server is
// local (an upstream on 127.0.0.1 and the relay itself); no request leaves this computer.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createRelay } = require('../src/relay.cjs');
const { injectIntoHead, rewriteMarkup } = require('../src/webview.cjs');

const ORIGIN = 'https://lab.example.test', TOKEN = 'test-token-123';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const seen = [];
const upstream = http.createServer((req, res) => {
  const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    seen.push({ url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url === '/start') { res.writeHead(302, { Location: '/signin?step=1', 'Set-Cookie': 'step=1; Path=/' }); return res.end(); }
    if (req.url.startsWith('/signin')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'Set-Cookie': ['oauth_token=secret-1; Path=/; Secure; HttpOnly'] });
      return res.end(`<!doctype html><html><head><title>Sign in</title><link rel="stylesheet" href="http://localhost:${upstreamPort}/theme.css"></head><body><img src="/logo.png"><a href="https://other.example/x">x</a></body></html>`);
    }
    if (req.url === '/theme.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); return res.end(`body{background:url(http://127.0.0.1:${upstreamPort}/bg.png)}`); }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ path: req.url }));
  });
});
let upstreamPort; const relays = [];
test.before(async () => { upstreamPort = await listen(upstream); });
test.after(() => { upstream.close(); for (const server of relays) server.close(); });

async function setup() {
  const server = createRelay({ token: TOKEN, origins: [ORIGIN] }); relays.push(server); const port = await listen(server);
  const ws = new WebSocket(`ws://127.0.0.1:${port}/${TOKEN}/webview`, { headers: { origin: ORIGIN } });
  const inbox = [], waiters = [];
  ws.onmessage = event => { const message = JSON.parse(event.data); inbox.push(message); for (const w of [...waiters]) if (w.match(message)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(message); } };
  const next = match => { const found = inbox.find(match); if (found) { inbox.splice(inbox.indexOf(found), 1); return Promise.resolve(found); } return new Promise(resolve => waiters.push({ match: m => { if (!match(m)) return false; inbox.splice(inbox.indexOf(m), 1); return true; }, resolve })); };
  await next(m => m.t === 'hello');
  const say = value => ws.send(JSON.stringify(value));
  return { server, port, ws, next, say };
}
/** A request as the frame makes it: to 127.0.0.1 with the slot's Host header (a browser resolves *.localhost itself). */
function frame(slotUrl, { method = 'GET', headers = {}, body = null } = {}) {
  const url = new URL(slotUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: url.port, path: url.pathname + url.search, method, headers: { host: url.host, ...headers } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end(body);
  });
}

test('a document: decided by the lab (cookie, user agent, inject), framing headers and Set-Cookie kept from the browser, redirects through slots, URLs of other origins rewritten', async () => {
  const { next, say, port } = await setup();
  say({ t: 'open', id: 1, view: 7, url: `http://127.0.0.1:${upstreamPort}/start` });
  const opened = await next(m => m.t === 'opened');
  assert.match(opened.frameUrl, new RegExp(`^http://[a-f0-9]{20}\\.localhost:${port}/start$`));
  const first = frame(opened.frameUrl, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', cookie: 'browser=1', 'user-agent': 'BrowserUA' } });
  const ask1 = await next(m => m.t === 'request');
  assert.deepEqual([ask1.view, ask1.url, ask1.method, ask1.nav, ask1.dest, ask1.redirectOf], [7, `http://127.0.0.1:${upstreamPort}/start`, 'GET', true, 'iframe', null]);
  say({ t: 'decision', rid: ask1.rid, allow: true, cookie: 'sid=app', userAgent: 'AppUA wv' });
  const response1 = await next(m => m.t === 'response' && m.rid === ask1.rid);
  assert.deepEqual(response1.setCookie, ['step=1; Path=/']);
  assert.equal(response1.location, `http://127.0.0.1:${upstreamPort}/signin?step=1`);
  const redirect = await first;
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers['set-cookie'], undefined);
  assert.equal(redirect.headers.location, `${new URL(opened.frameUrl).origin}/signin?step=1`);
  assert.equal(seen.at(-1).headers.cookie, 'sid=app'); assert.equal(seen.at(-1).headers['user-agent'], 'AppUA wv');

  const second = frame(redirect.headers.location, { headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } });
  const ask2 = await next(m => m.t === 'request');
  assert.equal(ask2.redirectOf, ask1.rid);
  say({ t: 'decision', rid: ask2.rid, allow: true, cookie: 'sid=app; step=1', inject: '<script>/*bridge*/</script>' });
  const response2 = await next(m => m.t === 'response' && m.rid === ask2.rid);
  assert.deepEqual(response2.setCookie, ['oauth_token=secret-1; Path=/; Secure; HttpOnly']);
  const page = await second;
  assert.equal(page.status, 200);
  for (const name of ['x-frame-options', 'content-security-policy', 'set-cookie']) assert.equal(page.headers[name], undefined, name);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.body, /^<!doctype html><html><head><script>\/\*bridge\*\/<\/script><title>Sign in<\/title>/);
  const css = /href="(http:\/\/([a-f0-9]{20})\.localhost:\d+)\/theme\.css"/.exec(page.body);
  assert.ok(css, page.body); assert.notEqual(css[1], new URL(opened.frameUrl).origin);
  assert.match(page.body, /<img src="\/logo\.png">/);
  assert.match(page.body, /href="http:\/\/[a-f0-9]{20}\.localhost:\d+\/x"/);
  const slots = []; for (;;) { const m = await Promise.race([next(x => x.t === 'slot'), new Promise(r => setTimeout(() => r(null), 50))]); if (!m) break; slots.push(m.origin); }
  assert.ok(slots.includes(`http://localhost:${upstreamPort}`) && slots.includes('https://other.example'), slots.join());

  const stylesheet = frame(`${css[1]}/theme.css`);
  const ask3 = await next(m => m.t === 'request');
  assert.equal(ask3.url, `http://localhost:${upstreamPort}/theme.css`); assert.equal(ask3.nav, false);
  say({ t: 'decision', rid: ask3.rid, allow: true });
  const sheet = await stylesheet;
  assert.match(sheet.body, new RegExp(`url\\(${new URL(opened.frameUrl).origin}/bg\\.png\\)`));
});

test('the lab refuses (a network error for the frame), answers itself, cancels a navigation; a synchronous call waits for its answer; /__apkweb/go; forget', async () => {
  const { next, say } = await setup();
  say({ t: 'open', id: 2, view: 1, url: `http://127.0.0.1:${upstreamPort}/data` });
  const { frameUrl } = await next(m => m.t === 'opened');
  const refused = frame(frameUrl).then(() => 'answered', () => 'network error');
  say({ t: 'decision', rid: (await next(m => m.t === 'request')).rid, allow: false, reason: 'refused-by-allowlist' });
  assert.equal(await refused, 'network error');

  const own = frame(frameUrl);
  say({ t: 'decision', rid: (await next(m => m.t === 'request')).rid, allow: true, respond: { status: 200, mime: 'application/json', body: Buffer.from('{"from":"app"}').toString('base64') } });
  assert.deepEqual(JSON.parse((await own).body), { from: 'app' });

  const cancelled = frame(frameUrl, { headers: { 'sec-fetch-mode': 'navigate' } });
  say({ t: 'decision', rid: (await next(m => m.t === 'request')).rid, allow: false, status: 204 });
  assert.equal((await cancelled).status, 204);

  const call = frame(new URL('/__apkweb/js', frameUrl).href, { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: JSON.stringify({ key: 'k', name: 'mm', method: 'getAccounts', args: [] }) });
  const asked = await next(m => m.t === 'call');
  assert.equal(asked.kind, 'js'); assert.equal(asked.view, 1); assert.deepEqual(asked.body, { key: 'k', name: 'mm', method: 'getAccounts', args: [] });
  say({ t: 'result', cid: asked.cid, body: { ok: true, value: '["a@example.test"]' } });
  const answered = await call;
  assert.equal(answered.headers['access-control-allow-origin'], 'null'); assert.deepEqual(JSON.parse(answered.body), { ok: true, value: '["a@example.test"]' });

  const go = await frame(new URL(`/__apkweb/go?u=${encodeURIComponent('https://cdn.example/lib.js?v=2')}`, frameUrl).href);
  assert.equal(go.status, 307); assert.match(go.headers.location, /^http:\/\/[a-f0-9]{20}\.localhost:\d+\/lib\.js\?v=2$/);

  say({ t: 'forget', view: 1 });
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await frame(frameUrl)).status, 404);
});

test('the channel needs the token and an allowed origin; a closed channel takes its slots with it', async () => {
  const { port, next, say, ws, server } = await setup();
  const refused = await new Promise(resolve => { const bad = new WebSocket(`ws://127.0.0.1:${port}/${TOKEN}/webview`, { headers: { origin: 'https://evil.example' } }); bad.onopen = () => resolve('open'); bad.onerror = () => resolve('refused'); });
  assert.equal(refused, 'refused');
  say({ t: 'open', id: 3, view: 2, url: `http://127.0.0.1:${upstreamPort}/data` });
  const { frameUrl } = await next(m => m.t === 'opened');
  assert.equal(server.webviewChannelCount(), 1);
  ws.close(); await new Promise(r => setTimeout(r, 100));
  assert.equal(server.webviewChannelCount(), 0);
  assert.equal((await frame(frameUrl)).status, 404);
});

test('markup helpers: injection after <head> keeps the doctype first; attribute and CSS URLs of any origin are mapped, relative ones are not', () => {
  assert.equal(injectIntoHead('<!DOCTYPE html><HTML><HEAD lang=x><title>t</title>', 'X'), '<!DOCTYPE html><HTML><HEAD lang=x>X<title>t</title>');
  assert.equal(injectIntoHead('<p>no head</p>', 'X'), 'X<p>no head</p>');
  const map = url => `[${url}]`;
  assert.equal(rewriteMarkup('<img src="//a.example/i.png" srcset="https://b.example/1x.png 1x, /2x.png 2x"><a href=\'rel\'>', map), '<img src="[//a.example/i.png]" srcset="[https://b.example/1x.png] 1x, [/2x.png] 2x"><a href=\'[rel]\'>');
  assert.equal(rewriteMarkup('a{b:url("https://c.example/x.png")} d{e:url(/y.png)}', map, { html: false }), 'a{b:url("[https://c.example/x.png]")} d{e:url(/y.png)}');
});
