import { app, Tray, ipcMain } from 'electron';
import { startServer } from './server';
import { createTray, updateTrayMenu, notificarError, registrarActividad } from './tray';
import { loadConfig, saveConfig } from './config';
import { log } from './logger';

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

  log('INFO', 'PrintAgent iniciado');

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
});

// Evitar que la app se cierre al cerrar la última ventana
app.on('window-all-closed', () => {
  // noop — la app sigue viva en la bandeja
});
