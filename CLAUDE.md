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

## Architecture

Single-process Electron app with no renderer (system tray only). The tray UI opens `assets/config.html` via `BrowserWindow` with `nodeIntegration: true`.

### Source files (`src/`)

| File | Responsibility |
|------|----------------|
| `main.ts` | Entry point. Single-instance lock, IPC handlers (`get/save-config`, `list-printers`, `diagnostico`, `selftest`), starts HTTP server, configures `electron-updater`. |
| `server.ts` | Express on `127.0.0.1:7979`. Endpoints: `GET /status` (real probe), `POST /print`, `POST /selftest`. CORS + Private Network Access preflight. |
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

GET  /status → { ok, version, printer, printerFound, printerOnline, sumatraOk, serverReachable, ... }
  ok = printerFound && sumatraOk. Probes real hardware/server — no longer a fixed ok:true.

POST /selftest → prints a test receipt + opens the drawer. 200 ok / 207 with errors[].
```

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
- **TCP uses `socket.end(data)` and waits for close**, not `write()` + `destroy()` after 150 ms: `destroy()` discards whatever is still buffered, truncating the tail of a long ticket to a slow network printer. If the printer never closes its side (common), a 2 s grace timer resolves anyway — the bytes were already flushed and FIN sent.
- The web side gates on **agent ≥ 1.4.0** (`MIN_VER_ESCPOS_INLINE` in `src/lib/pos/printAgent.ts`), not ≥1.3.0. Sending ESC/POS to a 1.3.x agent yields a 413 with no `errors` array, which drives FactuFAST's `debeFallback` into its conservative branch → a browser print dialog on every sale.

### Private Network Access (PNA)

Browsers are tightening calls from HTTPS pages to `http://localhost`. `server.ts` answers the PNA preflight with `Access-Control-Allow-Private-Network: true`, so a Chrome/Edge update won't silently block the agent.

### Config storage

`%APPDATA%\FactuFAST PrintAgent\config.json`. Fields: `printerName`, `printerInterface` (`usb|serial|network`), `serialPort`, `networkHost`, `networkPort`, `serverUrl`, `notificaciones`. The config window populates a printer **dropdown** (datalist) from `list-printers` (PowerShell `Get-Printer`) and has a **Diagnóstico** button. (The dead `agentPort` field was removed.)

### Key constraints

- **Tests**: `test/escpos.test.js` (node:test) covers the pure ESC/POS helpers. Keep pure logic in `escpos.ts` so it stays testable without Electron.
- `nodeIntegration: true` in the config window is intentional (`ipcRenderer` access).
- `electron-updater` and `node-thermal-printer` are `require()`'d lazily inside functions.
- **`SumatraPDF.exe` path**: `process.resourcesPath` when packaged; `path.join(__dirname, '..', 'vendor')` in dev.
- **Health check** uses the real WMI `Win32_Printer` probe (`WorkOffline`/existence), not just "is a name configured".
