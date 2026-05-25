import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

const MAX_LOG_BYTES = 1_000_000; // 1 MB antes de rotar

let _logPath: string | null = null;

function getLogPath(): string {
  if (!_logPath) {
    _logPath = path.join(app.getPath('userData'), 'agent.log');
  }
  return _logPath;
}

export { getLogPath };

function rotate(): void {
  const p = getLogPath();
  try {
    const stat = fs.statSync(p);
    if (stat.size >= MAX_LOG_BYTES) {
      fs.renameSync(p, p + '.1');
    }
  } catch {
    // archivo no existe aún — nada que rotar
  }
}

export function log(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  try {
    rotate();
    const now = new Date();
    const ts = now.toISOString().replace('T', ' ').slice(0, 19);
    const line = `${ts} [${level}] ${msg}\n`;
    fs.appendFileSync(getLogPath(), line, 'utf-8');
  } catch {
    // no bloquear la app si el log falla
  }
}
