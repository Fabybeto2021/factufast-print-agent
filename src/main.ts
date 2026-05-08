import { app, Tray, ipcMain } from 'electron';
import { startServer } from './server';
import { createTray, updateTrayMenu } from './tray';
import { loadConfig, saveConfig } from './config';

// Impedir múltiples instancias
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Auto-iniciar con Windows al instalar
app.setLoginItemSettings({ openAtLogin: true, name: 'FactuFAST PrintAgent' });

let tray: Tray | null = null;

app.on('ready', () => {
  // No mostrar ventana principal — solo bandeja del sistema
  app.dock?.hide(); // macOS: ocultar del dock

  tray = createTray(() => app.quit());

  startServer((connected) => {
    if (tray) updateTrayMenu(tray, connected, () => app.quit());
  });

  ipcMain.handle('get-config', () => loadConfig());
  ipcMain.handle('save-config', (_event, cfg) => { saveConfig(cfg); });
});

// Evitar que la app se cierre al cerrar la última ventana (solo la bandeja importa)
app.on('window-all-closed', () => {
  // noop — la app sigue viva en la bandeja
});
