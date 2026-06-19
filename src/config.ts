import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface AgentConfig {
  printerName: string;
  printerInterface: 'usb' | 'serial' | 'network';
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
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), 'utf-8');
}
