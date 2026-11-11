// Guardia del servidor local — motor puro (v1.7.0).
//
// Hasta la 1.6.0 el agente solo PONÍA cabeceras CORS y siempre atendía la petición.
// CORS no protege nada: decide si el NAVEGADOR deja leer la respuesta, no si el
// servidor la ejecuta. Un `POST /selftest` sin cuerpo es una petición «simple» (sin
// preflight), así que cualquier página abierta en la PC de caja —un anuncio, un
// correo, un enlace— podía imprimir y ABRIR EL CAJÓN, aunque no viera la respuesta.
//
// Aquí se decide ANTES de leer el cuerpo y para todos los métodos:
//   1. Host   → solo 127.0.0.1:7979 / localhost:7979. Cierra el «DNS rebinding»: una
//      página de evil.com que hace resolver su dominio a 127.0.0.1 llega con
//      `Host: evil.com:7979`.
//   2. Origin → si viene, tiene que estar en la lista cerrada. Un formulario o un fetch
//      desde otra página siempre lo manda (en POST), así que aquí se cortan.
//   3. POST   → solo `application/json`. Un formulario HTML no puede mandar JSON, y un
//      fetch con JSON obliga al navegador a preguntar antes (preflight) — que tampoco pasa.
//   4. Sin Origin pero `Sec-Fetch-Site: cross-site` → otra página (imagen, enlace).
//      curl y los procesos locales no mandan esa cabecera y siguen funcionando.
//
// Sin dependencias de Electron ni de Express: se prueba con `node --test`.

import { origenPermitido } from './origenes';

export interface PeticionAgente {
  metodo: string;
  host?: string;
  origin?: string;
  contentType?: string;
  secFetchSite?: string;
}

export interface OpcionesGuardia {
  puerto: number;
  serverUrl?: string;
  extra?: readonly string[];
  /** Cualquier `http://localhost:*` (desarrollo). Apagado por defecto. */
  permitirOrigenLocal?: boolean;
}

export type Veredicto =
  | { ok: true; origenPermitido: boolean }
  // `origenPermitido` también en el rechazo: un 415 a la página legítima del POS tiene que
  // llevar sus cabeceras CORS, o el navegador lo esconde y el cajero lee «no se pudo
  // contactar al agente» en vez de un rechazo.
  | { ok: false; status: 403 | 415; motivo: string; origenPermitido: boolean };

/** `127.0.0.1:7979` / `localhost:7979`, sin importar mayúsculas. */
export function hostValido(host: string | undefined, puerto: number): boolean {
  if (!host) return false;
  const h = host.trim().toLowerCase();
  return h === `127.0.0.1:${puerto}` || h === `localhost:${puerto}`;
}

/** El tipo de contenido es JSON (con o sin `; charset=…`). */
export function esJson(contentType: string | undefined): boolean {
  if (!contentType) return false;
  return contentType.split(';')[0].trim().toLowerCase() === 'application/json';
}

export function evaluarPeticion(p: PeticionAgente, o: OpcionesGuardia): Veredicto {
  if (!hostValido(p.host, o.puerto)) {
    return { ok: false, status: 403, motivo: `host no permitido: ${p.host ?? '(vacío)'}`, origenPermitido: false };
  }

  const origin = (p.origin ?? '').trim();
  const permitido = origin
    ? origenPermitido(origin, o.serverUrl, o.extra ?? [], { permitirLocal: o.permitirOrigenLocal === true })
    : false;

  if (origin && !permitido) {
    return { ok: false, status: 403, motivo: `origen no permitido: ${origin}`, origenPermitido: false };
  }

  if (!origin) {
    const sitio = (p.secFetchSite ?? '').trim().toLowerCase();
    if (sitio === 'cross-site' || sitio === 'same-site') {
      return { ok: false, status: 403, motivo: 'petición de otra página sin Origin', origenPermitido: false };
    }
  }

  if (p.metodo.toUpperCase() === 'POST' && !esJson(p.contentType)) {
    return { ok: false, status: 415, motivo: 'POST sin application/json', origenPermitido: permitido };
  }

  return { ok: true, origenPermitido: permitido };
}

/**
 * Freno del registro de rechazos: como mucho UNA línea por motivo cada `ventanaMs`, con
 * cuántos se omitieron. Sin esto, una página que repite en bucle una imagen hacia
 * 127.0.0.1:7979 escribe una línea por petición y rota agent.log en menos de un minuto —
 * justo el historial con el que se diagnostican los tickets.
 * Devuelve la línea a escribir, o null si toca callar.
 */
export function crearFrenoRegistro(ventanaMs = 60_000, maxMotivos = 50) {
  const vistos = new Map<string, { desde: number; omitidos: number }>();
  return (motivo: string, ahora = Date.now()): string | null => {
    // Muchos motivos distintos (un Origin o un Host que cambia en cada petición) se
    // cuentan juntos, para que la memoria del freno no crezca sin límite.
    const clave = !vistos.has(motivo) && vistos.size >= maxMotivos ? '(otros motivos)' : motivo;
    const previo = vistos.get(clave);
    if (previo && ahora - previo.desde < ventanaMs) {
      previo.omitidos++;
      return null;
    }
    vistos.set(clave, { desde: ahora, omitidos: 0 });
    return previo && previo.omitidos > 0 ? `${motivo} (+${previo.omitidos} omitidos)` : motivo;
  };
}
