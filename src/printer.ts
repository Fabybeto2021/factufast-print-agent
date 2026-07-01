import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import * as net from 'net';
import { execFile } from 'child_process';
import { loadConfig, AgentConfig } from './config';
import { DRAWER_KICK, construirTicketPrueba, parseCuponIds } from './escpos';
import { log } from './logger';

const DOWNLOAD_TIMEOUT_MS = 10_000;

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
 * USB (Windows) → spooler winspool (Win32 API, sin nativo). PRIMARIO.
 * Red          → socket TCP directo (módulo net, sin nativo).
 * Serial       → node-thermal-printer (//./COMx). Fallback con nativo.
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
    try {
      await enviarRawWindows(data, cfg.printerName);
      return;
    } catch (err) {
      log('WARN', `winspool falló (${(err as Error).message}), intentando node-thermal-printer`);
      await enviarRawThermalPrinter(data, `printer:${cfg.printerName}`);
      return;
    }
  }
  // SO no-Windows con interfaz USB → node-thermal-printer
  await enviarRawThermalPrinter(data, `printer:${cfg.printerName}`);
}

/**
 * Envía bytes raw al spooler de Windows usando la Win32 API vía PowerShell.
 * No requiere que la impresora esté compartida en red ni módulos nativos.
 */
function enviarRawWindows(data: Buffer, printerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const hex = Array.from(data).map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(',');
    const safeName = printerName.replace(/'/g, "''");
    const ps = `
$bytes = [byte[]]@(${hex})
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
public struct DOC_INFO_1{public string pDocName;public string pOutputFile;public string pDataType;}
public class WinSpool{
  [DllImport("winspool.drv",CharSet=CharSet.Auto)]public static extern bool OpenPrinter(string n,out IntPtr h,IntPtr d);
  [DllImport("winspool.drv")]public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv",CharSet=CharSet.Auto)]public static extern int StartDocPrinter(IntPtr h,int l,ref DOC_INFO_1 di);
  [DllImport("winspool.drv")]public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv")]public static extern bool WritePrinter(IntPtr h,IntPtr b,int n,out int w);
  [DllImport("winspool.drv")]public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv")]public static extern bool EndDocPrinter(IntPtr h);}
'@
$h=[IntPtr]::Zero
if([WinSpool]::OpenPrinter('${safeName}', [ref]$h, [IntPtr]::Zero)){
  $di=New-Object DOC_INFO_1;$di.pDocName='FactuFAST RAW';$di.pDataType='RAW';$di.pOutputFile=$null
  [WinSpool]::StartDocPrinter($h,1,[ref]$di)|Out-Null
  [WinSpool]::StartPagePrinter($h)|Out-Null
  $buf=[System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [System.Runtime.InteropServices.Marshal]::Copy($bytes,0,$buf,$bytes.Length)
  $written=0;[WinSpool]::WritePrinter($h,$buf,$bytes.Length,[ref]$written)|Out-Null
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
  [WinSpool]::EndPagePrinter($h)|Out-Null;[WinSpool]::EndDocPrinter($h)|Out-Null;[WinSpool]::ClosePrinter($h)|Out-Null
  Write-Output 'OK'
} else { Write-Error 'OpenPrinter falló (impresora no encontrada o sin acceso)'; exit 1 }
`.trim();

    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 8000 },
      (err, stdout, stderr) => {
        if (err || !/OK/.test(stdout || '')) {
          reject(new Error(stderr?.trim() || err?.message || 'PowerShell/winspool falló'));
        } else {
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
    const finish = (err?: Error) => {
      if (done) return;
      done = true;
      socket.destroy();
      err ? reject(err) : resolve();
    };
    socket.setTimeout(5000);
    socket.on('timeout', () => finish(new Error(`Timeout conectando a ${host}:${port}`)));
    socket.on('error', (err) => finish(err));
    socket.connect(port, host, () => {
      socket.write(data, (err) => {
        if (err) return finish(err);
        // pequeño margen para que el buffer salga antes de cerrar
        setTimeout(() => finish(), 150);
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
export async function imprimirTicket(comprobanteId: string, authToken?: string, ticketPdfPath?: string): Promise<void> {
  await imprimirPdf(comprobanteId, 'ticket', 'ticket', authToken, undefined, ticketPdfPath);
}

/**
 * Descarga e imprime los boletos de sorteo de ánfora (independiente del ticket fiscal).
 * ACK de dos fases: el servidor NO marca impreso_ok en el GET (header X-Print-Agent);
 * recién tras imprimir físicamente (SumatraPDF exit 0) confirmamos vía POST. Si la
 * impresión falla, el boleto sigue reimprimible (no se pierde).
 * 204 del servidor = nada que imprimir (digital / ya impresos) → no es error.
 */
export async function imprimirCupones(comprobanteId: string, authToken?: string): Promise<void> {
  const { printed, cuponIds } = await imprimirPdf(
    comprobanteId, 'cupones', 'cupones', authToken, { 'X-Print-Agent': '1' },
  );
  if (printed && cuponIds.length > 0) {
    const cfg = loadConfig();
    try {
      await confirmarCupones(cfg.serverUrl, comprobanteId, cuponIds, authToken);
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
): Promise<ImprimirResult> {
  const cfg = loadConfig();
  if (!cfg.printerName) throw new Error('Nombre de impresora no configurado');

  const sumatraExe = getSumatraPath();
  if (!fs.existsSync(sumatraExe)) {
    throw new Error('SumatraPDF.exe no encontrado en: ' + sumatraExe);
  }

  // Documento genérico (cobros/VD) → ruta relativa dada; si no, RIDE del comprobante.
  const pdfUrl = overridePath
    ? `${cfg.serverUrl}${overridePath}`
    : `${cfg.serverUrl}/api/comprobantes/${comprobanteId}/pdf/${pathSuffix}`;
  const idSafe = comprobanteId || 'doc';
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
      ['-print-to', cfg.printerName, '-silent', tmpPdf],
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
  const url = `${serverUrl}/api/comprobantes/${comprobanteId}/pdf/cupones/confirmar`;
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
    const safe = cfg.printerName.replace(/'/g, "''");
    const ps = `$p = Get-CimInstance Win32_Printer -Filter "Name='${safe}'" -ErrorAction SilentlyContinue; ` +
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
