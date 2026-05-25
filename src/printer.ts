import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as os from 'os';
import { execFile } from 'child_process';
import { loadConfig } from './config';
import { log } from './logger';

// Comandos ESC/POS para abrir cajón — pin 2 y pin 5 (depende del modelo de cajón)
const ESC_POS_DRAWER_PIN2 = Buffer.from([0x1b, 0x70, 0x00, 0x3c, 0x3c]);
const ESC_POS_DRAWER_PIN5 = Buffer.from([0x1b, 0x70, 0x01, 0x3c, 0x3c]);

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

  if (!cfg.printerName) {
    const msg = 'Nombre de impresora no configurado';
    log('ERROR', msg);
    throw new Error(msg);
  }

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

  // Intentar con node-thermal-printer enviando pin 2 y pin 5 (cubre ambos modelos de cajón)
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
    // Enviar pin 2 y pin 5 — cubre ambos modelos de cajón sin configuración adicional
    printer.raw(ESC_POS_DRAWER_PIN2);
    printer.raw(ESC_POS_DRAWER_PIN5);
    await printer.execute();
    await printer.clear();
    log('INFO', 'Cajón: comando enviado OK (node-thermal-printer, pin2+pin5)');
    return;
  } catch (err) {
    log('WARN', `node-thermal-printer falló (${(err as Error).message}), intentando fallback Windows`);
  }

  // Fallback: enviar bytes ESC/POS directamente al spooler de Windows (pin 2 + pin 5)
  if (os.platform() === 'win32') {
    try {
      const combined = Buffer.concat([ESC_POS_DRAWER_PIN2, ESC_POS_DRAWER_PIN5]);
      await imprimirRawWindows(combined, cfg.printerName);
      log('INFO', 'Cajón: comando enviado OK (fallback Windows spooler, pin2+pin5)');
    } catch (err) {
      const msg = `Fallback spooler falló: ${(err as Error).message}`;
      log('ERROR', msg);
      throw new Error(msg);
    }
  } else {
    const msg = 'No se pudo abrir el cajón: SO no soportado';
    log('ERROR', msg);
    throw new Error(msg);
  }
}

/**
 * Envía bytes raw al spooler de Windows usando la Win32 API vía PowerShell.
 * No requiere que la impresora esté compartida en red.
 */
function imprimirRawWindows(data: Buffer, printerName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const hex = Array.from(data).map(b => `0x${b.toString(16).padStart(2, '0')}`).join(',');
    // Usa System.Drawing.Printing con RAW datatype para llegar al hardware sin pasar por GDI
    const ps = `
$bytes = [byte[]]@(${hex})
$pj = New-Object System.Drawing.Printing.PrintDocument
$pj.PrinterSettings.PrinterName = '${printerName.replace(/'/g, "''")}'
Add-Type -AssemblyName System.Drawing
$stream = New-Object System.IO.MemoryStream(,$bytes)
$raw = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes,0,$raw,$bytes.Length)
$hPrinter = [IntPtr]::Zero
$di = New-Object PSObject -Property @{pDocName='CajonESCPOS';pDataType='RAW';pOutputFile=$null;fType=0}
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
if([WinSpool]::OpenPrinter('${printerName.replace(/'/g, "''")}', [ref]$h, [IntPtr]::Zero)){
  $di2=New-Object DOC_INFO_1;$di2.pDocName='CajonCmd';$di2.pDataType='RAW';$di2.pOutputFile=$null
  [WinSpool]::StartDocPrinter($h,1,[ref]$di2)|Out-Null
  [WinSpool]::StartPagePrinter($h)|Out-Null
  $buf=[System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
  [System.Runtime.InteropServices.Marshal]::Copy($bytes,0,$buf,$bytes.Length)
  $written=0;[WinSpool]::WritePrinter($h,$buf,$bytes.Length,[ref]$written)|Out-Null
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
  [WinSpool]::EndPagePrinter($h)|Out-Null;[WinSpool]::EndDocPrinter($h)|Out-Null;[WinSpool]::ClosePrinter($h)|Out-Null
  exit 0
} else { exit 1 }
`.trim();

    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { timeout: 8000 },
      (err, _stdout, stderr) => {
        if (err || stderr?.trim()) {
          reject(new Error(stderr?.trim() || err?.message || 'PowerShell falló'));
        } else {
          resolve();
        }
      }
    );
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
