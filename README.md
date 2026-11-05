# dsh-header-fix

[![Platform](https://img.shields.io/badge/platform-Windows%20x64-lightgrey)](#usage)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-0.2.1--rc.5%2B-4B32C3)](#version-status)
[![Node](https://img.shields.io/badge/node-%3E%3D22-339933)](#usage)
[![Status](https://img.shields.io/badge/status-workaround-orange)](#what-the-fix-does)

Fixes a startup failure in DeepSeek Harness:

```
Error: desktop welcome: Web authentication failed
```

If the window never appears, or flashes and closes, and `logs\crash-*-host.log` keeps
filling up with that line, this is the cause.

---

## Symptoms

- Double-clicking the icon does nothing, or the window closes right away
- `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log` contains:

  ```
  source: host
  phase: startup
  Error: desktop welcome: Web authentication failed
      at connectDesktopWelcome (.../app.asar/lib/main.js:8886)
  ```

- Reinstalling does not help, switching networks does not help, clearing the cache does not help
- It shows up after the app has been used for a while, and comes back periodically

---

## Cause

On every launch the desktop shell starts a local host on `127.0.0.1:<random port>` and
issues a `dsh-auth-*` cookie to authenticate against it.

1. The port changes each launch (`--port 0`), so a new cookie is issued every time
2. Old cookies are never removed and live for 30 days
3. `connectDesktopWelcome()` calls `net.fetch(..., { credentials: "include" })`, so Chromium
   sends every cookie matching `127.0.0.1` in the `Cookie` header, regardless of port
4. Each cookie is about 227 bytes. By the 71st one the header reaches 16,186 bytes, and with
   the usual UA / accept / sec-fetch-* headers the request totals 16,555 bytes, past Node's
   default `http.maxHeaderSize` of 16384
5. The host answers `431 Request Header Fields Too Large`, the shell treats it as an auth
   failure, and the app never opens

Network, proxy, account and installer are all unrelated. It is purely a matter of launch
count: around 70 launches and it breaks.

See [docs/ROOT-CAUSE.md](docs/ROOT-CAUSE.md) for the full investigation.

---

## What the fix does

| Step | Effect |
|---|---|
| Patch `app.asar` | Changes the host's `createServer(listener)` to `createServer({ maxHeaderSize: 65536 }, listener)`, raising the limit from 16 KiB to 64 KiB |
| Clean cookies | Deletes `dsh-auth-*` cookies for `host_key='127.0.0.1'` from `Network\Cookies` |

The patch touches one call site in one file (`dsh-host-webserver/lib/index.js`, 21,436 to
21,458 bytes) and recomputes that file's asar `integrity` hash. The other 16,650 files are
byte-identical.

---

## Usage

### Quit the app first

Right-click the tray icon and quit, or end every `DeepSeek Harness.exe` in Task Manager.
The tool refuses to run while the app is up, because `Network\Cookies` is locked.

### Patch

Double-click `fix.bat`, or from a terminal:

```bat
fix.bat
```

It finds the install directory through the uninstall registry key, falling back to
`%LOCALAPPDATA%\Programs\DeepSeek Harness`, and runs on the Node runtime bundled with the
app. Nothing needs to be installed.

For a non-default location:

```bat
fix.bat apply "D:\Apps\DeepSeek Harness"
```

### Revert

```bat
revert.bat
```

Copies `resources\app.asar.orig` back over `app.asar`. The backup is created on the first
patch.

### Inspect only

```bat
fix.bat check     :: install dir, asar size, backup state, patched or not
fix.bat verify    :: full integrity check of all 16,651 files in the asar
```

### Conservative option

If you would rather not modify `app.asar`, clean the cookies only:

```bat
tools\clean-cookies.bat
```

Or with any Node.js >= 22.5:

```bash
node tools/clean-cookies.mjs --dry-run   # count first
node tools/clean-cookies.mjs             # then delete
```

This works immediately but returns after about 70 launches. `fix.bat` is the permanent fix.

---

## Notes

- **Auto-update replaces `app.asar`**, which removes the patch. Run `fix.bat` again after
  updating. It is idempotent, so an already-patched install is skipped.
- The backup `app.asar.orig` is about 174 MB and stays in the install directory. You can
  delete it once things are stable, but then `revert.bat` will not work and a reinstall is
  the only way back.
- The patch does not touch user settings, credentials or model configuration.
- If `check` reports `found N patch anchors, expected exactly 1`, DeepSeek changed that code.
  The tool stops without writing anything. Please open an issue with the version number.

---

## Files

```
fix.bat                    one-click patch, locates the install dir itself
revert.bat                 one-click revert
patch.mjs                  apply / revert / check / verify
tools/clean-cookies.mjs    standalone cookie cleanup
tools/clean-cookies.bat    Windows wrapper for the above
docs/ROOT-CAUSE.md         investigation notes, measurements, asar format details
```

`patch.mjs` also runs on any Node.js >= 22:

```bash
node patch.mjs apply "/path/to/DeepSeek Harness"
```

---

## Tested on

- DeepSeek Harness **0.2.1-rc.5**, Windows x64, Electron 44.7.0 / Node 24.21.0
- After patching: all 16,651 file hashes match; a 20,000-byte request header to the host
  port returns `401 Unauthorized` instead of `431`; the app starts with all five processes
  responding.

### Version status

| Version | Fixed upstream |
|---|---|
| 0.2.1-rc.5 | No |
| 0.2.2-rc.1 (current nightly feed) | No. `dsh-client-connection` is byte-identical and the `createServer` call is unchanged |

Upgrading does not help. The patch applies to the latest build as well.

---

## Suggested upstream fix

Either of these would do it:

1. Have `BrowserAuth` drop other `dsh-auth-*` cookies for the same host before issuing a new
   one. Old-port cookies are already invalid, so nothing is lost.
2. Pass `{ maxHeaderSize: 65536 }` to `createServer` in `dsh-host-webserver`. One line.

---

## License

MIT
