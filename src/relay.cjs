'use strict';
// APK Lab Relay: a small desktop app that lets APK Browser Lab reach any server without CORS errors.
//
// A browser refuses every response whose server does not authorise the page's origin (CORS), and the servers a real Android app talks to never authorise the lab. The lab can send
// its requests through a relay instead, and this is that relay: it repeats each request from this computer, as the device would send it, and answers the page with CORS headers.
// The relay itself (everything down to "the desktop app") is the lab's scripts/cors-relay.mjs, published at
// https://madmax-dev-br.github.io/apk-browser-lab-site/tools/cors-relay.mjs, plus the status page and its list of recent requests:
//  - GET /hello from an allowed page says this is the APK Lab Relay (since 0.6.0): the lab finds it on port 8787 by itself, with no token and no address to copy. An address from an
//    older version (/<token>/?url={url}) keeps working: that first path segment is accepted and ignored;
//  - the target is the `url` query parameter; headers a browser may not send (Cookie, User-Agent, Origin, Referer ...) arrive as `x-apkweb-<name>` and go out under their own name;
//  - redirects are followed here (a browser hides redirect responses from the page); credentials never follow a redirect to another host;
//  - Set-Cookie, which a browser never exposes, comes back as `x-apkweb-set-cookie`: a JSON array of the Set-Cookie values;
//  - a failure to reach the target is a 502 with `x-apkweb-relay-error-code` (ENOTFOUND, ECONNREFUSED, ETIMEDOUT, ECONNRESET, CERT_..., the codes Node uses) and
//    `x-apkweb-relay-error`, which the lab turns into the exception an Android device would throw (UnknownHostException, ConnectException, SSLHandshakeException ...);
//  - client certificates (mutual TLS, since 0.6.0; presented only to the request that names them since 0.7.0): the lab hands over the one an app chose for a destination; it is kept in memory only and presented to that destination alone;
//  - the parallel channel (since 0.4.0; /mux, a WebSocket): many exchanges at once over one connection, with a credit window per exchange (protocol at muxChannel and in README.md);
//  - WebView documents (since 0.5.0; src/webview.cjs): the lab's WebViews show web pages served here on http://<label>.localhost:<port>, every request decided by the lab.
//
// Safety: it listens on 127.0.0.1 only, and every request (WebSocket upgrades included) must come from one of the allowed page origins, so another site open in the same browser
// cannot use it. There is no token: a program on this computer can use the relay as it could reach the network by itself. Destinations are not restricted. Nothing is stored but the
// settings (port, origins): what the app sends passes through and is forgotten.
const STATUS_ICON = 'data:image/png;base64,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';
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, createPrivateKey, X509Certificate } = require('node:crypto');
const net = require('node:net');
const tls = require('node:tls');
const zlib = require('node:zlib');
const { Readable } = require('node:stream');
const { isIP } = net;
const { spawn } = require('node:child_process');
const { createWebViewRelay } = require('./webview.cjs');
const { readFileSync, statSync } = fs;

const VERSION = '0.7.0';
const RECENT = 50;
const DEFAULT_ORIGINS = ['https://madmax-dev-br.github.io', 'http://127.0.0.1:8765', 'http://localhost:8765'];
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length', 'expect']);
const FROM_BROWSER = new Set(['origin', 'referer', 'cookie', 'accept-encoding', 'user-agent']);   // the browser's own values (the app's, if it set them, come as x-apkweb-*)
const RESPONSE_DROP = new Set(['transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);   // Content-Encoding stays: the browser decodes the body as it would from the server itself
const MAX_BODY = 32 * 1024 * 1024;
const NO_IDENTITY_CODE = 'APKWEB_RELAY_NO_CLIENT_IDENTITY', FEATURES = 'client-identity';
const DEFAULT_PORT = 8787, RELAY_NAME = 'apk-lab-relay';
const ENDPOINTS = new Set(['hello', 'mux', 'webview', 'tcp']), SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;
/**
 * What a path asks for: 'request' (/ with ?url=...), 'hello', 'mux', 'webview', 'tcp', or null. An address from an older relay carried a token as its first segment
 * (/<token>/?url=, /<token>/mux ...): that segment is accepted and ignored, so a Proxy address saved before keeps working.
 */
function relayRoute(pathname) {
  const parts = String(pathname ?? '').split('/').slice(1);   // '/a/b' -> ['a', 'b']; '/' -> ['']
  if (parts.length === 1) return parts[0] === '' ? 'request' : ENDPOINTS.has(parts[0]) ? parts[0] : SEGMENT.test(parts[0]) ? 'request' : null;
  if (parts.length === 2 && SEGMENT.test(parts[0]) && !ENDPOINTS.has(parts[0])) return parts[1] === '' ? 'request' : ENDPOINTS.has(parts[1]) ? parts[1] : null;
  return null;
}


/**
 * The relay as an http.Server (not listening yet). `origins`: the page origins allowed to use it `port`: for the status page's texts. `server.recent` keeps the last requests (method, target, status, time) for the page. Upstream requests go through node:http(s), not fetch: fetch adds headers of its own (Sec-Fetch-Mode, Accept-Language ...) that the app
 * never sent; here the target sees exactly the app's request.
 */
function createRelay({ origins = DEFAULT_ORIGINS, timeoutMs = 60000, ca: caOption = null, lookup = null, port = DEFAULT_PORT } = {}) {
  const ca = typeof caOption === 'function' ? caOption : () => caOption;   // a function is asked at every connection (caFromFiles: a changed --ca file takes effect without a restart)
  const allowed = new Set(origins.map(origin => origin.replace(/\/$/, '')));
  const identities = new Map();   // 'host:port' -> { key, cert } (PEM) and its id, the device's client identity for that destination, in memory only
  const agents = keepAliveAgents();   // upstream connections kept alive per destination, for the per-request path and the channel alike
  const transport = { agents, ...(lookup ? { lookup: nodeLookup(lookup) } : {}) };   // lookup: the name resolver of the upstream connections (tests answer it locally; Node's dns.lookup otherwise)
  const recent = [];
  const note = item => { recent.push({ at: Date.now(), ...item }); if (recent.length > RECENT) recent.splice(0, recent.length - RECENT); };
  const cors = (origin, res, extra = {}) => { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); for (const [name, value] of Object.entries(extra)) res.setHeader(name, value); };
  const fail = (res, status, message) => { res.statusCode = status; res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.end(message); };
  const server = http.createServer(async (req, res) => {
    if (webview.owns(req)) return webview.serve(req, res);   // a WebView document (http://<label>.localhost:<port>/...): src/webview.cjs
    const origin = req.headers.origin ?? '';
    const url = new URL(req.url, 'http://relay.invalid'), route = relayRoute(url.pathname);
    // the status page and its data: only to this computer's own names (a site that rebinds its domain to 127.0.0.1 gets nothing). A relayed request is the same path with ?url=
    if ((url.pathname === '/' && !url.searchParams.has('url')) || url.pathname === '/status.json') {
      const host = String(req.headers.host ?? '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') return fail(res, 403, 'forbidden host');
      if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method not allowed');
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; connect-src 'self'; frame-ancestors 'none'");
      if (url.pathname === '/status.json') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ version: VERSION, channels: sessions.size, recent })); }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(statusPage({ port }));
    }
    if (route !== 'request' && route !== 'hello') return fail(res, 404, 'unknown path');
    if (!allowed.has(origin)) return fail(res, 403, `origin not allowed: ${origin || '(none)'}; start the relay with --origin ${origin || '<origin>'}`);
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {   // the browser's preflight
      cors(origin, res, { 'Access-Control-Allow-Methods': req.headers['access-control-request-method'], 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '', 'Access-Control-Max-Age': '600', ...(req.headers['access-control-request-private-network'] ? { 'Access-Control-Allow-Private-Network': 'true' } : {}) });
      res.statusCode = 204; return res.end();
    }
    if (route === 'hello') {   // the lab's detection (src/relay-detect.js): this is the APK Lab Relay, and what it has
      cors(origin, res); res.statusCode = 200; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
      return res.end(JSON.stringify({ relay: RELAY_NAME, version: VERSION, features: ['client-identity', 'mux', 'webview', 'tcp'] }));
    }
    const target = url.searchParams.get('url'), started = Date.now();
    let parsed; try { parsed = new URL(target ?? ''); } catch { cors(origin, res); return fail(res, 400, 'missing or invalid url parameter'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { cors(origin, res); return fail(res, 400, `unsupported scheme ${parsed.protocol}`); }
    const features = { 'x-apkweb-relay-features': FEATURES, 'Access-Control-Expose-Headers': 'x-apkweb-relay-features' };   // "this relay keeps client identities" (the lab sends a key to no other)
    if (url.searchParams.get('client-identity') === 'forget-all' && req.method === 'POST') { identities.clear(); cors(origin, res, features); res.statusCode = 204; return res.end(); }   // a new lab session: the identities of the previous one are gone
    if (url.searchParams.get('client-identity') === '1') {
      if (req.method !== 'POST' || parsed.protocol !== 'https:') { cors(origin, res); return fail(res, 400, 'a client identity is POSTed for an https:// destination'); }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { cors(origin, res); return fail(res, 413, 'client identity over 1 MiB'); } chunks.push(chunk); }
      let identity; try { identity = parseIdentity(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { cors(origin, res); return fail(res, 400, `invalid client identity: ${error.message}`); }
      const where = destination(parsed.hostname, parsed.port || '443');
      if (identity) identities.set(where, identity); else identities.delete(where);
      cors(origin, res, features); res.statusCode = 204; return res.end();
    }
    const shown = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;   // the list keeps no query string (it may carry keys or tokens)
    const relayError = (code, message) => { note({ method: req.method, url: shown, status: 502, error: code, ms: Date.now() - started }); cors(origin, res, { 'x-apkweb-relay-error-code': code, 'x-apkweb-relay-error': message.replace(/[\r\n]+/g, ' ').slice(0, 300), 'Access-Control-Expose-Headers': 'x-apkweb-relay-error-code, x-apkweb-relay-error' }); fail(res, 502, `${code}: ${message}`); };
    const missing = missingIdentity(identities, url.searchParams, parsed.protocol === 'https:' ? destination(parsed.hostname, parsed.port || '443') : null);
    if (missing) { req.resume(); return relayError(NO_IDENTITY_CODE, missing); }
    const headers = upstreamHeaders(Object.entries(req.headers));
    let body;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { cors(origin, res); return fail(res, 413, 'request body over 32 MiB'); } chunks.push(chunk); }
      body = Buffer.concat(chunks);
    }
    let response;
    try { response = await send(parsed, req.method, headers, body, timeoutMs, 0, identities, ca, { ...transport, identityKey: url.searchParams.get('client-identity-key') }); }
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
  const sessions = new Set();   // the open channels, so close() ends them (a WebSocket is not an HTTP request the server would wait for)
  // WebView documents: one hop per request (the frame follows redirects itself, so the lab decides each one), with the relay's resolver, --ca roots and client identities
  const webview = createWebViewRelay({ allowed, timeoutMs, note, port: () => server.address()?.port ?? port,
    upstream: (target, method, headers, body, { signal, timeoutMs: ms }) => send(target, method, headers, body, ms ?? timeoutMs, 0, identities, ca, { ...transport, signal, manualRedirects: true }) });
  server.on('upgrade', (req, socket) => {
    const route = relayRoute(new URL(req.url, 'http://relay.invalid').pathname);
    if (route === 'webview') return webview.channel(req, socket);
    if (route === 'mux') return muxChannel({ req, socket, allowed, answer: exchange => relayAnswer({ ...exchange, identities, ca, timeoutMs, transport }), sessions,
      onExchange: (exchange, outcome) => { let shown = ''; try { const parsed = new URL(exchange.params.get('url') ?? ''); shown = `${parsed.protocol}//${parsed.host}${parsed.pathname}`; } catch { shown = '(invalid url)'; } note({ method: exchange.method, url: shown, status: exchange.status ?? 502, ...(outcome && outcome !== 'aborted' ? { error: outcome } : {}), ...(outcome === 'aborted' ? { error: 'aborted' } : {}), ms: Date.now() - exchange.started, via: 'channel' }); } });
    return tunnel({ req, socket, route, allowed, timeoutMs, identities, ca, note });
  });
  const close = server.close.bind(server);   // an upgraded socket keeps the server open, so close() ends the channels and the kept-alive upstream connections first
  server.close = callback => { webview.close(); for (const socket of sessions) socket.destroy(); for (const agent of Object.values(agents)) agent.destroy(); return close(callback); };
  server.recent = recent;
  server.clientIdentityCount = () => identities.size;
  server.channelCount = () => sessions.size;
  server.webviewChannelCount = () => webview.channelCount();
  server.closeChannels = () => { for (const socket of sessions) socket.destroy(); };   // drops every open channel at once (as a relay that stops does)
  return server;
}

/** A resolver given as a callback (dns.lookup's shape) or as a function returning a promise of { address, family } (or a list), in the callback form Node's sockets call. */
function nodeLookup(lookup) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    let settled = false;
    const done = (error, result) => { if (settled) return; settled = true; if (error) return callback(error); const list = Array.isArray(result) ? result : [result]; if (options?.all) callback(null, list); else callback(null, list[0].address, list[0].family); };
    try { const out = lookup(hostname, options, (error, address, family) => done(error, Array.isArray(address) ? address : { address, family })); if (out && typeof out.then === 'function') out.then(result => done(null, result), error => done(error)); }
    catch (error) { done(error); }
  };
}
/** One keep-alive agent per scheme: Node pools its connections per destination (host:port), so the exchanges to one server reuse their TCP (and TLS) connections. */
function keepAliveAgents() { return { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) }; }

/**
 * The headers the target gets, from the headers the lab sent ([name, value] entries, a value may be an array): the app's own, the ones a browser may not send restored from
 * `x-apkweb-<name>`, none of the browser's (Origin, Referer, Sec-*, its Cookie and User-Agent) and no hop-by-hop header. The same rule for the per-request path and the channel.
 */
function upstreamHeaders(entries) {
  const headers = new Headers();
  for (const [name, value] of entries) {
    const lower = String(name).toLowerCase(), values = Array.isArray(value) ? value : [value];
    if (lower.startsWith('x-apkweb-')) { const original = lower.slice('x-apkweb-'.length); if (original !== 'accept-encoding' && !HOP_BY_HOP.has(original)) for (const v of values) headers.append(original, v); continue; }
    if (HOP_BY_HOP.has(lower) || FROM_BROWSER.has(lower) || lower.startsWith('sec-') || lower.startsWith('access-control-')) continue;
    for (const v of values) headers.append(name, v);
  }
  return headers;
}
/** The target's response headers as the page gets them through the per-request path: hop-by-hop and the target's CORS headers left out, Set-Cookie as x-apkweb-set-cookie (JSON). */
function pageHeaders(response) {
  const out = [];
  for (const [name, value] of Object.entries(response.headers)) { const lower = name.toLowerCase(); if (RESPONSE_DROP.has(lower) || lower.startsWith('access-control-')) continue; for (const v of Array.isArray(value) ? value : [value]) out.push([name, String(v)]); }
  const cookies = response.headers['set-cookie'] ?? [];
  if (cookies.length) out.push(['x-apkweb-set-cookie', JSON.stringify(cookies)]);
  return out;
}

/**
 * One exchange of the channel, decided exactly as the per-request path decides it: `params` is the relay's query (url, client-identity-key), `headers` the lab's headers.
 * -> { local: { status, message } } (the relay's own answer: a bad url, a body over 32 MiB), { error: { code, message } } (the target could not be reached: the per-request path's
 * 502 with x-apkweb-relay-error-code), or { response } (the target's http.IncomingMessage, redirects already followed).
 */
async function relayAnswer({ method, params, headers: entries, body, length = 0, identities, ca, timeoutMs, transport = {}, signal }) {
  const target = params.get('url');
  let parsed; try { parsed = new URL(target ?? ''); } catch { return { local: { status: 400, message: 'missing or invalid url parameter' } }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { local: { status: 400, message: `unsupported scheme ${parsed.protocol}` } };
  if (params.get('client-identity')) return { local: { status: 400, message: 'a client identity is handed over the per-request path, not the channel' } };
  const missing = missingIdentity(identities, params, parsed.protocol === 'https:' ? destination(parsed.hostname, parsed.port || '443') : null);
  if (missing) return { error: { code: NO_IDENTITY_CODE, message: missing } };
  if (length > MAX_BODY) return { local: { status: 413, message: 'request body over 32 MiB' } };
  try { return { response: await send(parsed, method, upstreamHeaders(entries), method !== 'GET' && method !== 'HEAD' && body?.length ? body : undefined, timeoutMs, 0, identities, ca, { ...transport, signal, identityKey: params.get('client-identity-key') }) }; }
  catch (error) { return { error: { code: error?.code ?? 'EFETCH', message: String(error?.message ?? error).replace(/[\r\n]+/g, ' ').slice(0, 300) } }; }
}

// ---- The parallel channel (/mux) --------------------------------------------------------------------------------------------------------------------------------------------
// One WebSocket from the lab carries many exchanges at once, multiplexed by id; each runs here concurrently, through Node's HTTP client (keep-alive agents), decided by relayAnswer.
// Text messages are JSON control messages, binary messages body bytes: [kind u8][id u32 big-endian][bytes] (kind 1: request body, lab -> relay; kind 2: response body, relay -> lab).
//   relay -> lab  {"t":"hello","v":1,"window":262144,"maxBody":33554432,"frame":65536}       the first message: this relay has the channel (an older relay refuses the upgrade)
//   lab -> relay  {"t":"req","id":n,"method","query":"?url=...","headers":[[name,value]...],"length":bytes}   then `length` request body bytes in kind-1 frames (none above maxBody)
//   relay -> lab  {"t":"head","id":n,"status","statusText","headers":[[name,value]...]}       the headers the per-request path gives the page (x-apkweb-set-cookie included)
//   relay -> lab  kind-2 frames, never more than the credit the lab granted: `window` bytes at first, plus every {"t":"credit","id":n,"n":bytes} the lab sends as its reader consumes
//   relay -> lab  {"t":"end","id":n}  |  {"t":"error","id":n,"code","message"}   (before the head: the per-request path's 502 relay error; after it: the body failed)
//   lab -> relay  {"t":"abort","id":n}   the app closed the exchange: the upstream request is destroyed
// A Content-Encoding the browser would have decoded on the per-request path (gzip, deflate, br, zstd) is decoded here, nothing else: the lab gets the bytes the page would have got.
// Nothing is compressed, cached or kept. Backpressure: a full socket (write() false) holds every exchange's body until 'drain'; an exchange out of credit pauses its upstream.
const MUX_VERSION = 1;
const MUX_WINDOW = 256 * 1024, MUX_FRAME = 64 * 1024, KIND_REQUEST_BODY = 1, KIND_RESPONSE_BODY = 2;
const NULL_BODY = new Set([101, 103, 204, 205, 304]);   // statuses fetch gives no body for
/** A binary WebSocket frame (unmasked, server -> client) holding [kind][id][bytes], written in one buffer. */
function muxFrame(kind, id, bytes) {
  const n = 5 + bytes.length, head = n < 126 ? 2 : n < 65536 ? 4 : 10, out = Buffer.allocUnsafe(head + n);
  out[0] = 0x82; if (n < 126) out[1] = n; else if (n < 65536) { out[1] = 126; out.writeUInt16BE(n, 2); } else { out[1] = 127; out.writeUInt32BE(Math.floor(n / 0x100000000), 2); out.writeUInt32BE(n >>> 0, 6); }
  out[head] = kind; out.writeUInt32BE(id >>> 0, head + 1); bytes.copy(out, head + 5); return out;
}
/** The body as the page would have read it: a Content-Encoding the browser decodes (gzip, x-gzip, deflate zlib or raw, br, zstd) undone; any other (or several) left as it came. */
async function decodedBody(response) {
  const coding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();
  if (coding === 'gzip' || coding === 'x-gzip') return response.pipe(zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH }));
  if (coding === 'br') return response.pipe(zlib.createBrotliDecompress());
  if (coding === 'zstd' && typeof zlib.createZstdDecompress === 'function') return response.pipe(zlib.createZstdDecompress());
  if (coding !== 'deflate') return response;
  // "deflate" is zlib-wrapped by the standard, raw by some servers; a browser takes both. The first bytes say which.
  const first = await new Promise(resolve => { const done = value => { response.off('data', onData); response.off('end', onEnd); response.off('error', onEnd); response.pause(); resolve(value); }, onData = chunk => done(chunk), onEnd = () => done(null); response.on('data', onData); response.once('end', onEnd); response.once('error', onEnd); });
  if (!first) return Readable.from([]);
  const wrapped = first.length >= 2 && (first[0] & 0x0f) === 8 && ((first[0] << 8) | first[1]) % 31 === 0;
  const decoder = wrapped ? zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH }) : zlib.createInflateRaw({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
  decoder.write(first);
  if (response.readableEnded) decoder.end(); else response.pipe(decoder);   // a body of one chunk has ended already
  return decoder;
}
/** The channel's upgrade: the same origin rule as the per-request path. `answer(exchange)` decides an exchange (relayAnswer). */
function muxChannel({ req, socket, allowed, answer, sessions, onExchange = () => {} }) {
  const origin = req.headers.origin ?? '';
  const refuse = (status, text, message) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${message}`); };
  if (!allowed.has(origin)) return refuse(403, 'Forbidden', `origin not allowed: ${origin || '(none)'}`);
  const key = req.headers['sec-websocket-key']; if (!key || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return refuse(400, 'Bad Request', 'a WebSocket upgrade is expected');
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${createHash('sha1').update(key + WS_GUID).digest('base64')}`, '', ''].join('\r\n'));
  socket.setNoDelay?.(true); sessions?.add(socket);
  const exchanges = new Map(); let blocked = false, closed = false;
  const write = frame => { if (closed || socket.destroyed) return false; if (!socket.write(frame)) blocked = true; return true; };
  const say = value => write(wsFrame(0x1, Buffer.from(JSON.stringify(value))));
  const protocolError = text => { say({ t: 'error', id: 0, code: 'EPROTO', message: text }); closed = true; socket.end(wsFrame(0x8, Buffer.from([1002 >> 8, 1002 & 255]))); };
  const forget = exchange => { exchanges.delete(exchange.id); exchange.done = true; };
  const finish = exchange => { if (exchange.done) return; forget(exchange); say({ t: 'end', id: exchange.id }); onExchange(exchange, null); };
  const failed = (exchange, code, message) => { if (exchange.done) return; forget(exchange); say({ t: 'error', id: exchange.id, code, message: String(message).replace(/[\r\n]+/g, ' ').slice(0, 300) }); onExchange(exchange, code); };
  // sends what the exchange's credit and the socket allow; the upstream is paused while bytes wait, resumed once they left
  const pump = exchange => {
    while (exchange.pending.length && exchange.credit > 0 && !blocked && !exchange.done) {
      const chunk = exchange.pending[0], n = Math.min(chunk.length, exchange.credit, MUX_FRAME);
      write(muxFrame(KIND_RESPONSE_BODY, exchange.id, n === chunk.length ? chunk : chunk.subarray(0, n)));
      exchange.credit -= n; exchange.waiting -= n; if (n === chunk.length) exchange.pending.shift(); else exchange.pending[0] = chunk.subarray(n);
    }
    if (exchange.source && !exchange.done) { if (exchange.waiting > 0) exchange.source.pause(); else exchange.source.resume(); }
    if (exchange.ended && !exchange.pending.length) finish(exchange);
  };
  const start = async exchange => {
    const controller = new AbortController(); exchange.controller = controller;
    const body = exchange.chunks.length ? Buffer.concat(exchange.chunks) : null; exchange.chunks = [];
    const result = await answer({ method: exchange.method, params: exchange.params, headers: exchange.headers, body, length: exchange.length, signal: controller.signal });
    if (exchange.done || closed) { result.response?.destroy(); return; }   // aborted (or the channel closed) while the target was being asked
    if (result.error) return failed(exchange, result.error.code, result.error.message);
    if (result.local) {
      const text = Buffer.from(result.local.message);
      say({ t: 'head', id: exchange.id, status: result.local.status, statusText: http.STATUS_CODES[result.local.status] ?? '', headers: [['content-type', 'text/plain; charset=utf-8'], ['content-length', String(text.length)]] });
      exchange.pending.push(text); exchange.waiting += text.length; exchange.ended = true; return pump(exchange);
    }
    const response = result.response; exchange.status = response.statusCode;
    say({ t: 'head', id: exchange.id, status: response.statusCode, statusText: response.statusMessage || http.STATUS_CODES[response.statusCode] || '', headers: pageHeaders(response) });
    if (exchange.method === 'HEAD' || NULL_BODY.has(response.statusCode)) { response.resume(); return finish(exchange); }
    let source; try { source = await decodedBody(response); } catch (error) { response.destroy(); return failed(exchange, error?.code ?? 'EFETCH', error?.message ?? error); }
    if (exchange.done || closed) { response.destroy(); return; }
    exchange.source = source; exchange.response = response;
    source.on('data', chunk => { exchange.pending.push(chunk); exchange.waiting += chunk.length; pump(exchange); });
    source.on('end', () => { exchange.ended = true; pump(exchange); });
    const broken = error => { if (!exchange.done) { response.destroy(); failed(exchange, error?.code ?? 'ECONNRESET', error?.message ?? 'the target closed the connection'); } };
    source.on('error', broken); if (source !== response) response.on('error', broken);
    response.on('close', () => { if (!response.complete) broken(Object.assign(new Error('the target closed the connection before the end of the body'), { code: 'ECONNRESET' })); });
  };
  const onText = text => {
    let message; try { message = JSON.parse(text); } catch { return protocolError('a control message that is not JSON'); }
    const id = message?.id;
    if (message?.t === 'req') {
      if (!Number.isInteger(id) || id < 1 || id > 0xffffffff || exchanges.has(id)) return protocolError(`req: bad or duplicate id ${id}`);
      const length = Number(message.length) || 0, method = String(message.method ?? 'GET').toUpperCase();
      const exchange = { id, method, params: new URLSearchParams(String(message.query ?? '')), headers: Array.isArray(message.headers) ? message.headers.filter(pair => Array.isArray(pair) && pair.length === 2).map(([n, v]) => [String(n), String(v)]) : [],
        length, chunks: [], received: 0, credit: MUX_WINDOW, pending: [], waiting: 0, ended: false, done: false, source: null, response: null, controller: null, status: null, started: Date.now() };
      exchanges.set(id, exchange);
      if (length <= 0 || length > MAX_BODY) start(exchange);   // over the limit: the lab sends no body, the answer is the per-request path's 413
      return;
    }
    const exchange = exchanges.get(id); if (!exchange) return;   // an exchange that already ended (an abort or a credit crossing its end)
    if (message.t === 'credit') { exchange.credit += Math.max(0, Number(message.n) || 0); pump(exchange); }
    else if (message.t === 'abort') { forget(exchange); exchange.controller?.abort(); exchange.response?.destroy(); exchange.source?.destroy?.(); onExchange(exchange, 'aborted'); }
  };
  const onBinary = payload => {
    if (payload.length < 5 || payload[0] !== KIND_REQUEST_BODY) return protocolError('a binary message that is not a request body');
    const exchange = exchanges.get(payload.readUInt32BE(1)); if (!exchange || exchange.controller) return;   // aborted, or more bytes than announced (ignored once started)
    const bytes = payload.subarray(5); exchange.chunks.push(bytes); exchange.received += bytes.length;
    if (exchange.received >= exchange.length) start(exchange);
  };
  const decode = wsDecoder();
  socket.on('data', chunk => {
    for (const { opcode, payload } of decode(chunk)) {
      if (closed) return;
      if (opcode === 0x1) onText(payload.toString('utf8'));
      else if (opcode === 0x2) onBinary(payload);
      else if (opcode === 0x9) write(wsFrame(0xA, payload));
      else if (opcode === 0x8) { closed = true; if (!socket.destroyed) socket.end(wsFrame(0x8, Buffer.from([1000 >> 8, 1000 & 255]))); }
    }
  });
  socket.on('drain', () => { blocked = false; for (const exchange of [...exchanges.values()]) { pump(exchange); if (blocked) break; } });
  socket.on('error', () => {});
  socket.on('close', () => { closed = true; sessions?.delete(socket); for (const exchange of exchanges.values()) { exchange.done = true; exchange.controller?.abort(); exchange.response?.destroy(); } exchanges.clear(); });
  say({ t: 'hello', v: MUX_VERSION, window: MUX_WINDOW, maxBody: MAX_BODY, frame: MUX_FRAME });
}

// ---- TCP tunnel (/tcp): a TCP stream for a socket of the lab whose conversation is not HTTP/1.1 (HTTP/2 with prior knowledge, as gRPC clients speak; MQTT; a database
// protocol). The page opens a WebSocket here (ws://127.0.0.1:<port>/tcp?host=&port=&tls=0|1&alpn=), the relay connects to the target from this machine and copies the bytes
// both ways. First message (text JSON): {"connected":true,"alpn":...} or {"error":{"code","message"}}; then binary messages are the TCP bytes. tls=1: the relay does the TLS (the lab
// hands the app's plaintext, as its fetch path does) with the ALPN list asked for, and reports the protocol the server chose. Same origin rule as above.
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
/** 'host:port' as the identities are keyed (the host lowercased, IPv6 brackets dropped). */
const destination = (host, port) => `${String(host).toLowerCase().replace(/^\[|\]$/g, '')}:${port}`;
const pem = (label, bytes) => `-----BEGIN ${label}-----\n${bytes.toString('base64').replace(/.{1,64}/g, line => line + '\n')}-----END ${label}-----\n`;
/** The id of an identity, as the lab computes it (src/client-identity.js identityKey): the length and FNV-1a of the leaf certificate's DER. */
const identityId = leafDer => { let h = 0x811c9dc5; for (const b of leafDer) h = Math.imul(h ^ b, 0x01000193) >>> 0; return `${leafDer.length}:${h.toString(16)}`; };
/**
 * A client identity is presented only to a request that names it (client-identity-key: the id of the leaf certificate the app's KeyManager chose for this connection) and only
 * while the relay holds exactly that one for the destination. A request that names none gets none: an identity handed over earlier (another run of the app, a certificate the
 * app has since renewed, an expired one) never reaches a server by itself. Before 0.7.0 the relay presented whatever it last held for the destination, so a certificate that
 * had expired kept going out until the relay was restarted.
 */
function chosenIdentity(identities, where, wanted) {
  if (!wanted || !where) return null;
  const held = identities?.get(where); return held && held.id === wanted ? held : null;
}
/** A request that names an identity the relay does not hold for its destination (none: the relay was restarted or forgot it; another: the app chose a new certificate): the reason it must not go out, else null. The lab hands the identity (again) and repeats the request. */
function missingIdentity(identities, params, where) {
  const wanted = params.get('client-identity-key'); if (!wanted || !where) return null;
  const held = identities.get(where);
  if (!held) return `the relay holds no client certificate for ${where} (it was restarted, or forgot it): the lab hands it again`;
  return held.id === wanted ? null : `the relay holds another client certificate for ${where} than the one this connection chose: the lab hands the new one`;
}
/** {key: base64 PKCS#8, chain: [base64 DER]} -> { key, cert } in PEM, checked by node:crypto; null for an empty chain (forget). */
function parseIdentity(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.chain)) throw new Error('expected {"key", "chain": [...]}');
  if (body.chain.length === 0) return null;
  const keyDer = Buffer.from(String(body.key ?? ''), 'base64'), certs = body.chain.map(item => Buffer.from(String(item), 'base64'));
  const key = createPrivateKey({ key: keyDer, format: 'der', type: 'pkcs8' });   // throws for anything that is not a PKCS#8 private key
  const leaf = new X509Certificate(certs[0]); if (!leaf.checkPrivateKey(key)) throw new Error('the private key does not match the first certificate of the chain');
  return { key: pem('PRIVATE KEY', keyDer), cert: certs.map(der => pem('CERTIFICATE', der)).join(''), id: identityId(certs[0]) };
}
async function tunnel({ req, socket, route, allowed, timeoutMs, identities, ca = null, note = () => {} }) {
  const url = new URL(req.url, 'http://relay.invalid'), origin = req.headers.origin ?? '';
  const refuse = (status, text, message) => { socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Type: text/plain; charset=utf-8\r\nConnection: close\r\n\r\n${message}`); };
  if (route !== 'tcp') return refuse(404, 'Not Found', 'unknown path');
  if (!allowed.has(origin)) return refuse(403, 'Forbidden', `origin not allowed: ${origin || '(none)'}`);
  const key = req.headers['sec-websocket-key']; if (!key || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return refuse(400, 'Bad Request', 'a WebSocket upgrade is expected');
  const host = url.searchParams.get('host') ?? '', port = Number(url.searchParams.get('port')), secure = url.searchParams.get('tls') === '1', alpn = (url.searchParams.get('alpn') ?? '').split(',').map(p => p.trim()).filter(Boolean);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return refuse(400, 'Bad Request', 'host and port are required');
  const missing = missingIdentity(identities ?? new Map(), url.searchParams, secure ? destination(host, port) : null);
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${createHash('sha1').update(key + WS_GUID).digest('base64')}`, '', ''].join('\r\n'));
  socket.setNoDelay?.(true);
  const say = value => { if (!socket.destroyed) socket.write(wsFrame(0x1, Buffer.from(JSON.stringify(value)))); };
  const closeFrame = code => wsFrame(0x8, Buffer.from([code >> 8, code & 255]));
  const fail = (code, message) => { say({ error: { code, message: String(message).replace(/[\r\n]+/g, ' ').slice(0, 300) } }); socket.end(closeFrame(1011)); };
  socket.on('error', () => {});
  if (missing) return fail(NO_IDENTITY_CODE, missing);
  let connected = false; const started = Date.now();
  const roots = secure ? trusted(ca) : null;
  const identity = secure ? chosenIdentity(identities, destination(host, port), url.searchParams.get('client-identity-key')) : null;   // only the identity this tunnel named
  const upstream = secure ? tls.connect({ host, port, servername: isIP(host) ? undefined : host, ALPNProtocols: alpn.length ? alpn : undefined, ...(identity ? { key: identity.key, cert: identity.cert } : {}), ...(roots ? { ca: roots } : {}) }) : net.connect({ host, port });
  const timer = setTimeout(() => { if (!connected) { upstream.destroy(); fail('ETIMEDOUT', `connect to ${host}:${port} timed out after ${timeoutMs} ms`); } }, timeoutMs);
  upstream.once(secure ? 'secureConnect' : 'connect', () => { connected = true; clearTimeout(timer); upstream.setNoDelay?.(true); say({ connected: true, alpn: secure ? upstream.alpnProtocol || null : null }); note({ method: 'TCP', url: `${secure ? 'tls' : 'tcp'}://${host}:${port}`, status: 101, ms: Date.now() - started }); });
  upstream.on('data', chunk => { if (!socket.destroyed) socket.write(wsFrame(0x2, chunk)); });
  upstream.on('error', error => { clearTimeout(timer); if (!connected) { note({ method: 'TCP', url: `${secure ? 'tls' : 'tcp'}://${host}:${port}`, status: 502, error: error.code ?? 'ECONNREFUSED', ms: Date.now() - started }); fail(error.code ?? 'ECONNREFUSED', error.message); } else socket.destroy(); });
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

/** The roots for an upstream TLS connection: the system's plus the --ca certificates of this moment, or null (the system's, Node's default) without any. */
function trusted(ca) { const extra = typeof ca === 'function' ? ca() : ca; return extra?.length ? [...tls.rootCertificates, ...extra] : null; }

/**
 * --ca files as a function the relay asks at every upstream TLS connection: each file is read again when its modification time or size changed (a renewed internal CA takes effect
 * without restarting the relay); a file that cannot be read keeps its last good content and is reported once. `warn` gets one line per problem (an expired certificate included).
 */
function caFromFiles(files, { warn = message => console.warn(message), now = () => Date.now() } = {}) {
  const state = new Map();   // path -> { stamp, pem, reported }
  const load = file => {
    const known = state.get(file); let stamp;
    try { const stat = statSync(file); stamp = `${stat.mtimeMs}:${stat.size}`; }
    catch (error) { if (!known?.reported) warn(`--ca ${file}: ${error.message}${known?.pem ? ' (still using the copy read before)' : ''}`); if (known) known.reported = true; else state.set(file, { stamp: null, pem: null, reported: true }); return known?.pem ?? null; }
    if (known && known.stamp === stamp) return known.pem;
    let text; try { text = readFileSync(file, 'utf8'); } catch (error) { warn(`--ca ${file}: ${error.message}`); return known?.pem ?? null; }
    for (const block of text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []) {
      try { const cert = new X509Certificate(block); if (Date.parse(cert.validTo) <= now()) warn(`--ca ${file}: the certificate "${cert.subject.replace(/\n/g, ', ')}" expired on ${cert.validTo}; renew the file (it is read again when it changes)`); } catch { /* not a certificate Node can parse: the TLS handshake says so */ }
    }
    state.set(file, { stamp, pem: text, reported: false }); return text;
  };
  return () => files.map(load).filter(Boolean);
}

/** One upstream exchange over node:http(s), following redirects the way fetch does (at most 20; 303, and 301/302 after a POST, continue as GET without a body). */
function send(url, method, headers, body, timeoutMs, hops = 0, identities = null, ca = null, transport = {}) {
  // the identity of this hop: the one the request named, for its destination (chosenIdentity); a redirect to another destination of the same exchange presents the identity the app
  // chose for that destination in this session, if any (the lab names one key per request)
  const where = url.protocol === 'https:' ? destination(url.hostname, url.port || '443') : null;
  const identity = where === null ? null : hops === 0 || where === transport.identityFor ? chosenIdentity(identities, where, transport.identityKey) : identities?.get(where) ?? null;
  return new Promise((resolve, reject) => {
    const outgoing = {}; headers.forEach((value, name) => { outgoing[name] = name.toLowerCase() === 'cookie' ? value : (outgoing[name] ? `${outgoing[name]}, ${value}` : value); });
    if (body) outgoing['content-length'] = String(body.length);
    const roots = url.protocol === 'https:' ? trusted(ca) : null;   // asked now: a renewed --ca file applies to the next connection
    const agent = transport.agents?.[url.protocol];   // the relay's keep-alive agents; a connection with its own TLS material (a client identity, --ca roots) is not pooled
    const request = (url.protocol === 'https:' ? https : http).request(url, { method, headers: outgoing, timeout: timeoutMs, ...(agent ? { agent } : {}), ...(transport.signal ? { signal: transport.signal } : {}), ...(transport.lookup ? { lookup: transport.lookup } : {}), ...(identity ? { key: identity.key, cert: identity.cert, agent: false } : {}), ...(roots ? { ca: roots, agent: false } : {}) }, response => {
      const status = response.statusCode, location = response.headers.location;
      if (!transport.manualRedirects && [301, 302, 303, 307, 308].includes(status) && location) {
        response.resume();
        if (hops >= 20) return reject(Object.assign(new Error('Too many follow-up requests: 21'), { code: 'EREDIRECT' }));
        const next = new URL(location, url), asGet = status === 303 || ((status === 301 || status === 302) && method === 'POST');
        const nextHeaders = new Headers(headers); if (asGet) { nextHeaders.delete('content-type'); nextHeaders.delete('content-length'); }
        if (next.host !== url.host) { nextHeaders.delete('authorization'); nextHeaders.delete('cookie'); }   // credentials never follow a redirect to another host, as with fetch
        return resolve(send(next, asGet ? 'GET' : method, nextHeaders, asGet ? undefined : body, timeoutMs, hops + 1, identities, ca, hops === 0 ? { ...transport, identityFor: where } : transport));
      }
      resolve(response);
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error(`connect to ${url.host} timed out after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
    request.end(body);
  });
}


const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** The address for the lab's Proxy field of a relay on `port`; on the default port the field stays empty (the lab finds the relay by itself). */
const proxyAddress = port => `http://127.0.0.1:${port}/?url={url}`;
function statusPage({ port }) {
  const automatic = port === DEFAULT_PORT;
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
<section><h2>${automatic ? 'Nothing to copy' : 'Address for the Proxy field'}</h2><p>${automatic ? 'The lab finds this relay by itself: leave Controls › Network › Proxy and relay empty. It is looked for when the page loads and before an app opens. The address below is for a page that embeds the lab.' : `The lab looks for a relay on port ${DEFAULT_PORT} only. On this port, paste the address below in Controls › Network › Proxy and relay.`}</p>
<div class="url"><input id="proxy" readonly value="${escapeHtml(proxyAddress(port))}" aria-label="Proxy address"><button id="copy" type="button">Copy</button></div>
<p style="margin:10px 0 0">The relay reaches any destination: the internet, this computer and the local network.</p></section>
<section><h2>Recent requests</h2><p id="channels" style="margin:0 0 10px">Parallel channel: none open (the lab's Network › Parallel relay channel switch opens one).</p><table><thead><tr><th>Time</th><th>Method</th><th>Status</th><th>ms</th><th>Via</th><th>Destination</th></tr></thead><tbody id="log"><tr><td colspan="6" class="empty">None yet.</td></tr></tbody></table></section>
</main><script>
document.getElementById('copy').addEventListener('click', async () => { const input = document.getElementById('proxy'); try { await navigator.clipboard.writeText(input.value); } catch { input.select(); document.execCommand('copy'); } document.getElementById('copy').textContent = 'Copied'; setTimeout(() => { document.getElementById('copy').textContent = 'Copy'; }, 1500); });
const cell = (text, cls) => { const td = document.createElement('td'); td.textContent = text; if (cls) td.className = cls; return td; };
async function refresh() {
  try {
    const data = await (await fetch('/status.json', { cache: 'no-store' })).json(), body = document.getElementById('log');
    document.getElementById('channels').textContent = data.channels ? 'Parallel channel: ' + data.channels + ' open (one WebSocket per lab page carries all its requests at once).' : 'Parallel channel: none open (the lab\'s Network › Parallel relay channel switch opens one).';
    if (!data.recent.length) return;
    body.replaceChildren(...data.recent.slice().reverse().map(item => { const tr = document.createElement('tr'); tr.append(cell(new Date(item.at).toLocaleTimeString()), cell(item.method), cell(item.error || String(item.status), item.error || item.status >= 400 ? 'bad' : 'ok'), cell(String(item.ms)), cell(item.via === 'channel' ? 'channel' : item.method === 'TCP' ? 'tunnel' : 'request'), cell(item.url, 'url-cell')); return tr; }));
  } catch {}
}
refresh(); setInterval(refresh, 2000);
</script></body></html>`;
}

// ---- the desktop app: settings kept between runs, the command line, the browser opened on the status page ----------------------------------------------------------------
function configDir(env = process.env, platform = process.platform, home = os.homedir()) {
  const chosen = env.APK_LAB_RELAY_CONFIG_DIR || env.APKWEB_RELAY_CONFIG_DIR; if (chosen) return chosen;   // another folder (tests, a second relay); APKWEB_RELAY_CONFIG_DIR: the name the lab's own relay used
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
  --ca <file.pem>      also trust the certificates of this file (repeat for several; a server with an internal CA)
  --no-open            do not open the status page in the browser
  --config-dir <dir>   keep the settings in this folder instead of the system's (also APK_LAB_RELAY_CONFIG_DIR)
  --version, --help`;
function parseArguments(argv) {
  const options = { port: null, origins: [], ca: [], ignored: [], open: true, configDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i], value = () => { if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`); return argv[++i]; };
    if (arg === '--port') options.port = Number(value());
    else if (arg === '--origin') options.origins.push(value().replace(/\/$/, ''));
    else if (arg === '--ca') options.ca.push(path.resolve(value()));
    else if (arg === '--token') { value(); options.ignored.push(arg); }   // older versions: the relay has no token any more
    else if (arg === '--new-token') options.ignored.push(arg);
    else if (arg === '--allow-private' || arg === '--no-allow-private') continue;   // older versions blocked private destinations; every destination is reachable now, so the option does nothing
    else if (arg === '--no-open') options.open = false;
    else if (arg === '--config-dir') options.configDir = path.resolve(value());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg.startsWith('-psn_')) continue;   // macOS adds a process serial number when the app is opened from Finder
    else throw new Error(`unknown option: ${arg}`);
  }
  if (options.port !== null && (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)) throw new Error('--port must be 1 to 65535');
  for (const file of options.ca) { try { readFileSync(file); } catch (error) { throw new Error(`--ca ${file}: ${error.message}`); } }
  for (const origin of options.origins) { let parsed; try { parsed = new URL(origin); } catch { throw new Error(`invalid --origin: ${origin}`); } if (parsed.origin !== origin) throw new Error(`--origin must be only scheme, host and port (e.g. ${parsed.origin})`); }
  return options;
}
/** The settings of this run: saved ones, overridden by the command line (which is saved for the next runs). A token saved by an older version is not read and not kept. */
function resolveSettings(saved, options) {
  return { port: options.port ?? (Number.isInteger(saved.port) && saved.port >= 1 && saved.port <= 65535 ? saved.port : DEFAULT_PORT), origins: options.origins.length ? options.origins : Array.isArray(saved.origins) && saved.origins.length ? saved.origins.map(String) : DEFAULT_ORIGINS };
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
  const dir = options.configDir ?? configDir(), settings = resolveSettings(loadSettings(dir), options);
  const saved = saveSettings(dir, settings);
  const server = createRelay({ origins: settings.origins, port: settings.port, ca: options.ca.length ? caFromFiles(options.ca) : null });
  const page = `http://127.0.0.1:${settings.port}/`;
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
    if (settings.port === DEFAULT_PORT) console.log('\nNothing to copy: the lab finds this relay by itself (leave Controls > Network > Proxy and relay empty).\n');
    else console.log(`\nThe lab looks for a relay on port ${DEFAULT_PORT} only. On this port, paste into Controls > Network > Proxy and relay:\n  ${proxyAddress(settings.port)}\n`);
    if (options.ignored.length) console.log(`${[...new Set(options.ignored)].join(', ')}: ignored, the relay needs no token any more`);
    console.log(`Status page: ${page}${saved ? '' : '\n(the settings could not be saved: give the options again next time)'}`);
    console.log('Keep this window open while you use the lab. Ctrl+C stops it.');
    if (options.open) openBrowser(page);
  });
  const stop = () => { server.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

module.exports = { VERSION, MUX_VERSION, RELAY_NAME, DEFAULT_PORT, DEFAULT_ORIGINS, NO_IDENTITY_CODE, FEATURES, createRelay, relayRoute, proxyAddress, caFromFiles, identityId, configDir, loadSettings, saveSettings, parseArguments, resolveSettings, main };
const isSea = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();   // the single executable built by scripts/build-sea.mjs
if (isSea || require.main === module) main();
