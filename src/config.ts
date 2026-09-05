import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Modo de impresión del ticket fiscal en ESTA caja.
 * - `auto` (default): el POS decide — ESC/POS crudo si la versión del agente lo soporta.
 * - `pdf`: nunca ESC/POS aquí; el POS vuelve a mandar el PDF para que lo imprima SumatraPDF.
 *
 * Es una propiedad del HARDWARE, no del tenant: una térmica que pierde sincronía a mitad
 * de un ráster largo (el síntoma es un tramo de caracteres ilegibles en medio del ticket)
 * necesita volver al PDF en el acto, sin esperar un despliegue ni afectar a las demás
 * cajas. Con `pdf` hay que revisar que el formulario de papel del driver sea CONTINUO, o
 * el ticket largo vuelve a salir recortado — que es justo lo que la v1.4.0 vino a arreglar.
 */
export type ModoTicket = 'auto' | 'pdf';

export interface AgentConfig {
  printerName: string;
  printerInterface: 'usb' | 'serial' | 'network';
  modoTicket: ModoTicket;
  serialPort: string;
  networkHost: string;
  networkPort: number;
  serverUrl: string;
  notificaciones: boolean;
}

export const AGENT_PORT = 7979;

const DEFAULT_CONFIG: AgentConfig = {
  printerName: '',
  printerInterface: 'usb',
  modoTicket: 'auto',
  serialPort: 'COM1',
  networkHost: '192.168.1.100',
  networkPort: 9100,
  serverUrl: 'http://localhost:3000',
  notificaciones: true,
};

function configPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): AgentConfig {
  try {
    const raw = fs.readFileSync(configPath(), 'utf-8');
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: Partial<AgentConfig>): void {
  const current = loadConfig();
  const next = { ...current, ...cfg };
  // Solo 'pdf' apaga el ESC/POS; cualquier otra cosa es 'auto'. Un valor basura escrito a
  // mano en config.json no puede dejar la caja en un modo que nadie sabe interpretar.
  next.modoTicket = next.modoTicket === 'pdf' ? 'pdf' : 'auto';
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8');
}
