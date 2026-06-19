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

/** Normaliza el header X-Cupon-Ids ("id1,id2") → ['id1','id2']. */
export function parseCuponIds(header?: string | string[]): string[] {
  if (!header) return [];
  const raw = Array.isArray(header) ? header.join(',') : header;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
