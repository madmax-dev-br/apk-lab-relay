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

`SHA256SUMS.txt` has the hash of each file.

## Use

1. Open the program. On Windows, double-click the `.exe`. On macOS and Linux, extract the `.tar.gz` and run `./apk-lab-relay`.
2. It opens a status page in the browser (`http://127.0.0.1:8787/`) with the proxy address. Copy the address.
3. In the lab, go to **Controls › Device › Proxy** and paste the address.
4. Keep the program open while you use the lab. Closing the window (or Ctrl+C) stops it.

The address has a random token. It is saved, so the address stays the same next time and you do not have to paste it again.

### System warnings the first time

The executables are not signed.

- **Windows:** SmartScreen may warn that Windows protected your PC. Click **More info › Run anyway**.
- **macOS:** if the system refuses to open it, run `xattr -d com.apple.quarantine ./apk-lab-relay` in the extracted folder, or open it from Finder with right click › **Open**.

## Options

```
apk-lab-relay [options]
  --port <n>           port on 127.0.0.1 (default 8787; saved)
  --origin <url>       a page that may use the relay (repeat for several; saved)
  --token <text>       use this token in the address (saved)
  --new-token          make a new token (the Proxy address changes)
  --no-open            do not open the status page in the browser
  --version, --help
```

By default the published lab (`https://madmax-dev-br.github.io`) and a local copy (`http://127.0.0.1:8765`, `http://localhost:8765`) may use the relay. To use it with the lab served from another address, pass `--origin http://localhost:5173`.

The relay reaches any destination: the internet, this computer and the local network. There is no option for that. `--allow-private`, from older versions, is still accepted and does nothing.

Settings live in `%APPDATA%\apk-lab-relay` (Windows), `~/Library/Application Support/apk-lab-relay` (macOS) or `~/.config/apk-lab-relay` (Linux).

## Security

- The relay listens only on `127.0.0.1`: another computer on the network cannot reach it.
- Every request must carry the token in its path and come from one of the allowed pages, so another site open in the same browser cannot use the relay.
- Destinations are not restricted: whatever the lab asks for, the relay fetches from your computer, including servers on this computer and on your local network.
- The status page answers only to `127.0.0.1` and `localhost`, which protects against *DNS rebinding*.
- Nothing is stored besides the settings. Requests and responses pass through and are forgotten, and the status page's history (the last 50, without query strings) lives only in memory.

## How it works

It is the same protocol as the lab's `cors-relay.mjs`:

- The destination goes in the `url` parameter.
- Headers the browser will not send (Cookie, User-Agent, Origin, Referer...) arrive as `x-apkweb-<name>` and leave under their original name.
- Redirects are followed here. Credentials do not follow to another host.
- `Set-Cookie` headers come back in the `x-apkweb-set-cookie` header, as a JSON array.
- When the destination does not answer, the relay returns 502 with `x-apkweb-relay-error-code` (`ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `CERT_...`). The lab turns that code into the exception Android would throw.

## TCP tunnel (gRPC, HTTP/2, other protocols)

Since 0.2.0 the relay also opens TCP connections for the lab. When an app speaks something other than HTTP/1.1 on a socket (Cloud Firestore's gRPC uses HTTP/2; MQTT; database protocols), the lab sends that connection through the relay: the page opens a WebSocket at `ws://127.0.0.1:8787/<token>/tcp?host=…&port=…`, and the relay connects to the destination from your computer and passes the bytes both ways. The same rules apply as for the rest: only the allowed pages, only with the token. Any destination is reachable, including emulators running on your computer (for example the Firebase emulators).

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
2. Commit and create the tag: `git tag v0.3.0 && git push origin main v0.3.0`.

CI creates the release with the executables and the checksums.

## License

APK Lab Relay is free software under the [MIT License](LICENSE): use it, copy it, change it, share it or sell it, for any purpose, keeping the copyright notice.
