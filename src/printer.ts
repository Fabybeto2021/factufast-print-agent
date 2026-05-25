import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import { execFile } from 'child_process';
import { loadConfig } from './config';
import { log } from './logger';

// Comando ESC/POS estándar para abrir cajón (pin 2)
const ESC_POS_OPEN_DRAWER = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

function getSumatraPath(): string {
  const resourcesPath = process.resourcesPath ?? path.join(__dirname, '..', 'vendor');
  return path.join(resourcesPath, 'SumatraPDF.exe');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Abre el cajón registrador enviando el comando ESC/POS.
 * Intenta node-thermal-printer primero; si falla, usa el spooler de Windows.
 */
export async function abrirCajon(): Promise<void> {
  const cfg = loadConfig();
  log('INFO', `Abriendo cajón — interfaz: ${cfg.printerInterface}, impresora: "${cfg.printerName}"`);

  // Determinar interfaz correcta según tipo de conexión
  let iface: string;
  if (cfg.printerInterface === 'serial') {
    iface = `//./${cfg.serialPort.replace(/^COM/i, 'COM')}`;
  } else if (cfg.printerInterface === 'network') {
    iface = `tcp://${cfg.networkHost}:${cfg.networkPort}`;
  } else {
    // USB en Windows: la impresora se identifica por su nombre en el spooler
    iface = `printer:${cfg.printerName}`;
  }

  try {
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
    printer.raw(ESC_POS_OPEN_DRAWER);
    await printer.execute();
    await printer.clear();
    log('INFO', 'Cajón abierto OK (node-thermal-printer)');
    return;
  } catch (err) {
    log('WARN', `node-thermal-printer falló (${(err as Error).message}), intentando fallback Windows`);
  }

  // Fallback: copiar bytes ESC/POS directamente al spooler de Windows
  if (os.platform() === 'win32' && cfg.printerName) {
    try {
      await imprimirRawWindows(ESC_POS_OPEN_DRAWER, cfg.printerName);
      log('INFO', 'Cajón abierto OK (fallback Windows spooler)');
    } catch (err) {
      const msg = `Fallback spooler falló: ${(err as Error).message}`;
      log('ERROR', msg);
      throw new Error(msg);
    }
  } else {
    const msg = 'No se pudo abrir el cajón: impresora no configurada o SO no soportado';
    log('ERROR', msg);
    throw new Error(msg);
  }
}

/**
 * Envía bytes raw al spooler de Windows usando COPY /B.
 */
function imprimirRawWindows(data: Buffer, printerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `cajon_${Date.now()}.bin`);
    fs.writeFileSync(tmpFile, data);
    const args = ['/c', `copy /b "${tmpFile}" "\\\\localhost\\${printerName}"`];
    execFile('cmd.exe', args, (err) => {
      try { fs.unlinkSync(tmpFile); } catch { /* noop */ }
      if (err) reject(err); else resolve();
    });
  });
}

/**
 * Descarga el PDF del ticket desde el servidor FactuFAST e imprime con SumatraPDF.
 * Reintenta la descarga hasta 3 veces ante errores de red.
 */
export async function imprimirTicket(comprobanteId: string, authToken?: string): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.printerName) throw new Error('Nombre de impresora no configurado');

  const sumatraExe = getSumatraPath();
  if (!fs.existsSync(sumatraExe)) {
    throw new Error('SumatraPDF.exe no encontrado en: ' + sumatraExe);
  }

  const pdfUrl = `${cfg.serverUrl}/api/comprobantes/${comprobanteId}/pdf/ticket`;
  const tmpPdf = path.join(os.tmpdir(), `ticket_${comprobanteId}_${Date.now()}.pdf`);

  log('INFO', `Descargando ticket ${comprobanteId} desde ${pdfUrl}`);

  // Retry hasta 3 intentos con 1.5s entre cada uno
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await descargarArchivo(pdfUrl, tmpPdf, authToken);
      lastError = null;
      break;
    } catch (err) {
      lastError = err as Error;
      log('WARN', `Descarga intento ${attempt}/3 falló: ${lastError.message}`);
      if (attempt < 3) await delay(1500);
    }
  }
  if (lastError) {
    throw new Error(`Descarga del ticket falló tras 3 intentos: ${lastError.message}`);
  }

  log('INFO', `PDF descargado, enviando a impresora "${cfg.printerName}"`);

  await new Promise<void>((resolve, reject) => {
    execFile(
      sumatraExe,
      ['-print-to', cfg.printerName, '-silent', tmpPdf],
      { timeout: 15_000 },
      (err) => {
        try { fs.unlinkSync(tmpPdf); } catch { /* noop */ }
        if (err) {
          log('ERROR', `SumatraPDF falló: ${err.message}`);
          reject(err);
        } else {
          log('INFO', `Ticket ${comprobanteId} impreso OK`);
          resolve();
        }
      },
    );
  });
}

function descargarArchivo(url: string, destPath: string, authToken?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const options: https.RequestOptions = { headers: {} };
    if (authToken) {
      (options.headers as Record<string, string>)['Authorization'] = `Bearer ${authToken}`;
    }

    const file = fs.createWriteStream(destPath);
    proto.get(url, options, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(destPath); } catch { /* noop */ }
        reject(new Error(`HTTP ${res.statusCode} al descargar ticket`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => {
        file.close();
        try { fs.unlinkSync(destPath); } catch { /* noop */ }
        reject(err);
      });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch { /* noop */ }
      reject(err);
    });
  });
}
