// De dónde descarga el agente un PDF y cuándo puede mandar el token — motor puro (v1.7.0).
//
// La orden de impresión trae el token de la sesión del cajero y, a veces, la ruta del
// PDF (`ticketPdfPath`, recibos de cobros y Ventas Directas). Hasta la 1.6.0 la URL se
// armaba como `${servidor}${ruta}` sin mirar la ruta: con `@evil.com/x` la URL quedaba
// `https://app.reslez.com@evil.com/x` — o sea, el host evil.com — y el agente le mandaba
// ahí el token en `Authorization`. Aquí la URL final tiene que ser del MISMO origen que
// el servidor y apuntar a la API.

import { normalizarOrigen } from './origenes';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function esUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v);
}

/**
 * URL absoluta y segura para descargar `ruta` desde `base`, o error.
 * - `ruta` empieza por `/api/`, sin `//`, `\`, `@`, espacios ni caracteres de control;
 * - el resultado conserva el origen de `base` (protocolo, host y puerto).
 */
export function rutaDescargaSegura(base: string, ruta: string): string {
  const origen = normalizarOrigen(base);
  if (!origen) throw new Error('servidor de descarga inválido');
  if (typeof ruta !== 'string' || ruta.length === 0 || ruta.length > 500) {
    throw new Error('ruta de descarga inválida');
  }
  // eslint-disable-next-line no-control-regex
  if (!ruta.startsWith('/api/') || /[\\@\s\x00-\x1f\x7f]/.test(ruta) || ruta.includes('//')) {
    throw new Error('ruta de descarga no permitida');
  }
  let url: URL;
  try {
    url = new URL(ruta, `${origen}/`);
  } catch {
    throw new Error('ruta de descarga inválida');
  }
  if (url.origin.toLowerCase() !== origen) throw new Error('ruta de descarga de otro servidor');
  if (!url.pathname.startsWith('/api/')) throw new Error('ruta de descarga no permitida');
  return url.toString();
}

/**
 * ¿Se puede mandar el token de la sesión a este servidor?
 * Solo por https, o por http a esta misma PC (desarrollo). Un servidor por http en la
 * red local lo vería cualquiera que escuche esa red.
 */
export function tokenPermitido(base: string): boolean {
  const origen = normalizarOrigen(base);
  if (!origen) return false;
  const u = new URL(origen);
  if (u.protocol === 'https:') return true;
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
}
