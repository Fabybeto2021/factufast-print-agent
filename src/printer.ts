import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as net from 'net';
import { execFile } from 'child_process';
import { loadConfig, AgentConfig } from './config';
import {
  DRAWER_KICK, construirTicketPrueba, parseCuponIds, buildWinspoolScript, construirRasterPrueba,
} from './escpos';
import { log } from './logger';
import { baseDescarga } from './origenes';
import { esUuid, rutaDescargaSegura, tokenPermitido } from './descarga';

const DOWNLOAD_TIMEOUT_MS = 10_000;

// Techo para que el spooler termine de tragarse el trabajo. Un ticket fiscal
// rasterizado son cientos de KB y en una PC de caja lenta no salen en 8 s. Se queda
// por debajo de los 30 s que espera el POS antes de dar el ticket por perdido y
// reimprimirlo por navegador (que produciría un duplicado).
const WINSPOOL_TIMEOUT_MS = 25_000;

// Inactividad tolerada al conectar/enviar a una impresora de red. Mide silencio del
// socket, no duración total, así que una transferencia larga que avanza no lo dispara.
const TCP_IDLE_TIMEOUT_MS = 10_000;

// Margen para que la impresora cierre su lado tras recibir el FIN. Si no cierra
// (habitual en térmicas de red), damos el envío por bueno igual.
const TCP_CIERRE_GRACIA_MS = 2_000;

export function getSumatraPath(): string {
  const resourcesPath = process.resourcesPath ?? path.join(__dirname, '..', 'vendor');
  return path.join(resourcesPath, 'SumatraPDF.exe');
}

export function sumatraDisponible(): boolean {
  try { return fs.existsSync(getSumatraPath()); } catch { return false; }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ──────────────────────────────────────────────────────────────────────────
// Transporte RAW de bytes ESC/POS — sin módulo nativo en el camino USB/red.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Envía bytes raw a una impresora térmica según la interfaz configurada.
 * USB (Windows) → spooler winspool (Win32 API, sin nativo). Único camino, sin plan B.
 * Red          → socket TCP directo (módulo net, sin nativo).
 * Serial       → node-thermal-printer (//./COMx), el único que usa binding nativo.
 *
 * Debe soportar desde 10 bytes (pulso de cajón) hasta ~400 KB (ticket fiscal
 * rasterizado); ver `buildWinspoolScript` y la nota de tamaños en CLAUDE.md.
 */
async function enviarRaw(data: Buffer, cfg: AgentConfig): Promise<void> {
  if (cfg.printerInterface === 'network') {
    await enviarRawTcp(data, cfg.networkHost, cfg.networkPort);
    return;
  }

  if (cfg.printerInterface === 'serial') {
    await enviarRawThermalPrinter(data, `//./${cfg.serialPort}`);
    return;
  }

  // USB (default)
  if (!cfg.printerName) throw new Error('Nombre de impresora no configurado');
  if (os.platform() === 'win32') {
    // Sin fallback: la interfaz `printer:` de node-thermal-printer exige un módulo
    // driver nativo que este agente nunca pasa, así que lanzaba "No driver set!"
    // SIEMPRE — un plan B que solo servía para enmascarar el error real de winspool.
    await enviarRawWindows(data, cfg.printerName);
    return;
  }
  // SO no-Windows con interfaz USB → node-thermal-printer
  await enviarRawThermalPrinter(data, `printer:${cfg.printerName}`);
}

/**
 * Envía bytes raw al spooler de Windows usando la Win32 API vía PowerShell.
 * No requiere que la impresora esté compartida en red ni módulos nativos.
 *
 * Los bytes viajan por un archivo temporal, no dentro del script — ver
 * `buildWinspoolScript` para el porqué (la línea de comandos de Windows tiene techo).
 */
let rawSeq = 0;

function enviarRawWindows(data: Buffer, printerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // El contador evita que dos trabajos del mismo milisegundo compartan archivo.
    const tmpBin = path.join(os.tmpdir(), `ff_raw_${process.pid}_${Date.now()}_${++rawSeq}.bin`);
    const limpiar = () => { try { fs.unlinkSync(tmpBin); } catch { /* noop */ } };

    try {
      fs.writeFileSync(tmpBin, data);
    } catch (err) {
      reject(new Error(`No se pudo escribir el archivo temporal: ${(err as Error).message}`));
      return;
    }

    const ps = buildWinspoolScript(tmpBin, printerName);
    log('INFO', `winspool: enviando ${data.length} bytes a "${printerName}"`);
    const t0 = Date.now();

    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: WINSPOOL_TIMEOUT_MS },
      (err, stdout, stderr) => {
        limpiar();
        const ms = Date.now() - t0;
        if (err || !/OK/.test(stdout || '')) {
          // ⚠️ El motivo REAL vive en stderr: OpenPrinter / StartDocPrinter / WritePrinter
          // lo escriben con Write-Error. `err.message` a secas solo dice "Command failed".
          const detalle = stderr?.trim() || err?.message || 'PowerShell/winspool falló';
          log('ERROR', `winspool: FALLÓ tras ${ms} ms — ${detalle}`);
          reject(new Error(detalle));
        } else {
          // ⚠️ Esta línea no es ruido: hasta ago-2026 el camino ESC/POS solo dejaba el
          // "enviando N bytes" y NADA sobre el resultado, así que un mes entero de log no
          // podía responder "¿se imprimió?" — que es justo lo que hizo falta para
          // diagnosticar la caja de SPPLAST. La duración además delata si se rozó el
          // techo de WINSPOOL_TIMEOUT_MS.
          log('INFO', `winspool: ${data.length} bytes entregados OK en ${ms} ms`);
          resolve();
        }
      });
  });
}

/** Envía bytes raw por socket TCP (impresoras de red, puerto 9100 típico). */
function enviarRawTcp(data: Buffer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let done = false;
    let graceTimer: NodeJS.Timeout | null = null;
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      if (graceTimer) clearTimeout(graceTimer);
      socket.destroy();
      err ? reject(err) : resolve();
    };

    // El timeout de inactividad solo vigila la conexión y el envío: una vez que los
    // bytes están drenados deja de aplicar (ver abajo).
    socket.setTimeout(TCP_IDLE_TIMEOUT_MS);
    socket.on('timeout', () => finish(new Error(`Sin respuesta de ${host}:${port}`)));
    socket.on('error', (err) => finish(err));
    socket.on('close', () => finish());

    socket.connect(port, host, () => {
      // `end(data)` escribe y CIERRA con FIN: el kernel drena lo pendiente antes de
      // cortar. Antes se hacía `write()` + `destroy()` 150 ms después, y destroy
      // descarta lo que siga en el buffer → el final de un ticket largo hacia una
      // impresora lenta se perdía.
      socket.end(data, () => {
        // Bytes entregados al SO y FIN enviado: el trabajo está hecho. Muchas
        // térmicas de red no cierran su lado, así que esperar 'close' indefinidamente
        // acabaría en un timeout que reportaría como fallo algo que SÍ se imprimió.
        // Damos un margen corto para un cierre limpio y, si no llega, resolvemos.
        socket.setTimeout(0);
        graceTimer = setTimeout(() => finish(), TCP_CIERRE_GRACIA_MS);
      });
    });
  });
}

/** Fallback con node-thermal-printer (usa @serialport/bindings-cpp para serial). */
async function enviarRawThermalPrinter(data: Buffer, iface: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ThermalPrinter, PrinterTypes, CharacterSet, BreakLine } = require('node-thermal-printer');
  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: iface,
    characterSet: CharacterSet.PC437_USA,
    breakLine: BreakLine.WORD,
    options: { timeout: 3000 },
  });
  await printer.isPrinterConnected();
  printer.raw(data);
  await printer.execute();
  await printer.clear();
}

// ──────────────────────────────────────────────────────────────────────────
// Cajón registrador
// ──────────────────────────────────────────────────────────────────────────

/** Abre el cajón registrador enviando el pulso ESC/POS (pin 2 + pin 5). */
/**
 * Imprime bytes ESC/POS que llegan YA construidos (base64 en POST /print).
 * Existe para el comprobante PROVISIONAL de la venta sin internet (FactuFAST
 * Desktop): sin conexion no hay servidor que genere el PDF/raster, asi que la
 * pagina compone el ticket en modo texto y aqui solo se transporta.
 */
export async function imprimirEscposInline(base64: string): Promise<void> {
  const data = Buffer.from(base64, 'base64');
  if (data.length === 0) throw new Error('escposBase64 vacio o invalido');
  const cfg = loadConfig();
  const t0 = Date.now();
  await enviarRaw(data, cfg);
  log('INFO', `escpos: ticket de ${data.length} bytes impreso OK en ${Date.now() - t0} ms`);
}

export async function abrirCajon(): Promise<void> {
  const cfg = loadConfig();
  log('INFO', `Abriendo cajón — interfaz: ${cfg.printerInterface}, impresora: "${cfg.printerName}"`);
  try {
    await enviarRaw(DRAWER_KICK, cfg);
    log('INFO', 'Cajón: comando enviado OK');
  } catch (err) {
    const msg = `No se pudo abrir el cajón: ${(err as Error).message}`;
    log('ERROR', msg);
    throw new Error(msg);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Impresión de PDF (RIDE fiscal y boletos de ánfora) vía SumatraPDF
// ──────────────────────────────────────────────────────────────────────────

/**
 * Descarga el ticket 80mm e imprime con SumatraPDF.
 * `ticketPdfPath` (opcional) = ruta relativa a un PDF genérico (recibos de cobros,
 * tickets de Ventas Directas). Si falta, se usa el RIDE fiscal del comprobante.
 */
export async function imprimirTicket(
  comprobanteId: string, authToken?: string, ticketPdfPath?: string, base?: string,
): Promise<void> {
  await imprimirPdf(comprobanteId, 'ticket', 'ticket', authToken, undefined, ticketPdfPath, base);
}

/**
 * Descarga e imprime los boletos de sorteo de ánfora (independiente del ticket fiscal).
 * ACK de dos fases: el servidor NO marca impreso_ok en el GET (header X-Print-Agent);
 * recién tras imprimir físicamente (SumatraPDF exit 0) confirmamos vía POST. Si la
 * impresión falla, el boleto sigue reimprimible (no se pierde).
 * 204 del servidor = nada que imprimir (digital / ya impresos) → no es error.
 */
export async function imprimirCupones(comprobanteId: string, authToken?: string, base?: string): Promise<void> {
  const servidor = base || baseDescarga(undefined, loadConfig().serverUrl);
  const { printed, cuponIds } = await imprimirPdf(
    comprobanteId, 'cupones', 'cupones', authToken, { 'X-Print-Agent': '1' }, undefined, servidor,
  );
  if (printed && cuponIds.length > 0) {
    try {
      // La confirmación va al MISMO servidor del que salieron los boletos.
      await confirmarCupones(servidor, comprobanteId, cuponIds, authToken);
      log('INFO', `Cupones ${comprobanteId} confirmados (${cuponIds.length})`);
    } catch (err) {
      // El boleto ya salió impreso; si la confirmación falla queda reimprimible.
      log('WARN', `No se pudo confirmar impresión de cupones: ${(err as Error).message}`);
    }
  }
}

interface ImprimirResult { printed: boolean; cuponIds: string[]; }

async function imprimirPdf(
  comprobanteId: string,
  pathSuffix: string,
  label: string,
  authToken?: string,
  extraHeaders?: Record<string, string>,
  overridePath?: string,
  base?: string,
): Promise<ImprimirResult> {
  const cfg = loadConfig();
  if (!cfg.printerName) throw new Error('Nombre de impresora no configurado');
  // Servidor de descarga: el origen que pidió la impresión (v1.6.0); sin él, serverUrl.
  const servidor = base || baseDescarga(undefined, cfg.serverUrl);

  const sumatraExe = getSumatraPath();
  if (!fs.existsSync(sumatraExe)) {
    throw new Error('SumatraPDF.exe no encontrado en: ' + sumatraExe);
  }

  // Documento genérico (cobros/VD) → ruta relativa dada; si no, RIDE del comprobante.
  // ⚠️ v1.7.0: la URL tiene que quedar en el MISMO servidor y en /api/ (con `@evil.com`
  // en la ruta, el token de la caja viajaba a otro host). El id, con forma de UUID.
  if (!overridePath && !esUuid(comprobanteId)) throw new Error('id de comprobante inválido');
  const pdfUrl = rutaDescargaSegura(
    servidor,
    // `||` y no `??`: la guarda de arriba trata la cadena vacía como «no viene».
    overridePath || `/api/comprobantes/${comprobanteId}/pdf/${pathSuffix}`,
  );
  // El token solo por https (o a esta misma PC): por http en la red lo vería cualquiera.
  if (authToken && !tokenPermitido(servidor)) {
    log('WARN', `Servidor ${servidor} sin https: se descarga sin el token de la sesión`);
    authToken = undefined;
  }
  const idSafe = esUuid(comprobanteId) ? comprobanteId : 'doc';
  const tmpPdf = path.join(os.tmpdir(), `${label}_${idSafe}_${Date.now()}.pdf`);

  log('INFO', `Descargando ${label} ${comprobanteId} desde ${pdfUrl}`);

  let lastError: Error | null = null;
  let descarga: DescargaResult = { hayContenido: false, cuponIds: [] };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      descarga = await descargarArchivo(pdfUrl, tmpPdf, authToken, extraHeaders);
      lastError = null;
      break;
    } catch (err) {
      lastError = err as Error;
      log('WARN', `Descarga ${label} intento ${attempt}/3 falló: ${lastError.message}`);
      if (attempt < 3) await delay(1500);
    }
  }
  if (lastError) {
    throw new Error(`Descarga de ${label} falló tras 3 intentos: ${lastError.message}`);
  }

  if (!descarga.hayContenido) {
    log('INFO', `Sin ${label} para imprimir (204) — omitido`);
    return { printed: false, cuponIds: [] };
  }

  log('INFO', `PDF ${label} descargado, enviando a impresora "${cfg.printerName}"`);

  await new Promise<void>((resolve, reject) => {
    execFile(
      sumatraExe,
      // -print-settings "noscale": imprime al 100% (tamaño real). Sin esto SumatraPDF
      // usa "shrink to fit" y encoge los tickets largos (página más alta que el papel)
      // en vez de alimentarlos continuos en el rollo térmico.
      ['-print-to', cfg.printerName, '-print-settings', 'noscale', '-silent', tmpPdf],
      { timeout: 15_000 },
      (err) => {
        try { fs.unlinkSync(tmpPdf); } catch { /* noop */ }
        if (err) {
          // err.code = exit code de SumatraPDF (≠0 → no imprimió)
          const code = (err as NodeJS.ErrnoException).code ?? 'desconocido';
          log('ERROR', `SumatraPDF (${label}) falló (exit ${code}): ${err.message}`);
          reject(err);
        } else {
          log('INFO', `${label} ${comprobanteId} impreso OK`);
          resolve();
        }
      },
    );
  });

  return { printed: true, cuponIds: descarga.cuponIds };
}

interface DescargaResult { hayContenido: boolean; cuponIds: string[]; }

/** Descarga el PDF. 200 → guarda archivo (+ lee X-Cupon-Ids); 204 → sin contenido. */
function descargarArchivo(
  url: string,
  destPath: string,
  authToken?: string,
  extraHeaders?: Record<string, string>,
): Promise<DescargaResult> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const headers: Record<string, string> = { ...(extraHeaders ?? {}) };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const file = fs.createWriteStream(destPath);
    const cleanup = () => { try { fs.unlinkSync(destPath); } catch { /* noop */ } };

    const req = proto.get(url, { headers }, (res) => {
      if (res.statusCode === 204) {
        res.resume();
        file.close();
        cleanup();
        resolve({ hayContenido: false, cuponIds: [] });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        file.close();
        cleanup();
        reject(new Error(`HTTP ${res.statusCode} al descargar PDF`));
        return;
      }
      const cuponIds = parseCuponIds(res.headers['x-cupon-ids']);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve({ hayContenido: true, cuponIds }); });
      file.on('error', (err) => { file.close(); cleanup(); reject(err); });
    });

    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => {
      req.destroy(new Error(`Timeout (${DOWNLOAD_TIMEOUT_MS}ms) descargando PDF`));
    });
    req.on('error', (err) => { file.close(); cleanup(); reject(err); });
  });
}

/** Fase 2 del ACK: confirma al servidor que los boletos se imprimieron físicamente. */
function confirmarCupones(
  serverUrl: string,
  comprobanteId: string,
  ids: string[],
  authToken?: string,
): Promise<void> {
  if (!esUuid(comprobanteId)) return Promise.reject(new Error('id de comprobante inválido'));
  const url = rutaDescargaSegura(serverUrl, `/api/comprobantes/${comprobanteId}/pdf/cupones/confirmar`);
  if (authToken && !tokenPermitido(serverUrl)) authToken = undefined;
  const payload = Buffer.from(JSON.stringify({ ids }), 'utf-8');
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(payload.length),
    };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;

    const req = proto.request(url, { method: 'POST', headers }, (res) => {
      res.resume();
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) resolve();
      else reject(new Error(`HTTP ${res.statusCode} al confirmar cupones`));
    });
    req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => req.destroy(new Error('Timeout confirmando cupones')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Diagnóstico: prueba de impresión + sondas de hardware/servidor
// ──────────────────────────────────────────────────────────────────────────

/** Imprime un recibo de prueba por la interfaz configurada. */
export async function probarImpresion(): Promise<void> {
  const cfg = loadConfig();
  log('INFO', 'Imprimiendo recibo de prueba');
  await enviarRaw(construirTicketPrueba(cfg), cfg);
  log('INFO', 'Recibo de prueba enviado OK');
}

/** Alto en puntos de cada prueba de ráster (203 puntos = 1 pulgada de papel). */
export const RASTER_PRUEBA_CORTO = 400;    // ~5 cm — ¿esta impresora entiende GS v 0?
export const RASTER_PRUEBA_LARGO = 2400;   // ~30 cm — el largo de un ticket a crédito real

/**
 * Imprime un patrón de ráster ESC/POS.
 *
 * ⚠️ Es la prueba que le faltaba al diagnóstico. `probarImpresion` manda un recibo de
 * TEXTO de ~250 bytes: pasa siempre, incluso en una máquina donde toda factura real sale
 * mal — el mismo agujero que ya escondió el fallo de transporte de la v1.3.x. El ticket
 * fiscal viaja como ráster `GS v 0` y ese es el camino que hay que poder ejercitar.
 *
 * Con `corto` se responde "¿entiende ráster?"; con `largo`, "¿aguanta un ticket entero?".
 * Si el rótulo FIN sale impreso pero el dibujo del medio salió como caracteres, la
 * impresora perdió la sincronía dentro del ráster.
 */
export async function probarRaster(filas: number, titulo: string): Promise<void> {
  const cfg = loadConfig();
  log('INFO', `Imprimiendo raster de prueba — ${filas} filas (${titulo})`);
  await enviarRaw(construirRasterPrueba({ filas, titulo }), cfg);
  log('INFO', `Raster de prueba (${filas} filas) enviado OK`);
}

export interface SondaImpresora { found: boolean; online: boolean; detalle: string; }

/** Verifica que la impresora exista y esté en línea (sin imprimir nada). */
export async function verificarImpresora(): Promise<SondaImpresora> {
  const cfg = loadConfig();

  if (cfg.printerInterface === 'network') {
    return new Promise<SondaImpresora>((resolve) => {
      const socket = new net.Socket();
      let done = false;
      const fin = (online: boolean, detalle: string) => {
        if (done) return; done = true; socket.destroy();
        resolve({ found: online, online, detalle });
      };
      socket.setTimeout(2500);
      socket.on('timeout', () => fin(false, `Sin respuesta de ${cfg.networkHost}:${cfg.networkPort}`));
      socket.on('error', (e) => fin(false, e.message));
      socket.connect(cfg.networkPort, cfg.networkHost, () => fin(true, 'Impresora de red accesible'));
    });
  }

  if (!cfg.printerName) return { found: false, online: false, detalle: 'Sin impresora configurada' };

  if (os.platform() !== 'win32') {
    // Sin sonda fiable fuera de Windows — asumimos configurada.
    return { found: true, online: true, detalle: 'Sonda no disponible en este SO' };
  }

  return new Promise<SondaImpresora>((resolve) => {
    // El nombre va en un literal de PowerShell entre comillas SIMPLES (solo `'` se escapa,
    // doblándolo) y se compara con -eq: entre comillas dobles PowerShell interpretaría
    // `$()` y el acento grave, y un filtro WQL además exige escapar las `\` de las
    // impresoras de red (\\servidor\cola).
    const nombre = cfg.printerName.replace(/'/g, "''");
    const ps = `$n = '${nombre}'; ` +
      `$p = Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq $n } | Select-Object -First 1; ` +
      `if ($null -eq $p) { 'NOTFOUND' } elseif ($p.WorkOffline) { 'OFFLINE' } else { 'ONLINE' }`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 5000 }, (err, stdout) => {
        const out = (stdout || '').trim().toUpperCase();
        if (err) return resolve({ found: false, online: false, detalle: 'Error consultando impresora' });
        if (out.includes('NOTFOUND')) return resolve({ found: false, online: false, detalle: 'Impresora no encontrada en Windows' });
        if (out.includes('OFFLINE')) return resolve({ found: true, online: false, detalle: 'Impresora fuera de línea' });
        if (out.includes('ONLINE')) return resolve({ found: true, online: true, detalle: 'Impresora en línea' });
        return resolve({ found: false, online: false, detalle: 'Estado desconocido' });
      });
  });
}

/** Verifica que el servidor FactuFAST sea alcanzable. */
export function verificarServidor(): Promise<boolean> {
  const cfg = loadConfig();
  const url = `${cfg.serverUrl}`;
  return new Promise((resolve) => {
    try {
      const proto = url.startsWith('https') ? https : http;
      const req = proto.get(url, (res) => { res.resume(); resolve(true); });
      req.setTimeout(3000, () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    } catch { resolve(false); }
  });
}

export interface SelfTestReport {
  printerName: string;
  printerInterface: string;
  /** Lo consume el POS (`printAgent.ts`) para saltarse el ESC/POS en esta caja. */
  modoTicket: string;
  printerFound: boolean;
  printerOnline: boolean;
  sumatraOk: boolean;
  serverUrl: string;
  serverReachable: boolean;
}

/** Reúne todas las sondas sin imprimir (para /status y /selftest). */
export async function diagnostico(): Promise<SelfTestReport> {
  const cfg = loadConfig();
  const [imp, serverReachable] = await Promise.all([verificarImpresora(), verificarServidor()]);
  return {
    printerName: cfg.printerName,
    printerInterface: cfg.printerInterface,
    modoTicket: cfg.modoTicket,
    printerFound: imp.found,
    printerOnline: imp.online,
    sumatraOk: sumatraDisponible(),
    serverUrl: cfg.serverUrl,
    serverReachable,
  };
}

/** Lista los nombres de impresoras instaladas en Windows (para el dropdown de config). */
export function listarImpresoras(): Promise<string[]> {
  if (os.platform() !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name'],
      { timeout: 5000 }, (err, stdout) => {
        if (err) return resolve([]);
        resolve((stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      });
  });
}
