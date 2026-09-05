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

// ──────────────────────────────────────────────────────────────────────────
// Patrón de ráster para el diagnóstico
// ──────────────────────────────────────────────────────────────────────────

/**
 * Filas de puntos por comando `GS v 0`. ESPEJO de `BAND_HEIGHT` en el servidor
 * (`src/lib/sri/png-a-escpos.ts` de FactuFAST): la prueba solo sirve si le manda a la
 * impresora comandos de la MISMA forma y tamaño que un ticket real.
 */
const BAND_HEIGHT = 24;

/** Puntos de una línea del cabezal de 80mm (72mm @203dpi). */
export const RASTER_ANCHO = 576;

export interface RasterPruebaOpts {
  /** Alto en puntos. 203 puntos = 1 pulgada = 25.4 mm de papel. */
  filas: number;
  /** Rotular el bloque (sale como texto ESC/POS antes y después del ráster). */
  titulo: string;
}

function setBit(bits: Uint8Array, widthBytes: number, y: number, x: number): void {
  bits[y * widthBytes + (x >> 3)] |= 0x80 >> (x & 7);
}

/**
 * Dibuja un patrón reconocible a simple vista y lo emite como ráster ESC/POS.
 *
 * El patrón está elegido para que un humano diagnostique de un vistazo:
 *  - **reglas horizontales de ancho completo** cada 40 filas → son la peor carga para el
 *    cabezal y, si la impresora envuelve las filas, se parten;
 *  - una **escalera diagonal** → cualquier desplazamiento horizontal (ancho de línea mal
 *    interpretado) la convierte en una diagonal rota en vez de una escalera limpia;
 *  - **huecos en blanco** entre bloques → ejercitan el avance `ESC J`, que es lo que el
 *    servidor emite en lugar de rasterizar papel blanco.
 *
 * El flujo va rotulado con texto ESC/POS ANTES y DESPUÉS. Esa es la parte que más informa:
 * si el rótulo final sale impreso pero el ráster del medio salió como caracteres, la
 * impresora perdió la sincronía dentro de un `GS v 0` — exactamente el fallo reportado.
 */
export function construirRasterPrueba(opts: RasterPruebaOpts): Buffer {
  const { filas, titulo } = opts;
  const widthBytes = Math.ceil(RASTER_ANCHO / 8);
  const bits = new Uint8Array(filas * widthBytes);
  const vacia = new Uint8Array(filas);

  for (let y = 0; y < filas; y++) {
    const ciclo = y % 40;
    if (ciclo < 3) {
      // Regla de ancho completo.
      for (let x = 0; x < RASTER_ANCHO; x++) setBit(bits, widthBytes, y, x);
    } else if (ciclo >= 8 && ciclo < 28) {
      // Escalera: un bloque de 64 puntos que se desplaza en cada peldaño.
      const desde = (Math.floor(y / 40) * 24) % (RASTER_ANCHO - 64);
      for (let x = desde; x < desde + 64; x++) setBit(bits, widthBytes, y, x);
    } else {
      vacia[y] = 1;
    }
  }

  const out: number[] = [];
  const ESC = 0x1b;
  const GS = 0x1d;
  // Nada de secuencias de escape dentro de cadenas: los bytes de control se empujan
  // explícitos para que el fuente siga siendo texto plano legible y diffeable.
  const centrar = () => out.push(ESC, 0x61, 0x01);
  const izquierda = () => out.push(ESC, 0x61, 0x00);
  const salto = (n = 1) => { for (let i = 0; i < n; i++) out.push(0x0a); };
  const texto = (t: string) => { for (const byte of Buffer.from(t, 'latin1')) out.push(byte); };

  out.push(ESC, 0x40);                                     // ESC @ init
  out.push(GS, 0x50, 203, 203);                            // GS P — 1 unidad de avance = 1 punto
  centrar();
  texto(titulo);
  salto();
  izquierda();
  texto('Alto: ' + filas + ' pts (' + ((filas / 203) * 25.4).toFixed(0) + ' mm)');
  salto(2);

  let y = 0;
  while (y < filas) {
    if (vacia[y]) {
      let fin = y;
      while (fin < filas && vacia[fin]) fin++;
      let resto = fin - y;
      while (resto > 0) { const n = Math.min(255, resto); out.push(ESC, 0x4a, n); resto -= n; }
      y = fin;
      continue;
    }
    const tope = Math.min(y + BAND_HEIGHT, filas);
    let fin = y + 1;
    while (fin < tope && !vacia[fin]) fin++;
    const rows = fin - y;
    out.push(GS, 0x76, 0x30, 0x00, widthBytes & 0xff, (widthBytes >> 8) & 0xff, rows & 0xff, (rows >> 8) & 0xff);
    for (let i = y * widthBytes; i < fin * widthBytes; i++) out.push(bits[i]);
    y = fin;
  }

  // Si esta línea sale legible, la impresora llegó al final del flujo sin desincronizarse.
  centrar();
  salto();
  texto('FIN OK - el raster llego completo');
  salto();
  izquierda();
  salto(2);
  out.push(GS, 0x56, 0x00);                                // GS V 0 — corte total
  return Buffer.from(out);
}

/** Normaliza el header X-Cupon-Ids ("id1,id2") → ['id1','id2']. */
export function parseCuponIds(header?: string | string[]): string[] {
  if (!header) return [];
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
