import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import { execFile } from 'child_process';
import { app } from 'electron';
import { loadConfig } from './config';

// Comando ESC/POS estándar para abrir cajón (pin 2)
const ESC_POS_OPEN_DRAWER = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

function getSumatraPath(): string {
  // En producción el .exe está en resources/, en dev está en vendor/
  const resourcesPath = process.resourcesPath ?? path.join(__dirname, '..', 'vendor');
  return path.join(resourcesPath, 'SumatraPDF.exe');
}

/**
 * Abre el cajón registrador enviando el comando ESC/POS por el canal USB/COM.
 * No imprime papel.
 */
export async function abrirCajon(): Promise<void> {
  const cfg = loadConfig();

  // Intentar con node-thermal-printer
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ThermalPrinter, PrinterTypes, CharacterSet, BreakLine } = require('node-thermal-printer');
    const printer = new ThermalPrinter({
      type: PrinterTypes.EPSON,
      interface: cfg.printerInterface === 'serial'
        ? `//./COM${cfg.serialPort.replace('COM', '')}`
        : cfg.printerInterface === 'network'
          ? `tcp://${cfg.networkHost}:${cfg.networkPort}`
          : `//./lpt1`, // USB — node-thermal-printer usa nombre de impresora en Windows
      characterSet: CharacterSet.PC437_USA,
      breakLine: BreakLine.WORD,
      options: { timeout: 3000 },
    });

    await printer.isPrinterConnected();
    printer.raw(ESC_POS_OPEN_DRAWER);
    await printer.execute();
    await printer.clear();
    return;
  } catch {
    // Fallback: imprimir un documento en blanco con SumatraPDF que fuerza el pulso del cajón
    // Algunos modelos abren el cajón al recibir cualquier trabajo de impresión
    if (os.platform() === 'win32' && cfg.printerName) {
      try {
        await imprimirRawWindows(ESC_POS_OPEN_DRAWER, cfg.printerName);
      } catch {
        // silencioso — no hay cajón o no hay impresora
      }
    }
  }
}

/**
 * Envía bytes raw directamente a la impresora en Windows usando una pipe al spooler.
 */
function imprimirRawWindows(data: Buffer, printerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmpFile = path.join(os.tmpdir(), `cajón_${Date.now()}.bin`);
    fs.writeFileSync(tmpFile, data);
    // Usar COPY /B para enviar bytes al spooler de Windows
    const cmd = `cmd.exe`;
    const args = ['/c', `copy /b "${tmpFile}" "\\\\localhost\\${printerName}"`];
    execFile(cmd, args, (err) => {
      try { fs.unlinkSync(tmpFile); } catch { /* noop */ }
      if (err) reject(err); else resolve();
    });
  });
}

/**
 * Descarga el PDF del ticket desde el servidor FactuFAST e imprime silenciosamente
 * con SumatraPDF (sin diálogo del sistema).
 */
export async function imprimirTicket(comprobanteId: string): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.printerName) throw new Error('Nombre de impresora no configurado');

  const sumatraExe = getSumatraPath();
  if (!fs.existsSync(sumatraExe)) {
    throw new Error('SumatraPDF.exe no encontrado en: ' + sumatraExe);
  }

  const pdfUrl = `${cfg.serverUrl}/api/comprobantes/${comprobanteId}/pdf/ticket`;
  const tmpPdf = path.join(os.tmpdir(), `ticket_${comprobanteId}_${Date.now()}.pdf`);

  await descargarArchivo(pdfUrl, tmpPdf);

  await new Promise<void>((resolve, reject) => {
    execFile(
      sumatraExe,
      ['-print-to', cfg.printerName, '-silent', tmpPdf],
      { timeout: 15_000 },
      (err) => {
        try { fs.unlinkSync(tmpPdf); } catch { /* noop */ }
        if (err) reject(err); else resolve();
      },
    );
  });
}

function descargarArchivo(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        reject(new Error(`HTTP ${res.statusCode} al descargar ticket`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      file.close();
      try { fs.unlinkSync(destPath); } catch { /* noop */ }
      reject(err);
    });
  });
}
