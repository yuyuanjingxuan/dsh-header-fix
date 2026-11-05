# Root cause: `desktop welcome: Web authentication failed`

Notes from tracking this down, kept for whoever maintains the patch later.

---

## 1. What it looks like

The window never appears, or closes immediately. New `crash-*-host.log` files keep showing up
in `%APPDATA%\@deepseek-ai\dsh-desktop\logs\`:

```
source: host
phase: startup
Error: desktop welcome: Web authentication failed
    at connectDesktopWelcome (.../app.asar/lib/main.js:8886)
```

What it is not:

- Not the network. `platform.deepseek.com` and the third-party LLM endpoints all respond.
- Not a proxy. No `HTTP(S)_PROXY`, `ProxyEnable=0`.
- Not the account. The credentials file is intact and the token has not expired.
- Not the installer. Reinstalling changes nothing.
- It correlates with launch count. Clearing cookies fixes it, and it comes back later.

---

## 2. How startup works

```
DeepSeek Harness.exe (Electron shell)
  spawns itself with ELECTRON_RUN_AS_NODE=1
    runs app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js
      starts a local HTTP host on 127.0.0.1:<random port>   (--port 0)
      reports { type: "ready", url, injections } over IPC
  authenticateWebHost(ready.url)      Node global fetch, no cookie jar
  connectDesktopWelcome(ready.url)    Electron net.fetch, credentials: "include"
```

Authentication lives in `@deepseek-ai/dsh-client-connection`, class `BrowserAuth`:

- A one-shot launch token is generated and passed to the host as `?token=`
- `authorizeIndex()` validates it and replies `303` with `Set-Cookie`
- Cookie name is `dsh-auth-` plus `base64url(sha256(authority))`
- Over HTTP the authority is `host:port`, and the port changes every launch
- Attributes: `Max-Age` (30 days), `Path=/`, `Expires`, `HttpOnly`, `SameSite=Strict`

---

## 3. Narrowing it down

### 3.1 Ruling things out

| Hypothesis | Check | Result |
|---|---|---|
| Network down | `HEAD` to `platform.deepseek.com` | 405, network fine |
| Proxy interference | `ProxyEnable`, proxy env vars | none set |
| Expired cookies | `expires_utc` in `Network\Cookies` | all valid, latest 30 days out |
| Broken credentials | read `.credentials.yaml` | intact, token valid |
| Corrupt install | compare `resources\runtime`, `app.asar.unpacked` | complete, timestamps consistent |
| Version regression | diff `dsh-client-connection` between `0.2.1-rc.5` and `0.2.2-rc.1` | byte-identical |

### 3.2 The clue

`Network\Cookies` held **71 cookies, all `dsh-auth-*` on `127.0.0.1`, nothing else**.

Decoded, they had **71 distinct authorities** (`127.0.0.1:<random port>`), each with a
173-byte value and a 52-byte name. Every `last_access_utc` matched the last launch, so
Electron really was sending them.

### 3.3 Why one request succeeds and the next fails

This is the part that sends you the wrong way. Both requests hit the same URL:

| | `authenticateWebHost` | `connectDesktopWelcome` |
|---|---|---|
| Client | Node global `fetch` (undici) | Electron `net.fetch` |
| Cookies | no jar, tiny header | Chromium jar, `credentials: "include"` |
| Outcome | 303, success | **431, failure** |

Chromium puts every cookie matching `127.0.0.1` into the `Cookie` header. Cookies are not
scoped by port, so all 71 go out.

### 3.4 Measuring the threshold

`http.maxHeaderSize` is 16384 in the bundled Node. Replaying the real header set
(137-byte UA plus 312 bytes of accept / accept-encoding / accept-language / sec-fetch-*):

| Cookies | Cookie header | Total headers | Result |
|---|---|---|---|
| 70 | 15,958 | 16,327 | **200 OK** |
| 71 | 16,186 | 16,555 | **431** |

Budget for cookies is `16384 - 312 = 16,072` bytes.

Growth over time:

| # | When | Cumulative Cookie header |
|---|---|---|
| 68 | 11-02 03:08 | 15,504 |
| 69 | 11-02 20:24 | 15,732 |
| 70 | 11-03 03:01 | 15,960 ok |
| 71 | 11-04 11:47 | 16,188 over |

The 71st launch fails, every time.

---

## 4. Root cause

`BrowserAuth` issues a `dsh-auth-*` cookie for a new `127.0.0.1:<random port>` on every
launch and never removes the old ones. After about 70 launches the `Cookie` header exceeds
Node's default `http.maxHeaderSize` of 16384 bytes, the host returns `431`,
`connectDesktopWelcome` sees `!authenticated.ok`, and the app reports
`desktop welcome: Web authentication failed`.

`dsh-host-webserver` calls `createServer` without options:

```js
if (tls === void 0) this.server = createServer(listener);
```

The config schema has no `maxHeaderSize` either; it only exposes `host`, `port`, `tls`,
`compression`, `compressionLevel` and `compressionThresholdBytes`.

---

## 5. Why a plugin cannot fix it

Looked at the plugin market first. It does not work:

1. **The market is empty by default.** `plugin-market` has `indexes: []`, there is no
   official index (`harness.deepseek.com` returns 404 on every path tried), and
   `tool-plugin-market` is `disabled: true` in all three presets.
2. **Cookies live in the shell.** They are in the Electron main process's Chromium jar.
   Plugins run in the host child process and cannot reach it.
3. **`maxHeaderSize` is fixed at `createServer` time** and is not exposed in config.
4. **431 is returned before application code runs.** The HTTP server rejects the request
   while parsing headers.
5. **There is no request hook.** `dsh-host-webserver` has zero occurrences of `use(`,
   `hook` or `onRequest`.

---

## 6. Approaches tried

| Approach | Result | Why |
|---|---|---|
| `NODE_OPTIONS=--max-http-header-size=65536` | works | Real host went 431 to 401. Needs a launcher to inject it, which is fragile when users start from a shortcut |
| `NODE_OPTIONS=--require <shim>` | fails | Electron's Node mode ignores `--require` in `NODE_OPTIONS`; only some flags are honoured |
| Runtime patch of `http.createServer` | fails | ESM named imports bind the original function at instantiation, so reassigning `http.createServer` has no effect on modules loaded before or after |
| Patch `net.Server.prototype.listen` | works | 20 KB header returned 200. Still needs an injection point |
| **Patch `createServer({maxHeaderSize:65536}, listener)` inside the asar** | **works** | Deployed and verified, 20 KB header returns 401 |
| Delete `dsh-auth-*` cookies | works | Immediate recovery, returns after about 70 launches |

The asar patch won because it does not depend on how the app is started. Users double-click
the icon and it just works.

---

## 7. Implementation notes

### 7.1 The change

`/dsh/node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js` inside `app.asar`:

```diff
- if (tls === void 0) this.server = createServer(listener);
+ if (tls === void 0) this.server = createServer({maxHeaderSize:65536},listener);
```

21,436 to 21,458 bytes, +22.

### 7.2 asar format gotchas

Things that cost time:

- The 16-byte header is `struct.pack("<4I", 4, headerSize, headerSize + 4, jsonLen)` where
  `headerSize = 4 + jsonLen`
- **`data_base = 16 + jsonLen`**, not `8 + headerSize` and not `8 + b`
- The header JSON is compact (`separators=(",",":")`, `ensure_ascii=False`), no BOM, and
  padded to a 4-byte boundary
- File `offset` values are relative to `data_base`
- Each file entry carries `integrity: { algorithm: "SHA256", hash, blockSize, blocks[] }`
- **`offset` and `size` are sometimes strings and sometimes numbers.** Preserve the original
  type or the JSON round-trip breaks
- Skip directory nodes, which have no `offset`
- After changing a file's size, only entries stored **after** it need their offset shifted
- A change in header JSON length shifts every offset, so iterate to a fixed point

### 7.3 Integrity

The Electron fuse `EnableEmbeddedAsarIntegrityValidation` is **disabled** in this build, so a
modified asar loads fine. The per-file `integrity` fields in the header still matter, so the
patcher recomputes `hash` and `blocks` for the changed file and verifies all 16,651 files
before writing.

---

## 8. Verification

| Check | Result |
|---|---|
| Integrity after patching | 16,651 files, 0 hash mismatches |
| App start | five processes, all responding, no new crash logs |
| 20,000-byte header to the host port | **401 Unauthorized** (431 before the patch) |
| `revert` | back to the original 182,766,714 bytes |
| apply / revert while running | refused, exit code 1 |

---

## 9. Upstream fix

Either of these:

1. **Drop other `dsh-auth-*` cookies for the same host before issuing a new one** in
   `BrowserAuth`. Old-port cookies are already invalid, so this costs nothing.
2. **Pass `{ maxHeaderSize: 65536 }` to `createServer`** in `dsh-host-webserver`. One line.

---

## 10. Version status

| Version | Fixed |
|---|---|
| 0.2.1-rc.5 | No |
| 0.2.2-rc.1 (current nightly feed) | No. `dsh-client-connection` is byte-identical and the `createServer` call is unchanged |

Upgrading does not help. The patch applies to the latest build too.
