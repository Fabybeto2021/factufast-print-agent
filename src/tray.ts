import { app, Menu, Tray, nativeImage, BrowserWindow, shell } from 'electron';
import * as path from 'path';

let tray: Tray | null = null;
let configWindow: BrowserWindow | null = null;

export function createTray(onQuit: () => void): Tray {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('FactuFAST PrintAgent');
  updateTrayMenu(tray, true, onQuit);
  return tray;
}

export function updateTrayMenu(tray: Tray, connected: boolean, onQuit: () => void): void {
  const status = connected ? '● Impresora conectada' : '○ Sin impresora';
  const menu = Menu.buildFromTemplate([
    { label: 'FactuFAST PrintAgent v1.0', enabled: false },
    { label: status, enabled: false },
    { type: 'separator' },
    {
      label: 'Configuración',
      click: () => openConfigWindow(),
    },
    {
      label: 'Ver logs',
      click: () => {
        const { app } = require('electron');
        shell.openPath(app.getPath('userData'));
      },
    },
    { type: 'separator' },
    { label: 'Salir', click: onQuit },
  ]);
  tray.setContextMenu(menu);
  tray.setTitle(connected ? '' : '⚠');
}

function openConfigWindow(): void {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.focus();
    return;
  }
  configWindow = new BrowserWindow({
    width: 480,
    height: 520,
    resizable: false,
    title: 'FactuFAST PrintAgent — Configuración',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });
  const htmlPath = path.join(__dirname, '..', 'assets', 'config.html');
  configWindow.loadFile(htmlPath);
  configWindow.on('closed', () => { configWindow = null; });
}
