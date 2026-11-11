import { app, Tray, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { startServer } from './server';
import { createTray, updateTrayMenu, notificarError, notificarExito, registrarActividad } from './tray';
import { loadConfig, saveConfig } from './config';
import {
  listarImpresoras, probarImpresion, abrirCajon, diagnostico, imprimirTicket,
  probarRaster, RASTER_PRUEBA_CORTO, RASTER_PRUEBA_LARGO,
} from './printer';
import { esVentanaConfig, validarConfigEntrante } from './config-validacion';
import { esUuid } from './descarga';
import { log } from './logger';

// Robustez: nunca morir en silencio por un error no capturado — registrar y seguir
// vivo en la bandeja (una caja no debe quedarse sin agente de impresión por un fallo
// puntual de hardware/red).
process.on('uncaughtException', (err) => {
  try { log('ERROR', `uncaughtException: ${err?.message ?? err}`); } catch { /* noop */ }
});
process.on('unhandledRejection', (reason) => {
  try { log('ERROR', `unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`); } catch { /* noop */ }
});

// Impedir múltiples instancias
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Auto-iniciar con Windows al instalar
app.setLoginItemSettings({ openAtLogin: true, name: 'FactuFAST PrintAgent' });

let tray: Tray | null = null;

app.on('ready', () => {
  app.dock?.hide(); // macOS: ocultar del dock

  log('INFO', `PrintAgent v${app.getVersion()} iniciado`);

  tray = createTray(() => app.quit());

  startServer((ok, errors) => {
    if (tray) updateTrayMenu(tray, ok, () => app.quit());
    if (ok) {
      registrarActividad();
    } else if (errors && errors.length > 0) {
      notificarError('Error de impresión', errors.join('\n'));
    }
  });

  // v1.7.0: toda llamada IPC tiene que venir de la ventana de configuración del agente.
  const desdeConfig = (event: IpcMainInvokeEvent): boolean => {
    const ok = esVentanaConfig(event.senderFrame?.url);
    if (!ok) log('WARN', `IPC rechazado desde ${event.senderFrame?.url ?? '(desconocido)'}`);
    return ok;
  };

  ipcMain.handle('get-config', (event) => (desdeConfig(event) ? loadConfig() : null));
  ipcMain.handle('save-config', (event, cfg: unknown) => {
    if (!desdeConfig(event)) return { ok: false };
    const valido = validarConfigEntrante(cfg);
    if (!valido) return { ok: false };
    saveConfig(valido);
    log('INFO', 'Configuración guardada');
    return { ok: true };
  });
  ipcMain.handle('list-printers', (event) => (desdeConfig(event) ? listarImpresoras() : []));
  ipcMain.handle('diagnostico', (event) => (desdeConfig(event) ? diagnostico() : null));
  ipcMain.handle('selftest', async (event) => {
    if (!desdeConfig(event)) return { ok: false, errors: ['no permitido'] };
    const errores: string[] = [];
    try { await probarImpresion(); } catch (e) { errores.push('impresión: ' + (e as Error).message); }
    try { await abrirCajon(); } catch (e) { errores.push('cajón: ' + (e as Error).message); }
    return { ok: errores.length === 0, errors: errores };
  });

  // Prueba del camino REAL del ticket fiscal (ráster GS v 0), que el recibo de texto de
  // `selftest` no ejercita — ver la nota de `probarRaster`.
  ipcMain.handle('selftest-raster', async (event, largo: unknown) => {
    if (!desdeConfig(event)) return { ok: false, errors: ['no permitido'] };
    const esLargo = largo === true;
    const filas = esLargo ? RASTER_PRUEBA_LARGO : RASTER_PRUEBA_CORTO;
    try {
      await probarRaster(filas, esLargo ? 'PRUEBA DE RASTER (largo)' : 'PRUEBA DE RASTER (corto)');
      return { ok: true, filas };
    } catch (e) {
      return { ok: false, filas, errors: ['raster: ' + (e as Error).message] };
    }
  });

  // Antes la ventana hacía fetch a http://127.0.0.1:7979 desde file:// (Origin "null"),
  // que la guardia ahora rechaza: los botones de prueba van por IPC.
  ipcMain.handle('probar-cajon', async (event) => {
    if (!desdeConfig(event)) return { ok: false, errors: ['no permitido'] };
    try {
      await abrirCajon();
      return { ok: true };
    } catch (e) {
      return { ok: false, errors: ['cajón: ' + (e as Error).message] };
    }
  });
  ipcMain.handle('probar-ticket', async (event, comprobanteId: unknown) => {
    if (!desdeConfig(event)) return { ok: false, errors: ['no permitido'] };
    if (!esUuid(comprobanteId)) return { ok: false, errors: ['El ID del comprobante no es válido'] };
    try {
      await imprimirTicket(comprobanteId);
      return { ok: true };
    } catch (e) {
      return { ok: false, errors: ['impresión: ' + (e as Error).message] };
    }
  });

  // Auto-update: revisa GitHub Releases 10 segundos después de iniciar
  setTimeout(() => configurarAutoUpdate(), 10_000);
});

function configurarAutoUpdate(): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    log('INFO', 'Buscando actualizaciones...');
  });

  autoUpdater.on('update-available', (info) => {
    log('INFO', `Actualización disponible: v${info.version}`);
    notificarExito(`Nueva versión disponible: v${info.version}. Descargando...`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    log('INFO', `Actualización v${info.version} descargada — se instalará al cerrar`);
    notificarExito(`Actualización v${info.version} lista. Se instalará al reiniciar el agente.`);
    if (tray) updateTrayMenu(tray, true, () => app.quit(), info.version);
  });

  autoUpdater.on('error', (err) => {
    log('WARN', `Auto-update error: ${err.message}`);
  });

  autoUpdater.checkForUpdates().catch(() => { /* sin internet — silencioso */ });
}

// Evitar que la app se cierre al cerrar la última ventana
app.on('window-all-closed', () => {
  // noop — la app sigue viva en la bandeja
});
