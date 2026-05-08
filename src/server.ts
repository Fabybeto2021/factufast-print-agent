import express, { Request, Response } from 'express';
import { loadConfig } from './config';
import { abrirCajon, imprimirTicket } from './printer';

interface PrintRequest {
  comprobanteId?: string;
  imprimirTicket?: boolean;
  abrirCajon?: boolean;
}

export function startServer(onStatusChange: (ok: boolean) => void): void {
  const app = express();
  app.use(express.json());

  // CORS: solo localhost puede llamar al agente
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    next();
  });

  app.options('*', (_req, res) => res.sendStatus(200));

  app.get('/status', (_req: Request, res: Response) => {
    const cfg = loadConfig();
    res.json({ ok: true, printer: cfg.printerName || '(sin configurar)', version: '1.0.0' });
  });

  app.post('/print', async (req: Request, res: Response) => {
    const body = req.body as PrintRequest;
    const errores: string[] = [];

    try {
      if (body.abrirCajon) {
        try {
          await abrirCajon();
        } catch (e) {
          errores.push('cajón: ' + (e instanceof Error ? e.message : String(e)));
        }
      }

      if (body.imprimirTicket && body.comprobanteId) {
        try {
          await imprimirTicket(body.comprobanteId);
        } catch (e) {
          errores.push('impresión: ' + (e instanceof Error ? e.message : String(e)));
        }
      }

      if (errores.length > 0) {
        res.status(207).json({ ok: false, errors: errores });
      } else {
        onStatusChange(true);
        res.json({ ok: true });
      }
    } catch (e) {
      onStatusChange(false);
      res.status(500).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  const cfg = loadConfig();
  const port = cfg.agentPort ?? 7979;
  app.listen(port, '127.0.0.1', () => {
    console.log(`PrintAgent escuchando en http://127.0.0.1:${port}`);
  });
}
