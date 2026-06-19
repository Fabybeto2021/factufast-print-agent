import { app, Menu, Tray, nativeImage, BrowserWindow, shell, Notification } from 'electron';
import * as path from 'path';
import { loadConfig } from './config';
import { abrirCajon, probarImpresion, verificarImpresora } from './printer';
import { log, getLogPath } from './logger';

let tray: Tray | null = null;
let configWindow: BrowserWindow | null = null;
let lastActivityTime: Date | null = null;
let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let currentStatus = true;

export function createTray(onQuit: () => void): Tray {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('FactuFAST PrintAgent');
  updateTrayMenu(tray, true, onQuit);

  // Health check cada 30 segundos
  healthCheckInterval = setInterval(() => runHealthCheck(onQuit), 30_000);

  return tray;
}

async function runHealthCheck(onQuit: () => void): Promise<void> {
  if (!tray) return;
  // Sonda REAL: la impresora existe y está en línea (no solo "hay un nombre escrito").
  let healthy = false;
  try {
    const sonda = await verificarImpresora();
    healthy = sonda.found;
  } catch {
    healthy = false;
  }
  if (healthy !== currentStatus) {
    log('INFO', `Health check: estado cambia a ${healthy ? 'OK' : 'IMPRESORA NO DISPONIBLE'}`);
    updateTrayMenu(tray, healthy, onQuit);
  }
}

export function notificarError(titulo: string, cuerpo: string): void {
  try {
    const cfg = loadConfig();
    if (!cfg.notificaciones) return;
    if (Notification.isSupported()) {
      new Notification({ title: titulo, body: cuerpo }).show();
    }
  } catch { /* noop */ }
}

export function notificarExito(cuerpo: string): void {
  try {
    const cfg = loadConfig();
    if (!cfg.notificaciones) return;
    if (Notification.isSupported()) {
      new Notification({ title: 'FactuFAST PrintAgent', body: cuerpo }).show();
    }
  } catch { /* noop */ }
}

export function registrarActividad(): void {
  lastActivityTime = new Date();
}

export function updateTrayMenu(tray: Tray, connected: boolean, onQuit: () => void, pendingUpdate?: string): void {
  currentStatus = connected;
  const status = connected ? '● Impresora lista' : '○ Sin impresora configurada';
  const ultima = lastActivityTime
    ? `Última impresión: ${lastActivityTime.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}`
    : 'Sin actividad reciente';

  const items: Electron.MenuItemConstructorOptions[] = [
    { label: `FactuFAST PrintAgent`, enabled: false },
    { label: status, enabled: false },
    { label: ultima, enabled: false },
    { type: 'separator' },
  ];

  if (pendingUpdate) {
    items.unshift(
      { label: `⬆ Instalar actualización v${pendingUpdate}`, click: () => { const { autoUpdater } = require('electron-updater'); autoUpdater.quitAndInstall(false, true); } },
      { type: 'separator' },
    );
  }

  const menu = Menu.buildFromTemplate([...items,
    {
      label: 'Configuración',
      click: () => openConfigWindow(),
    },
    {
      label: 'Ver logs',
      click: () => shell.openPath(getLogPath()),
    },
    {
      label: 'Probar cajón',
      click: async () => {
        try {
          await abrirCajon();
          log('INFO', 'Test cajón desde tray: OK');
        } catch (e) {
          const msg = (e as Error).message;
          log('ERROR', `Test cajón desde tray: ${msg}`);
          notificarError('Error al abrir cajón', msg);
        }
      },
    },
    {
      label: 'Diagnóstico (imprimir prueba + cajón)',
      click: async () => {
        const errores: string[] = [];
        try { await probarImpresion(); } catch (e) { errores.push('impresión: ' + (e as Error).message); }
        try { await abrirCajon(); } catch (e) { errores.push('cajón: ' + (e as Error).message); }
        if (errores.length > 0) {
          log('ERROR', `Diagnóstico tray: ${errores.join(' | ')}`);
          notificarError('Diagnóstico con errores', errores.join('\n'));
        } else {
          log('INFO', 'Diagnóstico tray: OK');
          notificarExito('Diagnóstico OK: recibo impreso y cajón abierto');
        }
      },
    },
    { type: 'separator' },
    { label: 'Salir', click: onQuit },
  ]);

  tray.setContextMenu(menu);
  tray.setTitle(connected ? '' : '⚠');
  tray.setToolTip(`FactuFAST PrintAgent\n${status}\n${ultima}`);
}

function openConfigWindow(): void {
  if (configWindow && !configWindow.isDestroyed()) {
    configWindow.focus();
    return;
  }
  configWindow = new BrowserWindow({
    width: 480,
    height: 580,
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
