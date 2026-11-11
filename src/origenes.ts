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
];

/**
 * Dominios retirados → el actual. Desde el 1-nov-2026 `serviplast.pro` es la web propia
 * de un cliente (SPPLAST), no la plataforma. Un agente con ese `serverUrl` descargaría
 * —en las peticiones sin `Origin`— de un sitio ajeno, y `https.get` no sigue
 * redirecciones. `loadConfig` lo lee como el dominio actual.
 * ⚠️ v1.7.0: además NUNCA se aceptan como origen, ni aunque estén escritos en
 * `serverUrl` u `origenesPermitidos`: sus páginas no pueden abrir el cajón de la caja ni
 * recibir el token de la sesión.
 */
export const SERVIDOR_ACTUAL = 'https://app.reslez.com';
export const SERVIDORES_RETIRADOS: readonly string[] = ['https://www.serviplast.pro', 'https://serviplast.pro'];

export function migrarServerUrl(url: string): string {
  return SERVIDORES_RETIRADOS.includes(normalizarOrigen(url)) ? SERVIDOR_ACTUAL : url;
}

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

export interface OpcionesOrigen {
  /**
   * Aceptar CUALQUIER `http://localhost:*` / `http://127.0.0.1:*` (desarrollo).
   * Apagado por defecto desde la v1.7.0: cualquier programa de la PC puede abrir un
   * puerto local y servir una página desde ahí. Por lo mismo, un `serverUrl` local (el
   * `http://localhost:3000` de una PC de desarrollo) tampoco se acepta sin esta opción:
   * hasta la 1.6.0 era el valor por defecto, así que un agente nunca configurado le abría
   * el cajón a cualquier página servida en el puerto 3000.
   */
  permitirLocal?: boolean;
}

/**
 * ¿Se atiende a este origen?
 * Sin `Origin` (curl, la propia app, procesos locales) no hay navegador que proteger:
 * eso lo filtra la guardia con `Sec-Fetch-Site`, no esta función.
 */
export function origenPermitido(
  origin: string | null | undefined,
  serverUrl: string | null | undefined,
  extra: readonly string[] = [],
  opciones: OpcionesOrigen = {},
): boolean {
  if (!origin) return true;
  const o = normalizarOrigen(origin);
  if (!o) return false;
  if (SERVIDORES_RETIRADOS.includes(o)) return false;
  if (opciones.permitirLocal && esOrigenLocal(o)) return true;
  const configurado = normalizarOrigen(serverUrl);
  if (configurado && o === configurado && (opciones.permitirLocal || !esOrigenLocal(configurado))) return true;
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
  opciones: OpcionesOrigen = {},
): string {
  const o = normalizarOrigen(origin);
  if (o && origenPermitido(o, serverUrl, extra, opciones)) return o;
  return normalizarOrigen(migrarServerUrl(serverUrl ?? ''))
    || (serverUrl ?? '').trim().replace(/\/+$/, '');
}
