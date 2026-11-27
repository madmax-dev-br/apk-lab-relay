'use strict';
// Client certificates (mTLS) against a real TLS server that asks for one: the relay presents an identity only to a request that names it, and only the one it names. Every
// server is local (127.0.0.1); the certificates are made with openssl in a temporary folder (the test is skipped without openssl).
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createPrivateKey, X509Certificate } = require('node:crypto');
const { createRelay, identityId } = require('../src/relay.cjs');

const ORIGIN = 'https://lab.example.test';
const haveOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** A CA, a server certificate for 127.0.0.1 and client certificates named `clients`, all signed by the CA. */
function certificates(clients) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-mtls-'));
  // MSYS_NO_PATHCONV / MSYS2_ARG_CONV_EXCL: the openssl of Git for Windows would read -subj /CN=... as a path
  const ssl = args => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' } });
  const issue = (name, extension) => {
    ssl(['req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`]);
    fs.writeFileSync(path.join(dir, `${name}.ext`), extension);   // a file, not /dev/stdin: Windows has none, and some openssl builds do not read a pipe there
    ssl(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.ext`]);
    return { key: fs.readFileSync(path.join(dir, `${name}.key`), 'utf8'), cert: fs.readFileSync(path.join(dir, `${name}.pem`), 'utf8') };
  };
  ssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=relay test CA']);
  const out = { ca: fs.readFileSync(path.join(dir, 'ca.pem'), 'utf8'), server: issue('server', 'subjectAltName=IP:127.0.0.1\n') };
  for (const name of clients) out[name] = issue(name, 'extendedKeyUsage=clientAuth\n');
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
/** The body the lab POSTs for an identity, and its id (the lab's identityKey of the leaf certificate). */
function identity({ key, cert }) {
  const leaf = new X509Certificate(cert).raw;
  return { body: JSON.stringify({ key: createPrivateKey(key).export({ type: 'pkcs8', format: 'der' }).toString('base64'), chain: [leaf.toString('base64')] }), id: identityId(leaf) };
}

test('a client identity goes only to a request that names it: none by itself, an older one never in place of the one the app chose', { skip: haveOpenssl ? false : 'openssl is not installed' }, async () => {
  const certs = certificates(['old-device', 'new-device']);
  // the server asks every client for a certificate and says which one it got (none: the handshake still completes, as a server with optional client authentication does)
  const server = https.createServer({ key: certs.server.key, cert: certs.server.cert, ca: certs.ca, requestCert: true, rejectUnauthorized: false }, (req, res) => {
    const peer = req.socket.getPeerCertificate(); res.end(peer?.subject?.CN ?? 'none');
  });
  const relay = createRelay({ origins: [ORIGIN], ca: [certs.ca] });
  try {
    const serverPort = await listen(server), base = `http://127.0.0.1:${await listen(relay)}`, target = `https://127.0.0.1:${serverPort}/who`;
    const hand = id => fetch(`${base}/?url=${encodeURIComponent(`https://127.0.0.1:${serverPort}/`)}&client-identity=1`, { method: 'POST', body: id.body, headers: { origin: ORIGIN } });
    const ask = async key => { const response = await fetch(`${base}/?url=${encodeURIComponent(target)}${key ? `&client-identity-key=${encodeURIComponent(key)}` : ''}`, { headers: { origin: ORIGIN } }); return [response.status, response.headers.get('x-apkweb-relay-error-code') ?? await response.text()]; };
    const older = identity(certs['old-device']), newer = identity(certs['new-device']);

    assert.equal((await hand(older)).status, 204);
    assert.deepEqual(await ask(older.id), [200, 'old-device'], 'the identity the request names is presented');
    assert.deepEqual(await ask(null), [200, 'none'], 'a request that names none gets none, although the relay holds one for this server');
    assert.deepEqual(await ask(newer.id), [502, 'APKWEB_RELAY_NO_CLIENT_IDENTITY'], 'the app chose another certificate: the older one is not sent in its place');
    assert.equal((await hand(newer)).status, 204);
    assert.deepEqual(await ask(newer.id), [200, 'new-device'], 'handed over, the new certificate is presented');
    assert.deepEqual(await ask(older.id), [502, 'APKWEB_RELAY_NO_CLIENT_IDENTITY'], 'the replaced certificate is gone');
  } finally { relay.close(); server.close(); }
});

test('connections that present a client identity are kept alive and reused only by requests that name that identity', { skip: haveOpenssl ? false : 'openssl is not installed' }, async () => {
  const certs = certificates(['device', 'other']);
  let connections = 0;
  const server = https.createServer({ key: certs.server.key, cert: certs.server.cert, ca: certs.ca, requestCert: true, rejectUnauthorized: false, keepAliveTimeout: 30000 }, (req, res) => {
    const peer = req.socket.getPeerCertificate(); res.end(peer?.subject?.CN ?? 'none');
  });
  server.on('secureConnection', () => connections++);
  const relay = createRelay({ origins: [ORIGIN], ca: [certs.ca] });
  try {
    const serverPort = await listen(server), base = `http://127.0.0.1:${await listen(relay)}`, target = `https://127.0.0.1:${serverPort}/who`;
    const hand = id => fetch(`${base}/?url=${encodeURIComponent(`https://127.0.0.1:${serverPort}/`)}&client-identity=1`, { method: 'POST', body: id.body, headers: { origin: ORIGIN } });
    const ask = async key => { const response = await fetch(`${base}/?url=${encodeURIComponent(target)}${key ? `&client-identity-key=${encodeURIComponent(key)}` : ''}`, { headers: { origin: ORIGIN } }); return `${response.status} ${await response.text()}`; };
    const device = identity(certs.device), other = identity(certs.other);
    assert.equal((await hand(device)).status, 204);
    for (let i = 0; i < 10; i++) assert.equal(await ask(device.id), '200 device');
    assert.equal(connections, 1, 'ten requests naming the identity share one TLS connection (a new one each time costs a handshake with the server)');
    assert.equal(await ask(null), '200 none', 'a request that names no identity does not ride the connection that presented one');
    assert.equal(connections, 2);
    assert.equal((await hand(other)).status, 204);
    assert.equal(await ask(other.id), '200 other', 'another identity gets a connection of its own');
    assert.equal(connections, 3);
    assert.equal((await ask(device.id)).slice(0, 3), '502', 'the replaced identity is not presented, although a connection made with it may still be open');
  } finally { relay.close(); server.close(); }
});
