import express, { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { loadConfig, AGENT_PORT } from './config';
import { abrirCajon, imprimirTicket, imprimirCupones, diagnostico, probarImpresion } from './printer';
import { log } from './logger';

interface PrintRequest {
  comprobanteId?: string;
  imprimirTicket?: boolean;
  imprimirCupones?: boolean;
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

  // CORS: permite localhost siempre + el serverUrl configurado (para producción/Vercel)
  app.use((req, res, next) => {
    const origin = req.headers.origin ?? '';
    const cfg = loadConfig();
    const configuredOrigin = cfg.serverUrl || '';

    const isAllowed =
      !origin ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1') ||
      (configuredOrigin && origin === configuredOrigin);

    if (isAllowed) {
      res.setHeader('Access-Control-Allow-Origin', origin || '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      // Private Network Access: un sitio HTTPS público que llama a http://localhost
      // dispara un preflight PNA. Sin esta cabecera Chrome/Edge bloquearían al agente.
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    }
    next();
  });

  app.options('*', (_req, res) => res.sendStatus(200));

  // Estado con sonda REAL de hardware/servidor (ya no miente con ok:true fijo).
  app.get('/status', async (_req: Request, res: Response) => {
    try {
      const diag = await diagnostico();
      const ok = diag.printerFound && diag.sumatraOk;
      res.json({ ok, version: getVersion(), printer: diag.printerName || '(sin configurar)', ...diag });
    } catch (e) {
      res.json({ ok: false, version: getVersion(), error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Diagnóstico activo: imprime un recibo de prueba + abre el cajón.
  app.post('/selftest', async (_req: Request, res: Response) => {
    const errores: string[] = [];
    try { await probarImpresion(); } catch (e) { errores.push('impresión: ' + (e as Error).message); }
    try { await abrirCajon(); } catch (e) { errores.push('cajón: ' + (e as Error).message); }
    const diag = await diagnostico().catch(() => null);
    if (errores.length > 0) {
      onStatusChange(false, errores);
      return res.status(207).json({ ok: false, errors: errores, diagnostico: diag });
    }
    onStatusChange(true);
    res.json({ ok: true, diagnostico: diag });
  });

  app.post('/print', async (req: Request, res: Response) => {
    const body = req.body as PrintRequest;
    const errores: string[] = [];

    log('INFO', `POST /print — cajón:${body.abrirCajon} ticket:${body.imprimirTicket} cupones:${body.imprimirCupones} id:${body.comprobanteId ?? '-'}`);

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

      // Boletos de ánfora — independiente del ticket fiscal (se imprimen aunque
      // el cajón esté en modo ahorro de papel). 204 del servidor = nada que imprimir.
      if (body.imprimirCupones && body.comprobanteId) {
        try {
          await imprimirCupones(body.comprobanteId, body.authToken);
        } catch (e) {
          const msg = 'cupones: ' + (e instanceof Error ? e.message : String(e));
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

  app.listen(AGENT_PORT, '127.0.0.1', () => {
    log('INFO', `PrintAgent v${getVersion()} escuchando en http://127.0.0.1:${AGENT_PORT}`);
  });
}
