// Validación de lo que la ventana de configuración manda al proceso principal — puro (v1.7.0).
//
// Antes la ventana corría con `nodeIntegration: true` y `save-config` escribía en
// config.json lo que llegara. Ahora la ventana está aislada y lo que llega se valida
// campo a campo: lo desconocido se descarta (p. ej. `origenesPermitidos` o
// `permitirOrigenLocal` solo se pueden poner editando el archivo a mano).

import { normalizarOrigen } from './origenes';
import type { AgentConfig } from './config';

const INTERFACES = ['usb', 'serial', 'network'] as const;

function texto(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length <= max ? t : undefined;
}

/** Config entrante → solo los campos válidos. null si no es un objeto. */
export function validarConfigEntrante(raw: unknown): Partial<AgentConfig> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: Partial<AgentConfig> = {};

  const printerName = texto(r.printerName, 200);
  if (printerName !== undefined) out.printerName = printerName;

  if (typeof r.printerInterface === 'string' && (INTERFACES as readonly string[]).includes(r.printerInterface)) {
    out.printerInterface = r.printerInterface as AgentConfig['printerInterface'];
  }

  if (r.modoTicket === 'auto' || r.modoTicket === 'pdf') out.modoTicket = r.modoTicket;

  const serialPort = texto(r.serialPort, 30);
  if (serialPort !== undefined) out.serialPort = serialPort;

  const networkHost = texto(r.networkHost, 255);
  if (networkHost !== undefined) out.networkHost = networkHost;

  const puerto = typeof r.networkPort === 'number' ? r.networkPort : Number(r.networkPort);
  if (Number.isInteger(puerto) && puerto >= 1 && puerto <= 65535) out.networkPort = puerto;

  if (typeof r.serverUrl === 'string') {
    const origen = normalizarOrigen(r.serverUrl);
    if (origen) out.serverUrl = origen;
  }

  if (typeof r.notificaciones === 'boolean') out.notificaciones = r.notificaciones;

  return out;
}

/** La petición IPC viene de la ventana de configuración del propio agente. */
export function esVentanaConfig(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'file:' && u.pathname.toLowerCase().endsWith('/assets/config.html');
  } catch {
    return false;
  }
}
