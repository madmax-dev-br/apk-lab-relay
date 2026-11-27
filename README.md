<img src="assets/icon-512.png" alt="APK Lab Relay icon" width="96" height="96">

# APK Lab Relay

A small program for Windows, Linux and macOS that lets the [APK Browser Lab](https://madmax-dev-br.github.io/apk-browser-lab-site/) reach any server without CORS errors.

The browser blocks responses from servers that do not authorize the lab's page, and the servers a real Android app talks to do not. With the relay open, the lab sends the app's requests to this program. It repeats them from your computer, the way the device would send them, and hands the response back to the lab.

## Download

The executables are in [Releases](../../releases/latest):

| System | File |
| --- | --- |
| Windows (x64) | `apk-lab-relay-windows-x64.exe` |
| macOS (Apple Silicon) | `apk-lab-relay-macos-arm64.tar.gz` |
| macOS (Intel) | `apk-lab-relay-macos-x64.tar.gz` |
| Linux (x64) | `apk-lab-relay-linux-x64.tar.gz` |
| Linux (ARM64) | `apk-lab-relay-linux-arm64.tar.gz` |
| Any system with Node.js 22+ | `apk-lab-relay.cjs` (the same relay as one script: `node apk-lab-relay.cjs`) |

`SHA256SUMS.txt` has the hash of each file.

```bash
curl -LO https://github.com/madmax-dev-br/apk-lab-relay/releases/latest/download/apk-lab-relay.cjs
node apk-lab-relay.cjs
```

This project is the only relay of the lab: the lab's repository keeps no copy of it, and its tests run against a checkout of this one placed beside it.

## Use

1. Open the program. On Windows, double-click the `.exe`. On macOS and Linux, extract the `.tar.gz` and run `./apk-lab-relay`.
2. It opens a status page in the browser (`http://127.0.0.1:8787/`) that lists what goes through it.
3. Open the lab (or reload it). It finds the relay by itself: leave **Controls › Network › Proxy and relay** empty, and it says "Relay found at 127.0.0.1:8787 (automatic)". Chrome may ask once to let the page reach this computer.
4. Keep the program open while you use the lab. Closing the window (or Ctrl+C) stops it.

Since 0.6.0 there is no token and nothing to copy. An address saved from an older version (`http://127.0.0.1:8787/<token>/?url={url}`) keeps working. On another port (`--port`), paste the address the program prints.

### System warnings the first time

The executables are not signed.

- **Windows:** SmartScreen may warn that Windows protected your PC. Click **More info › Run anyway**.
- **macOS:** if the system refuses to open it, run `xattr -d com.apple.quarantine ./apk-lab-relay` in the extracted folder, or open it from Finder with right click › **Open**.

## Options

```
apk-lab-relay [options]
  --port <n>           port on 127.0.0.1 (default 8787; saved)
  --origin <url>       a page that may use the relay (repeat for several; saved)
  --ca <file.pem>      also trust the certificates of this file (a server with an internal CA)
  --no-open            do not open the status page in the browser
  --config-dir <dir>   keep the settings in this folder (also APK_LAB_RELAY_CONFIG_DIR)
  --version, --help
```

By default the published lab (`https://madmax-dev-br.github.io`) and a local copy (`http://127.0.0.1:8765`, `http://localhost:8765`) may use the relay. To use it with the lab served from another address, pass `--origin http://localhost:5173`.

The relay reaches any destination: the internet, this computer and the local network. There is no option for that. `--allow-private`, `--token` and `--new-token`, from older versions, are still accepted and do nothing.

Settings live in `%APPDATA%\apk-lab-relay` (Windows), `~/Library/Application Support/apk-lab-relay` (macOS) or `~/.config/apk-lab-relay` (Linux).

## Security

- The relay listens only on `127.0.0.1`: another computer on the network cannot reach it.
- Every request, WebSockets included, must come from one of the allowed pages (its `Origin`, which a page cannot change), so another site open in the same browser cannot use the relay. There is no token: a program on this computer can use the relay, as it could reach the network by itself.
- A client certificate the lab hands over (mutual TLS) is kept in memory only, for the destination it was chosen for, and presented only to a request that names it (since 0.7.0): a request that names no certificate gets none, and one that names a certificate the relay does not hold (the app chose a new one, or the relay restarted) is refused with `APKWEB_RELAY_NO_CLIENT_IDENTITY` so the lab hands the new one. Before 0.7.0 the last certificate the relay held for a server went to every request to it, so a replaced or expired certificate kept going out until the relay was restarted.
- Destinations are not restricted: whatever the lab asks for, the relay fetches from your computer, including servers on this computer and on your local network.
- The status page answers only to `127.0.0.1` and `localhost`, which protects against *DNS rebinding*.
- WebView documents (since 0.5.0) are served on `http://<label>.localhost:<port>` addresses whose 20-hex-digit label is the capability: it exists only while the lab page that opened it is connected.
- Nothing is stored besides the settings. Requests and responses pass through and are forgotten, and the status page's history (the last 50, without query strings) lives only in memory.

## How it works

It is the same protocol as the lab's `cors-relay.mjs` (version 0.5.0), which this program runs unchanged:

- `GET /hello` tells an allowed page that this is the relay, its version and what it has.
- The destination goes in the `url` parameter.
- Headers the browser will not send (Cookie, User-Agent, Origin, Referer...) arrive as `x-apkweb-<name>` and leave under their original name.
- Redirects are followed here. Credentials do not follow to another host.
- `Set-Cookie` headers come back in the `x-apkweb-set-cookie` header, as a JSON array.
- When the destination does not answer, the relay returns 502 with `x-apkweb-relay-error-code` (`ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `CERT_...`). The lab turns that code into the exception Android would throw.

## TCP tunnel (gRPC, HTTP/2, other protocols)

Since 0.2.0 the relay also opens TCP connections for the lab. When an app speaks something other than HTTP/1.1 on a socket (Cloud Firestore's gRPC uses HTTP/2; MQTT; database protocols), the lab sends that connection through the relay: the page opens a WebSocket at `ws://127.0.0.1:8787/tcp?host=…&port=…`, and the relay connects to the destination from your computer and passes the bytes both ways. The same rules apply as for the rest: only the allowed pages. Any destination is reachable, including emulators running on your computer (for example the Firebase emulators).

## Parallel channel (since 0.4.0)

Without it, every request the app makes is a separate browser request to the relay. The browser opens at most about 6 connections to one address, so an app that fires 20 or 50 requests at once gets them answered 6 at a time, and most requests also cost a CORS preflight first. With the lab's **Controls › Network › Parallel relay channel** switch on (on by default), the lab opens one WebSocket to `ws://127.0.0.1:8787/mux` and sends every request over it at once; the relay runs them concurrently from your computer, keeping connections to each server alive. Measured in Chrome with a server that answers after 100 ms: 20 requests at once took 410 ms as separate requests and 104 ms over the channel; 50 took 925 ms and 106 ms. Through the whole lab, an app firing 20 requests at once on a thread pool got its answers in 421 ms without the channel and 118 ms with it; 50 requests, 937 ms and 123 ms.

Nothing else changes: each request through the channel is decided by the same code as a separate request (the headers, redirects, `Set-Cookie`, the error codes, the timeouts), and the lab gets the same status, headers and bytes. A relay older than 0.4.0 refuses the channel, and the lab then sends separate requests as before. The same rules apply: only the allowed pages.

The protocol, version 1. Text messages are JSON; binary messages carry body bytes as `[kind: 1 byte][exchange id: 4 bytes, big-endian][bytes]` (kind 1: request body, from the lab; kind 2: response body, from the relay).

| Direction | Message | Meaning |
| --- | --- | --- |
| relay → lab | `{"t":"hello","v":1,"window":262144,"maxBody":33554432,"frame":65536}` | first message: the relay has the channel |
| lab → relay | `{"t":"req","id":1,"method":"GET","query":"?url=…","headers":[["name","value"]],"length":0}` | a request: the same query and headers as a separate request (`x-apkweb-<name>` for the headers a browser may not send); then `length` body bytes in kind-1 frames |
| relay → lab | `{"t":"head","id":1,"status":200,"statusText":"OK","headers":[…]}` | the response head, with the headers a separate request would show (`x-apkweb-set-cookie` included) |
| relay → lab | kind-2 frames, then `{"t":"end","id":1}` | the body. A `Content-Encoding` the browser would decode (gzip, deflate, br, zstd) is decoded first, so the lab gets the bytes it would have got; nothing is compressed or cached |
| relay → lab | `{"t":"error","id":1,"code":"ECONNREFUSED","message":"…"}` | the destination could not be reached (before the head: the same codes as the 502 `x-apkweb-relay-error-code`), or the body broke |
| lab → relay | `{"t":"credit","id":1,"n":65536}` | flow control: the relay sends at most `window` body bytes ahead of what the lab has read, and pauses that destination until more credit comes |
| lab → relay | `{"t":"abort","id":1}` | the app closed the request: the relay cancels it at the destination |

The status page shows how many channels are open and marks the requests that came over one.

## WebView documents (since 0.5.0)

An Android app's `WebView` shows any page; a browser page can only frame a page that allows it, and can never read or script a page of another origin. With the relay as the Proxy, the lab shows a WebView's web pages from the relay instead: the frame's address is `http://<label>.localhost:<port>/<path>`, where `<label>` (20 random hex digits) stands for one origin of one WebView of one lab page. The relay fetches the real page from this computer and serves it to the frame:

- the page's framing headers (`X-Frame-Options`, CSP `frame-ancestors`) and its own CSP are not passed on; the lab's CSP replaces them, so the page reaches the network only through the relay;
- every request of the page (images, scripts, XHR, navigations, redirects) comes to the relay first, and the relay asks the lab over its channel before anything leaves this computer. The lab answers from the virtual device: its allowed hosts and redirect rules, the app's own cookies (sent as `Cookie`; `Set-Cookie` goes back to the app's cookie store and never to the browser), the app's user agent, or the app's own answer;
- redirects are answered to the frame with the slot address of their target, so the lab decides each hop and stores its cookies first; absolute addresses of other origins in HTML and CSS are rewritten to their slots;
- the page's synchronous calls into the app (a JavaScript interface method and its return value, `document.cookie`, a navigation the app may take over) are POSTs to `/__apkweb/*` on its own slot, answered when the app answered.

The channel is a WebSocket from the lab to `ws://127.0.0.1:<port>/webview` (same allowed-page rule as everything else). Its protocol (version 1) is described at the top of `src/webview.cjs`, which is the same file as the lab's `scripts/relay-webview.cjs`. A relay older than 0.5.0 refuses the channel, and the lab then frames pages directly, as before.

Security of this part: a slot address is a capability (80 random bits) of one lab page's channel and disappears with it; requests to a slot carry none of the browser's cookies and receive none; nothing is stored. Only the lab page that opened a document answers its requests, and the lab keeps each app's cookies separately.

## Develop

Needs Node.js 22 or newer.

```bash
npm ci
npm test
npm start          # runs the relay straight from the source
npm run build      # builds this system's executable into release/ (official Node, with single executable support)
npm run smoke      # tests the built executable
```

## Publish a version

CI (`.github/workflows/build.yml`) runs the tests and builds the executables for the five systems on every push. To publish a version:

1. Change the version in `package.json` and `VERSION` in `src/relay.cjs`.
2. Commit and create the tag: `git tag v0.3.1 && git push origin main v0.3.1`.

CI creates the release with the executables and the checksums.

## License

APK Lab Relay is free software under the [MIT License](LICENSE): use it, copy it, change it, share it or sell it, for any purpose, keeping the copyright notice.
