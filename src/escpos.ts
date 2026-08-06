// Helpers ESC/POS PUROS — sin dependencias de Electron, para poder testearlos.

export const ESC_POS_DRAWER_PIN2 = Buffer.from([0x1b, 0x70, 0x00, 0x3c, 0x3c]);
export const ESC_POS_DRAWER_PIN5 = Buffer.from([0x1b, 0x70, 0x01, 0x3c, 0x3c]);
// Pulso de cajón: ambos pines cubren los dos cableados RJ11/RJ12 comunes.
export const DRAWER_KICK = Buffer.concat([ESC_POS_DRAWER_PIN2, ESC_POS_DRAWER_PIN5]);

export interface TicketPruebaInfo {
  printerName: string;
  printerInterface: string;
}

/** Construye un recibo ESC/POS de prueba (init + texto centrado + corte total). */
export function construirTicketPrueba(info: TicketPruebaInfo): Buffer {
  const linea = '--------------------------------\n';
  const txt =
    '\x1b@' +            // ESC @  init
    '\x1ba\x01' +        // ESC a 1  centrar
    'FactuFAST PrintAgent\n' +
    'PRUEBA DE IMPRESION\n' +
    '\x1ba\x00' +        // ESC a 0  izquierda
    linea +
    `Fecha: ${new Date().toLocaleString('es-EC')}\n` +
    `Impresora: ${info.printerName || '(sin nombre)'}\n` +
    `Interfaz: ${info.printerInterface}\n` +
    linea +
    'Si ve este texto, la impresora\n' +
    'esta configurada correctamente.\n' +
    '\n\n\n' +
    '\x1dV\x00';         // GS V 0  corte total
  return Buffer.from(txt, 'latin1');
}

/** Escapa una cadena para incrustarla entre comillas simples de PowerShell. */
function psQuote(valor: string): string {
  return valor.replace(/'/g, "''");
}

/**
 * Script PowerShell que envía un archivo de bytes RAW al spooler de Windows (Win32
 * winspool), sin módulos nativos ni que la impresora esté compartida.
 *
 * ⚠️ LOS BYTES VAN POR ARCHIVO, NUNCA INCRUSTADOS EN EL SCRIPT. Al incrustarlos como
 * hex (`0x1b,0x40,...`, ~5 caracteres por byte) un ticket fiscal rasterizado de 120 KB
 * generaba ~600.000 caracteres de línea de comandos contra el techo de 32.767 de
 * CreateProcess: solo cabían payloads de pocos KB, así que el pulso del cajón y el
 * recibo de prueba funcionaban mientras TODA factura real fallaba. Ese era el motivo
 * de que los tickets largos terminaran imprimiéndose por PDF y salieran cortados.
 *
 * ⚠️ DOC_INFO_1 NECESITA [StructLayout(CharSet=Auto)]: sin él las cadenas del struct
 * se marshalean ANSI mientras StartDocPrinterW espera Unicode → el datatype llega
 * corrupto, el documento nunca inicia de verdad y WritePrinter escribe 0 bytes SIN
 * reportar error. El síntoma era "Recibo de prueba enviado OK" sin papel (y cajón que
 * nunca se abría). Por lo mismo se verifican los resultados de cada paso
 * (StartDocPrinter → jobId≠0, WritePrinter → bytes escritos == total) en vez de
 * silenciarlos con |Out-Null.
 */
export function buildWinspoolScript(dataFilePath: string, printerName: string): string {
  return `
$bytes = [System.IO.File]::ReadAllBytes('${psQuote(dataFilePath)}')
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)]
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
if(-not [WinSpool]::OpenPrinter('${psQuote(printerName)}', [ref]$h, [IntPtr]::Zero)){
  Write-Error 'OpenPrinter falló (impresora no encontrada o sin acceso)'; exit 1
}
$di=New-Object DOC_INFO_1;$di.pDocName='FactuFAST RAW';$di.pDataType='RAW';$di.pOutputFile=$null
$job=[WinSpool]::StartDocPrinter($h,1,[ref]$di)
if($job -eq 0){ [WinSpool]::ClosePrinter($h)|Out-Null; Write-Error 'StartDocPrinter falló (documento RAW rechazado)'; exit 1 }
[WinSpool]::StartPagePrinter($h)|Out-Null
$buf=[System.Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[System.Runtime.InteropServices.Marshal]::Copy($bytes,0,$buf,$bytes.Length)
$written=0
$okw=[WinSpool]::WritePrinter($h,$buf,$bytes.Length,[ref]$written)
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
[WinSpool]::EndPagePrinter($h)|Out-Null;[WinSpool]::EndDocPrinter($h)|Out-Null;[WinSpool]::ClosePrinter($h)|Out-Null
if(-not $okw -or $written -ne $bytes.Length){
  Write-Error "WritePrinter incompleto: $written de $($bytes.Length) bytes"; exit 1
}
Write-Output 'OK'
`.trim();
}

/** Normaliza el header X-Cupon-Ids ("id1,id2") → ['id1','id2']. */
export function parseCuponIds(header?: string | string[]): string[] {
  if (!header) return [];
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
