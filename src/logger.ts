import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

const MAX_LOG_BYTES = 1_000_000; // 1 MB antes de rotar
const MAX_LOG_FILES = 5;         // mantiene agent.log + agent.log.1..5

let _logPath: string | null = null;

function getLogPath(): string {
  if (!_logPath) {
    _logPath = path.join(app.getPath('userData'), 'agent.log');
  }
  return _logPath;
}

export { getLogPath };

// Rotación numerada: agent.log → .1 → .2 → ... → .MAX (el más viejo se descarta).
function rotate(): void {
  const p = getLogPath();
  try {
    const stat = fs.statSync(p);
    if (stat.size < MAX_LOG_BYTES) return;
  } catch {
    return; // archivo no existe aún — nada que rotar
  }

  // Descartar el más viejo y desplazar el resto hacia arriba.
  try { fs.unlinkSync(`${p}.${MAX_LOG_FILES}`); } catch { /* no existe */ }
  for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
    try { fs.renameSync(`${p}.${i}`, `${p}.${i + 1}`); } catch { /* no existe */ }
  }
  try { fs.renameSync(p, `${p}.1`); } catch { /* noop */ }
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
