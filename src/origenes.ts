// Orígenes desde los que el POS puede pedirle al agente que imprima — motor puro.
//
// v1.6.0 (mudanza de la plataforma, 31-oct-2026): el sistema pasa de
// www.serviplast.pro a app.reslez.com y durante semanas los DOS dominios sirven la
// misma app. Hasta la 1.5.0 el agente:
//   - aceptaba SOLO el origen exacto de su `serverUrl` (CORS), así que una caja que
//     entraba por el dominio nuevo con el agente apuntando al viejo no podía imprimir
//     y caía al diálogo del navegador en cada venta;
//   - descargaba los PDF siempre de `serverUrl`, que deja de responder cuando el
//     dominio viejo vuelve a su dueño.
// Ahora acepta los dominios de la plataforma además del configurado, y descarga del
// MISMO origen que pidió la impresión: así el agente sigue a la caja, no al revés, y
// nadie tiene que tocar la configuración de cada PC el día del cambio.
//
// ⚠️ La lista es CERRADA a propósito: el agente abre el cajón y recibe el token de la
// sesión del cajero. Aceptar cualquier origen https dejaría que una página ajena
// abierta en esa PC abriera el cajón o hiciera que el agente le enviara el token.

/** Dominios de la plataforma (además del `serverUrl` de cada caja). */
export const ORIGENES_PLATAFORMA: readonly string[] = [
  'https://app.reslez.com',
  'https://beta.reslez.com',
  'https://www.serviplast.pro',
  'https://serviplast.pro',
];

/** `https://Host:443/ruta/` → `https://host`. Cadena vacía si no es una URL válida. */
export function normalizarOrigen(url: string | null | undefined): string {
  if (!url) return '';
  try {
    const u = new URL(url.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    return u.origin.toLowerCase();
  } catch {
    return '';
  }
}

/** ¿Es una página servida desde esta misma PC (desarrollo, app local)? */
export function esOrigenLocal(origin: string): boolean {
  try {
    const u = new URL(origin);
    // Igualdad EXACTA del host: con `startsWith('http://localhost')` también pasaba
    // `http://localhost.cualquiercosa.com`.
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * ¿Se responde con CORS a este origen?
 * Sin `Origin` (curl, la propia app, procesos locales) no hay navegador que proteger.
 */
export function origenPermitido(
  origin: string | null | undefined,
  serverUrl: string | null | undefined,
  extra: readonly string[] = [],
): boolean {
  if (!origin) return true;
  const o = normalizarOrigen(origin);
  if (!o) return false;
  if (esOrigenLocal(o)) return true;
  const configurado = normalizarOrigen(serverUrl);
  if (configurado && o === configurado) return true;
  if (ORIGENES_PLATAFORMA.includes(o)) return true;
  return extra.map(normalizarOrigen).filter(Boolean).includes(o);
}

/**
 * Servidor del que se descargan los PDF de ESTA impresión: el origen que la pidió si
 * está permitido; si no (petición sin `Origin`), el `serverUrl` configurado.
 * Siempre sin barra final, para que `${base}${ruta}` no produzca `//`.
 */
export function baseDescarga(
  origin: string | null | undefined,
  serverUrl: string | null | undefined,
  extra: readonly string[] = [],
): string {
  const o = normalizarOrigen(origin);
  if (o && origenPermitido(o, serverUrl, extra)) return o;
  return normalizarOrigen(serverUrl) || (serverUrl ?? '').trim().replace(/\/+$/, '');
}
