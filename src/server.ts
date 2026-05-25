import express, { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { loadConfig } from './config';
import { abrirCajon, imprimirTicket } from './printer';
import { log } from './logger';

interface PrintRequest {
  comprobanteId?: string;
  imprimirTicket?: boolean;
  abrirCajon?: boolean;
  authToken?: string;
}

function getVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8'));
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

export function startServer(onStatusChange: (ok: boolean, errors?: string[]) => void): void {
  const app = express();
  app.use(express.json());

  // CORS: solo permite peticiones desde el servidor FactuFAST configurado
  app.use((req, res, next) => {
    const cfg = loadConfig();
    const origin = req.headers.origin ?? '';
    // Permitir solo el origen del servidor configurado (y peticiones sin origin como Electron/curl)
    const allowedOrigin = cfg.serverUrl || 'http://localhost:3000';
    if (!origin || origin === allowedOrigin || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1')) {
      res.setHeader('Access-Control-Allow-Origin', origin || allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    next();
  });

  app.options('*', (_req, res) => res.sendStatus(200));

  app.get('/status', (_req: Request, res: Response) => {
    const cfg = loadConfig();
    res.json({ ok: true, printer: cfg.printerName || '(sin configurar)', version: getVersion() });
  });

  app.post('/print', async (req: Request, res: Response) => {
    const body = req.body as PrintRequest;
    const errores: string[] = [];

    log('INFO', `POST /print — cajón:${body.abrirCajon} ticket:${body.imprimirTicket} id:${body.comprobanteId ?? '-'}`);

    try {
      if (body.abrirCajon) {
        try {
          await abrirCajon();
        } catch (e) {
          const msg = 'cajón: ' + (e instanceof Error ? e.message : String(e));
          errores.push(msg);
          log('ERROR', msg);
        }
      }

      if (body.imprimirTicket && body.comprobanteId) {
        try {
          await imprimirTicket(body.comprobanteId, body.authToken);
        } catch (e) {
          const msg = 'impresión: ' + (e instanceof Error ? e.message : String(e));
          errores.push(msg);
          log('ERROR', msg);
        }
      }

      if (errores.length > 0) {
        onStatusChange(false, errores);
        res.status(207).json({ ok: false, errors: errores });
      } else {
        onStatusChange(true);
        res.json({ ok: true });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log('ERROR', `Error inesperado en /print: ${msg}`);
      onStatusChange(false);
      res.status(500).json({ ok: false, error: msg });
    }
  });

  const cfg = loadConfig();
  const port = cfg.agentPort ?? 7979;
  app.listen(port, '127.0.0.1', () => {
    log('INFO', `PrintAgent v${getVersion()} escuchando en http://127.0.0.1:${port}`);
  });
}
