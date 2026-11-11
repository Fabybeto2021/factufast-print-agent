# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install deps. postinstall auto-downloads vendor/SumatraPDF.exe if missing
npm run build        # Compile TypeScript → dist/
npm run dev          # Compile + launch Electron (tsc && electron dist/main.js)
npm test             # Compile + run unit tests (node --test on dist/, see test/escpos.test.js)
npm run dist:win     # Package .exe for Windows (electron-packager, bundles vendor/SumatraPDF.exe)
npm run dist:installer  # electron-builder NSIS installer (--publish never)
npm run dist:linux   # Package .AppImage for Linux
```

**`dist/` and `vendor/` are gitignored** — never commit build artifacts. The compiled `dist/` is produced by `npm run build`; `vendor/SumatraPDF.exe` is auto-downloaded by `scripts/ensure-sumatra.js` (postinstall, best-effort/idempotent) or by the CI workflow. The earlier "stale dist" failure (a deployed binary missing source changes) is prevented by always building from source in CI.

**Releases**: bump `package.json` version, push a `v*` tag → GitHub Actions (`.github/workflows/release.yml`) builds Windows NSIS + Linux AppImage from source and publishes to GitHub Releases. `electron-updater` on the client checks 10 s after startup. **Smoke-test drawer + print on a clean Windows VM before tagging.**

**Supply chain (since 1.7.0)** — every release reaches the whole fleet on its own, so the workflow is the most sensitive door of the system:
- **Two stages.** `build-windows` / `build-linux` run with a READ-ONLY token: `npm ci`, Sumatra by hash, tests, `electron-builder --publish never`, fuses checked, SHA-256 sums, `upload-artifact`. All third-party code (npm install scripts, native rebuilds) runs here, where it cannot publish. Only `publicar` has `contents: write`, runs in the environment **`publicar-agente`** and does not install anything: it downloads the artifacts and attaches them to the release. With *Required reviewers* = the owner (Settings → Environments; configure it once, otherwise it blocks nothing) it waits for approval. Not draft releases: electron-updater doesn't see drafts and one was already forgotten (1.3.0).
- ⚠️ **The installer names are fixed in `package.json`** (`nsis.artifactName` = `FactuFAST-PrintAgent-Setup-${version}.${ext}`, `linux.artifactName` = `FactuFAST-PrintAgent-${version}.${ext}`): `latest.yml` points to the dashed name, and electron-builder used to rename on upload. Uploaded as-is, GitHub would turn the spaces into dots and no till would find the update.
- The tag must equal `v` + `package.json` version (checked in both build jobs). `npm ci` (exact lockfile), actions pinned by commit SHA (verified against upstream with `git ls-remote` on 11-nov-2026), no npm cache, `SHA256SUMS-*.txt` attached to the release. The fuses are read with the `@electron/fuses` that electron-builder brings (`npx --no-install electron-fuses`), nothing downloaded at build time.
- ⚠️ **What the workflow cannot stop** — close it in GitHub settings: a tag pushed on an OLD commit runs that commit's `release.yml` (no approval, write token for everything), and a token with write access can create a Release through the API without any workflow. Needed: tag ruleset on `*` (create/move/delete owner only — electron-updater also accepts tags without `v`), **Immutable releases**, the environment limited to `v*` tags, 2FA. Full defense = code signing + `publisherName` (out of scope, cost).
- `scripts/ensure-sumatra.js` pins SumatraPDF 3.5.2 by **SHA-256** (`290e4aa7…`, checked 10-nov-2026 with two independent downloads, Authenticode valid). Postinstall is best-effort; CI runs it with `--estricto` (exit 1 on mismatch). Changing Sumatra = change URL and hash together after checking the new signature.
- **1.8.0** = Electron 44 + fuses (no RunAsNode, no `--inspect`, no `NODE_OPTIONS`, asar-only with integrity). Apply with `scripts/preparar-1.8.0.ps1` **after** 1.7.0 is published (validated on a copy: 42 tests, electron-builder 26 packaging, fuses read back; `@serialport/bindings-cpp` is N-API, no rebuild). The CI checks the fuses as soon as `package.json` declares them. Still to test on a real till: ticket, drawer, «Probar impresora», and auto-update 1.7.0 → 1.8.0.
- `.github/dependabot.yml`: weekly npm (minor/patch grouped; Electron majors ignored — done on purpose) and monthly actions.

## Architecture

Single-process Electron app with no renderer (system tray only). The tray UI opens `assets/config.html` via `BrowserWindow` — **isolated since v1.7.0** (`contextIsolation`, `sandbox`, no Node) with the `src/preload-config.ts` bridge (`window.agente`).

### Source files (`src/`)

| File | Responsibility |
|------|----------------|
| `main.ts` | Entry point. Single-instance lock, IPC handlers (`get/save-config`, `list-printers`, `diagnostico`, `selftest`, `selftest-raster`, `probar-cajon`, `probar-ticket`) — **every handler checks the sender is `assets/config.html`** and `save-config` validates the payload (`config-validacion.ts`). Starts HTTP server, configures `electron-updater`. |
| `server.ts` | Express on `127.0.0.1:7979`. Endpoints: `GET /status` (real probe), `POST /print`, `POST /selftest`. **Guard first** (`guardia.ts`), then CORS + Private Network Access preflight, then `express.json()`. |
| `guardia.ts` | **Pure** (v1.7.0). `evaluarPeticion()` — the only thing between a web page and the cash drawer. See "Request guard". Tested in `test/guardia.test.js`. |
| `descarga.ts` | **Pure** (v1.7.0). `rutaDescargaSegura()` (same origin, `/api/` only), `tokenPermitido()` (https or this PC), `esUuid()`. Tested in `test/descarga.test.js`. |
| `config-validacion.ts` / `preload-config.ts` | v1.7.0 config window: payload validation + sender check (pure) and the isolated bridge. |
| `printer.ts` | Drawer + printing. `enviarRaw()` picks transport: **USB → winspool (Windows-only, no native module, NO fallback)**, network → TCP socket (`net`), serial → `node-thermal-printer`. `abrirCajon()`, `imprimirTicket()`, `imprimirCupones()` (two-phase ACK), `imprimirEscposInline()`, `probarImpresion()`, `verificarImpresora()` (WMI probe), `verificarServidor()`, `diagnostico()`, `listarImpresoras()`. |
| `escpos.ts` | **Pure, electron-free** ESC/POS helpers (`DRAWER_KICK`, `construirTicketPrueba`, `parseCuponIds`, `buildWinspoolScript`). Imported by `printer.ts`; unit-tested in `test/escpos.test.js`. |
| `config.ts` | `AgentConfig` + `loadConfig()`/`saveConfig()` → `userData/config.json`, merged with `DEFAULT_CONFIG`. `AGENT_PORT = 7979`. |
| `tray.ts` | Tray icon + menu (Configuración / Ver logs / Probar cajón / **Diagnóstico** / Salir). Health check every 30 s uses the **real** `verificarImpresora()` probe. |
| `logger.ts` | Appends to `userData/agent.log`. Rotates at 1 MB, keeps **5** numbered files (`.1`..`.5`). |

### HTTP API (consumed by FactuFAST POS at `src/lib/pos/printAgent.ts`)

```
POST /print  { comprobanteId?, imprimirTicket?, imprimirCupones?, abrirCajon?, authToken?,
               ticketPdfPath?,        ← generic doc (cobros / Ventas Directas), v1.2.0+
               escposBase64? }        ← pre-built ESC/POS bytes, v1.3.0+ (usable v1.4.0+)
  → 200 { ok: true }
  → 207 { ok: false, errors: string[] }   ← partial failure (e.g. drawer OK, print failed)
  body limit 10 MB — a rasterized fiscal ticket is 150–400 KB (see "Raw payload size")

GET  /status → { ok, version, printer, printerFound, printerOnline, sumatraOk, serverReachable,
                 modoTicket, ... }                    ← modoTicket: 'auto' | 'pdf', v1.5.0+
  ok = printerFound && sumatraOk. Probes real hardware/server — no longer a fixed ok:true.

POST /selftest            → prints a test receipt + opens the drawer. 200 ok / 207 with errors[].
POST /selftest {raster:'corto'|'largo'} → prints a GS v 0 RASTER test pattern (v1.5.0+)
```

`POST /print` answers `{ ok: true, nada_que_imprimir: true }` when the body asked for nothing at
all (paperless mode: no ticket, no coupons, no drawer). It used to answer a plain `ok: true` —
the agent claiming to have printed something it never printed. In one month of a real cashier's
log that was **410 documents** indistinguishable from a real print.

### `modoTicket` — the per-machine escape hatch (v1.5.0)

`config.json` gains `modoTicket: 'auto' | 'pdf'` (Configuración → *Modo de impresión del
ticket*). `auto` is the behavior of every prior version; `pdf` makes the POS skip the ESC/POS
path **on this machine only** (`printAgent.ts` reads it from `/status`).

It exists because whether a thermal printer digests a long `GS v 0` raster at the speed the
spooler hands it over is a property of the **hardware**, not of the tenant. A printer that
loses sync mid-raster needs to go back to PDF *today*, without a deploy and without touching
the other cashiers. ⚠️ With `pdf`, check the driver's paper form is set to **continuous roll**
or long tickets come out cropped again — the very thing v1.4.0 fixed.

### `construirRasterPrueba` — the diagnostic that was missing

⚠️ **`probarImpresion` proves almost nothing.** It sends a ~250-byte TEXT receipt: it passes on
a machine where every real invoice fails. That is exactly what hid the v1.3.x transport ceiling,
and what left a real "the tickets print garbage" report undiagnosable for a month. The fiscal
ticket travels as a `GS v 0` **raster**, so that path has to be exercisable on demand:

- **corto** (400 dots ≈ 5 cm) → does this printer understand `GS v 0` at all?
- **largo** (2400 dots ≈ 30 cm) → does it survive the throughput of a whole credit ticket?

The pattern is full-width rules (worst case for the head, and they break if the printer wraps
rows) + a diagonal staircase (any horizontal offset turns it into a broken diagonal) + blank
gaps (they exercise the `ESC J` feed the server emits instead of rasterizing white paper). It is
labelled with ESC/POS **text before and after**: if the trailing `FIN OK` prints but the drawing
in the middle came out as characters, the printer lost sync *inside* a `GS v 0`.

`BAND_HEIGHT` here is a **mirror of the server's** (`src/lib/sri/png-a-escpos.ts` in FactuFAST):
the test is only worth anything if it hands the printer commands of the same shape and size as a
real ticket.

The POS sends the user's Supabase `access_token` as `authToken`; the agent forwards it as `Authorization: Bearer`. **The FactuFAST PDF routes honor this Bearer via `createClientFromRequest()`** — without it the agent's download returns 401 (this was a root cause of "nothing prints").

### Cupones de ánfora — ACK de dos fases

`imprimirCupones()` sends `X-Print-Agent: 1` on the GET. The server then returns the PDF + an `X-Cupon-Ids` header **without** marking `impreso_ok`. Only after SumatraPDF exits 0 does the agent `POST /api/comprobantes/{id}/pdf/cupones/confirmar { ids }` to mark them printed. If printing fails, the coupon stays reprintable (no lost ticket). The browser iframe fallback (no ACK capability) still marks on GET.

### Drawer hardware

```
PC ──USB──► Thermal printer ──RJ11/RJ12──► Cash drawer
```

`abrirCajon()` sends both pin-2 (`1B 70 00 3C 3C`) and pin-5 (`1B 70 01 3C 3C`). On Windows USB the path is raw bytes to the spooler via `winspool.drv` P/Invoke (no native module); `node-thermal-printer` is used only for serial (`//./COMx`) and non-Windows USB. This removed the fragile native-binding dependency on the hot path.

⚠️ **There is deliberately NO fallback from winspool to `node-thermal-printer` on Windows.** Its `printer:NAME` interface requires a native `driver` module object this agent never passes, so it threw *"No driver set!"* on every call — a plan B that only ever masked the real winspool error in the logs.

### Raw payload size — the v1.4.0 fix

**A fiscal ticket rasterized to ESC/POS is 150–400 KB, and until v1.4.0 the transport could not carry it.** Two ceilings, both invisible to `/selftest`:

1. `express.json()` with no `limit` → Express 4 default is **100 KB** → **HTTP 413** before the handler ever runs.
2. `enviarRawWindows` embedded the bytes as hex **in the PowerShell command line** (~5 chars/byte) against `CreateProcess`'s **32,767**-char ceiling → only ~6 KB fit.

Small payloads passed both — drawer kick (10 B), test receipt (~300 B), offline provisional in text mode (~4 KB) — which is exactly why diagnostics looked healthy while **every real invoice** failed and fell back to PDF printing (where the driver's paper form crops long tickets). Reported as invoice `004-001-000000211` (21 items): printed up to the last line item, no totals, no authorization number, no barcode.

Rules now:
- **Bytes go through a temp file, never inside the script.** `buildWinspoolScript(dataFilePath, printerName)` lives in `escpos.ts` (pure → tested); `printer.ts` writes the temp file, runs it, and deletes it in the callback. Tests assert the script stays a constant ~2 KB regardless of ticket size.
- `execFile` timeout is **25 s** (POS waits 30 s before giving the ticket up for lost and reprinting via browser — a duplicate).
- ⚠️ **`enviarRawWindows` logs the RESULT, not just the send.** Until v1.5.0 it wrote `winspool: enviando N bytes` and nothing else — no success line, no duration — while `imprimirEscposInline` logged nothing at all. Consequence: a full month of a cashier's log could not answer *"did the ticket print?"*, which is precisely the question a "it prints garbage" report needs answered. Now every job closes with `winspool: N bytes entregados OK en X ms` (the duration also exposes how close a long ticket ran to the 25 s ceiling) and every failure logs **`stderr`**, where the real reason lives — `err.message` alone just says "Command failed".
- **TCP uses `socket.end(data)` and waits for close**, not `write()` + `destroy()` after 150 ms: `destroy()` discards whatever is still buffered, truncating the tail of a long ticket to a slow network printer. If the printer never closes its side (common), a 2 s grace timer resolves anyway — the bytes were already flushed and FIN sent.
- The web side gates on **agent ≥ 1.4.0** (`MIN_VER_ESCPOS_INLINE` in `src/lib/pos/printAgent.ts`), not ≥1.3.0. Sending ESC/POS to a 1.3.x agent yields a 413 with no `errors` array, which drives FactuFAST's `debeFallback` into its conservative branch → a browser print dialog on every sale.

### Request guard (v1.7.0) — why CORS was not enough

Up to v1.6.0 the server only **set CORS headers** and always called `next()`. CORS decides whether the
*browser lets a page read the response*; it never stops the server from *executing* the request. A
`POST /selftest` with no body is a "simple" request (no preflight), so **any page open on the till PC
— an ad, an email, a link — could print and kick the cash drawer**.

`evaluarPeticion()` runs **before `express.json()`**, for every method:

1. `Host` must be `127.0.0.1:7979` or `localhost:7979` → closes DNS rebinding (`evil.com` re-resolved to 127.0.0.1 arrives with `Host: evil.com:7979`).
2. If `Origin` is present it must be allowed (`origenPermitido`) → 403 for every method. `Origin: null` (a `file://` page) is rejected.
3. `POST` must be `application/json` → 415. An HTML form cannot send JSON, and a JSON fetch forces a preflight that a foreign origin cannot pass.
4. No `Origin` but `Sec-Fetch-Site: cross-site|same-site` → 403 (`<img>`, links). curl and local processes (FactuFAST Desktop's main process) send neither header and keep working.

CORS is only emitted for an allowed origin, never `*`, with `Vary: Origin` and `Access-Control-Max-Age: 600`.

⚠️ **Ship order: web first.** The POS's "Probar impresora" used to `POST /selftest` with no
`Content-Type`; this agent answers that with 415. FactuFAST's `pos/configuracion/page.tsx` sends JSON
since 10-nov-2026 — deploy that before releasing 1.7.0.

⚠️ The config window can no longer `fetch('http://127.0.0.1:7979/print')` (its `Origin` is `null`):
"Probar cajón" and "Probar ticket" go through IPC (`probar-cajon`, `probar-ticket`).

### Download path and token (v1.7.0)

Until v1.6.0 the PDF URL was `${servidor}${ticketPdfPath}` with no checks: `@evil.com/x` became
`https://app.reslez.com@evil.com/x` — host `evil.com` — and the agent sent it the cashier's token in
`Authorization`. Now `rutaDescargaSegura()` requires a `/api/` path with no `//`, `\`, `@`, spaces or
control chars and the **same origin** as the server; `comprobanteId` must be a UUID; and the token is
only sent over https or to this PC (`tokenPermitido`) — over http on the LAN it is dropped (the
download then fails visibly with 401).

### Private Network Access (PNA)

Browsers are tightening calls from HTTPS pages to `http://localhost`. `server.ts` answers the PNA preflight with `Access-Control-Allow-Private-Network: true`, so a Chrome/Edge update won't silently block the agent.

### Allowed origins and download server (v1.6.0)

The platform moved from `www.serviplast.pro` to `app.reslez.com` (31-oct-2026) and both domains serve the same app for weeks. Up to v1.5.0 the agent accepted **only the exact origin of its `serverUrl`** (CORS) and always downloaded PDFs **from `serverUrl`** — so a till opened on the new domain with the agent still pointing at the old one could not print (browser dialog on every sale), and every till would break the day the old domain went away.

`src/origenes.ts` (pure, tested in `test/origenes.test.js`):
- `origenPermitido(origin, serverUrl, extra, { permitirLocal })` — the configured `serverUrl`, the closed list `ORIGENES_PLATAFORMA` (`app.reslez.com`, `beta.reslez.com`), and optional `origenesPermitidos` from `config.json`. **Any** `http://localhost:*` (exact host) only with `permitirOrigenLocal: true` in `config.json` (v1.7.0 — any program on the PC can open a local port). `SERVIDORES_RETIRADOS` are **never** accepted, not even if written in `serverUrl` or `origenesPermitidos`.
- `baseDescarga(origin, serverUrl)` — PDFs (ticket, cupones and the cupones ACK) are fetched from **the same origin that asked for the print**; without an `Origin` header, from `serverUrl`. The agent follows the till, not the other way round.
- ⚠️ The list is **closed on purpose**: the agent opens the drawer and receives the cashier's session token. Accepting any https origin would let any page open on that PC kick the drawer or receive the token.
- Safe while the fleet is mixed: for a till whose page origin equals its `serverUrl` (every till before the move) behaviour is byte-for-byte the same.
- `migrarServerUrl(url)` — since 1-nov-2026 `serviplast.pro` is a client's own website (SPPLAST), not the platform. `https.get` does not follow redirects, so `loadConfig()` reads a `serverUrl` on the retired domain as `SERVIDOR_ACTUAL`; the file is rewritten the next time the config is saved. **v1.7.0 removed the retired domains from `ORIGENES_PLATAFORMA`** — the owner's pages must not open the drawer or receive the till token.

### Config storage

`%APPDATA%\FactuFAST PrintAgent\config.json`. Fields: `printerName`, `printerInterface` (`usb|serial|network`), `serialPort`, `networkHost`, `networkPort`, `serverUrl`, `notificaciones`, optional `origenesPermitidos` (extra https origins, v1.6.0), optional `permitirOrigenLocal` (any localhost, dev only, v1.7.0). The last two can only be set by editing the file: the config window drops them. The config window populates a printer **dropdown** (datalist) from `list-printers` (PowerShell `Get-Printer`) and has a **Diagnóstico** button. (The dead `agentPort` field was removed.)

### Key constraints

- **Tests**: `test/*.test.js` (node:test) — ESC/POS helpers, origins, request guard, download path and config validation. Keep pure logic in electron-free modules so it stays testable.
- The config window is isolated (v1.7.0). **Never** go back to `nodeIntegration: true`; add a method to `preload-config.ts` and a sender-checked IPC handler instead.
- `electron-updater` and `node-thermal-printer` are `require()`'d lazily inside functions.
- **`SumatraPDF.exe` path**: `process.resourcesPath` when packaged; `path.join(__dirname, '..', 'vendor')` in dev.
- **Health check** uses the real WMI `Win32_Printer` probe (`WorkOffline`/existence), not just "is a name configured".
