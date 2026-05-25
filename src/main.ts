import { app, Tray, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { startServer } from './server';
import { createTray, updateTrayMenu, notificarError, notificarExito, registrarActividad } from './tray';
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

  // Auto-update: revisa GitHub Releases 10 segundos después de iniciar
  setTimeout(() => configurarAutoUpdate(), 10_000);
});

function configurarAutoUpdate(): void {
  autoUpdater.logger = null; // usamos nuestro propio logger
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
    // Actualizar el menú del tray con opción de instalar ahora
    if (tray) {
      const { Menu } = require('electron');
      const currentMenu = tray.getContextMenu();
      if (currentMenu) {
        // Agregar item de actualización al inicio del menú existente
        const updateItem = {
          label: `⬆ Instalar actualización v${info.version}`,
          click: () => {
            autoUpdater.quitAndInstall(false, true);
          },
        };
        const items = currentMenu.items;
        Menu.buildFromTemplate([updateItem, { type: 'separator' as const }, ...items.map(i => ({
          label: i.label,
          enabled: i.enabled,
          click: i.click ?? undefined,
          type: i.type as 'normal' | 'separator' | 'submenu' | 'checkbox' | 'radio' | undefined,
        }))]);
      }
    }
  });

  autoUpdater.on('error', (err) => {
    // No mostrar notificación por errores de update — son silenciosos en el log
    log('WARN', `Auto-update error: ${err.message}`);
  });

  autoUpdater.checkForUpdates().catch(() => { /* sin internet — silencioso */ });
}

// Evitar que la app se cierre al cerrar la última ventana
app.on('window-all-closed', () => {
  // noop — la app sigue viva en la bandeja
});
