import { app, Tray, ipcMain } from 'electron';
import { startServer } from './server';
import { createTray, updateTrayMenu, notificarError, notificarExito, registrarActividad } from './tray';
import { loadConfig, saveConfig } from './config';
import { listarImpresoras, probarImpresion, abrirCajon, diagnostico } from './printer';
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

  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('save-config', (_event, cfg) => {
    saveConfig(cfg);
    log('INFO', 'Configuración guardada');
  });
  ipcMain.handle('list-printers', () => listarImpresoras());
  ipcMain.handle('diagnostico', () => diagnostico());
  ipcMain.handle('selftest', async () => {
    const errores: string[] = [];
    try { await probarImpresion(); } catch (e) { errores.push('impresión: ' + (e as Error).message); }
    try { await abrirCajon(); } catch (e) { errores.push('cajón: ' + (e as Error).message); }
    return { ok: errores.length === 0, errors: errores };
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
