// Puente de la ventana de configuración (v1.7.0). La ventana corre aislada
// (contextIsolation + sandbox, sin Node): solo ve estas funciones, y el proceso
// principal comprueba además que la llamada venga de assets/config.html.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('agente', {
  obtenerConfig: () => ipcRenderer.invoke('get-config'),
  guardarConfig: (cfg: unknown) => ipcRenderer.invoke('save-config', cfg),
  listarImpresoras: () => ipcRenderer.invoke('list-printers'),
  diagnostico: () => ipcRenderer.invoke('selftest'),
  probarRaster: (largo: boolean) => ipcRenderer.invoke('selftest-raster', largo === true),
  probarCajon: () => ipcRenderer.invoke('probar-cajon'),
  probarTicket: (comprobanteId: string) => ipcRenderer.invoke('probar-ticket', String(comprobanteId ?? '')),
});
