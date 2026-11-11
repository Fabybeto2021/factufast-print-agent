import express, { Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';
import { loadConfig, AGENT_PORT } from './config';
import {
  abrirCajon, imprimirTicket, imprimirCupones, imprimirEscposInline, diagnostico, probarImpresion,
  probarRaster, RASTER_PRUEBA_CORTO, RASTER_PRUEBA_LARGO,
} from './printer';
import { log } from './logger';
import { baseDescarga } from './origenes';
import { evaluarPeticion, crearFrenoRegistro } from './guardia';

interface PrintRequest {
  comprobanteId?: string;
  imprimirTicket?: boolean;
  imprimirCupones?: boolean;
  abrirCajon?: boolean;
  authToken?: string;
  // Documento genérico (recibos de cobros, tickets de Ventas Directas): ruta relativa
  // al PDF. Si viene, se descarga de ahí en vez de /api/comprobantes/{id}/pdf/ticket.
  ticketPdfPath?: string;
  // Bytes ESC/POS ya construidos (v1.3+): comprobante provisional de la venta
  // offline — el cliente compone el ticket y aquí solo se transporta al hardware.
  escposBase64?: string;
}

function getVersion(): string {
  try {
    // Sin BOM: si package.json se guardó con BOM, JSON.parse fallaba y /status decía 1.0.0,
    // con lo que el POS apagaba el ESC/POS (pide ≥1.4.0) y los recibos genéricos.
    const raw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8').replace(/^\uFEFF/, '');
    const pkg = JSON.parse(raw);
    return pkg.version ?? '1.0.0';
  } catch {
    return '1.0.0';
  }
}

function cabecera(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export function startServer(onStatusChange: (ok: boolean, errors?: string[]) => void): void {
  const app = express();
  app.disable('x-powered-by');
  const frenoRechazos = crearFrenoRegistro();

  // ⚠️ v1.7.0 — GUARDIA, antes de leer el cuerpo y para todos los métodos (ver
  // src/guardia.ts). Hasta la 1.6.0 este middleware solo ponía cabeceras CORS y siempre
  // seguía: cualquier página abierta en la PC podía abrir el cajón con un POST simple.
  app.use((req, res, next) => {
    const cfg = loadConfig();
    const origin = cabecera(req.headers.origin) ?? '';
    const veredicto = evaluarPeticion(
      {
        metodo: req.method,
        host: cabecera(req.headers.host),
        origin,
        contentType: cabecera(req.headers['content-type']),
        secFetchSite: cabecera(req.headers['sec-fetch-site']),
      },
      {
        puerto: AGENT_PORT,
        serverUrl: cfg.serverUrl,
        extra: cfg.origenesPermitidos ?? [],
        permitirOrigenLocal: cfg.permitirOrigenLocal === true,
      },
    );

    // CORS solo para un origen permitido, y nunca `*`. También en un rechazo (el 415 al
    // POS): sin estas cabeceras el navegador esconde la respuesta y el cajero lee «no se
    // pudo contactar al agente» en vez del motivo.
    res.setHeader('Vary', 'Origin');
    if (origin && veredicto.origenPermitido) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }

    if (!veredicto.ok) {
      const linea = frenoRechazos(`${req.method} ${req.path} (${veredicto.status}): ${veredicto.motivo}`);
      if (linea) log('WARN', `Rechazado ${linea}`);
      res.status(veredicto.status).json({ ok: false, error: 'rechazado', motivo: veredicto.motivo });
      return;
    }

    if (origin && veredicto.origenPermitido) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      // Private Network Access: un sitio HTTPS público que llama a http://localhost
      // dispara un preflight PNA. Sin esta cabecera Chrome/Edge bloquearían al agente.
      if (req.headers['access-control-request-private-network'] === 'true') {
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
      }
    }
    next();
  });

  // ⚠️ El default de express.json() son 100 KB y un ticket fiscal rasterizado
  // (`escposBase64`) pesa 150–400 KB → 413 antes de llegar al handler, con lo que
  // NINGUNA factura real llegaba a imprimirse por ESC/POS: caían todas al PDF, que es
  // donde el driver las recorta si exceden su formulario de papel. Los payloads
  // pequeños (cajón, recibo de prueba, provisional offline) sí pasaban, y por eso el
  // /selftest se veía sano.
  app.use(express.json({ limit: '10mb' }));

  app.options('*', (_req, res) => res.sendStatus(204));

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

  // Diagnóstico activo: recibo de prueba + cajón, y opcionalmente el RÁSTER.
  //
  // ⚠️ `raster` no es un extra: el recibo de texto son ~250 bytes y pasa siempre, incluso
  // en una caja donde toda factura real sale mal (fue lo que escondió el fallo de
  // transporte de la v1.3.x, y lo que dejó sin diagnosticar la caja de SPPLAST). El ticket
  // fiscal viaja como ráster `GS v 0`, así que hay que poder ejercitar ESE camino:
  //   { "raster": "corto" } → ¿esta impresora entiende GS v 0?
  //   { "raster": "largo" } → ¿aguanta el caudal de un ticket entero?
  app.post('/selftest', async (req: Request, res: Response) => {
    const errores: string[] = [];
    const raster = (req.body as { raster?: string } | undefined)?.raster;

    if (raster === 'corto' || raster === 'largo') {
      const filas = raster === 'largo' ? RASTER_PRUEBA_LARGO : RASTER_PRUEBA_CORTO;
      try {
        await probarRaster(filas, `PRUEBA DE RASTER (${raster})`);
      } catch (e) {
        errores.push('raster: ' + (e as Error).message);
      }
      const diagR = await diagnostico().catch(() => null);
      if (errores.length > 0) {
        onStatusChange(false, errores);
        return res.status(207).json({ ok: false, errors: errores, diagnostico: diagR });
      }
      onStatusChange(true);
      return res.json({ ok: true, raster, filas, diagnostico: diagR });
    }

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
    // ⚠️ Un POST que no pide NADA (típicamente el modo ahorro de papel: sin ticket, sin
    // cupones y sin cajón) respondía `ok:true` — el agente afirmaba haber impreso algo que
    // nunca imprimió. En el log de SPPLAST son 410 documentos indistinguibles de una
    // impresión real. Se sigue respondiendo 200 (no es un error), pero declarado.
    const nadaQueImprimir =
      !body.abrirCajon && !body.escposBase64 && !body.imprimirCupones &&
      !(body.imprimirTicket && (body.comprobanteId || body.ticketPdfPath));

    // Los PDF se descargan del MISMO origen que pidió la impresión (v1.6.0): la caja
    // decide a qué dominio va, no el `serverUrl` que alguien escribió en esta PC.
    const cfgPrint = loadConfig();
    const base = baseDescarga(
      req.headers.origin, cfgPrint.serverUrl, cfgPrint.origenesPermitidos ?? [],
      { permitirLocal: cfgPrint.permitirOrigenLocal === true },
    );

    log('INFO', `POST /print — cajón:${body.abrirCajon} ticket:${body.imprimirTicket} cupones:${body.imprimirCupones} id:${body.comprobanteId ?? '-'} pdf:${body.ticketPdfPath ?? '-'} desde:${base || '-'}${nadaQueImprimir ? ' — SIN NADA QUE IMPRIMIR' : ''}`);

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

      // Ticket: comprobante (URL fija) o documento genérico (ticketPdfPath: cobros/VD).
      if (body.imprimirTicket && (body.comprobanteId || body.ticketPdfPath)) {
        try {
          await imprimirTicket(body.comprobanteId ?? '', body.authToken, body.ticketPdfPath, base);
        } catch (e) {
          const msg = 'impresión: ' + (e instanceof Error ? e.message : String(e));
          errores.push(msg);
          log('ERROR', msg);
        }
      }

      // Bytes ESC/POS inline (v1.3): ticket provisional offline de FactuFAST Desktop.
      if (body.escposBase64) {
        try {
          await imprimirEscposInline(body.escposBase64);
        } catch (e) {
          const msg = 'escpos-inline: ' + (e instanceof Error ? e.message : String(e));
          errores.push(msg);
          log('ERROR', msg);
        }
      }

      // Boletos de ánfora — independiente del ticket fiscal (se imprimen aunque
      // el cajón esté en modo ahorro de papel). 204 del servidor = nada que imprimir.
      if (body.imprimirCupones && body.comprobanteId) {
        try {
          await imprimirCupones(body.comprobanteId, body.authToken, base);
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
        res.json({ ok: true, ...(nadaQueImprimir ? { nada_que_imprimir: true } : {}) });
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
