# FactuFAST PrintAgent

Agente local para impresora térmica y cajón registrador. Se instala en cada PC donde
haya una impresora conectada. Se comunica con el POS vía HTTP en `localhost:7979`.

## Funciones

| Acción | Descripción |
|--------|-------------|
| Abrir cajón | Envía comando ESC/POS `[1B 70 00 19 FA]` al puerto USB/COM |
| Imprimir ticket | Descarga el PDF del servidor FactuFAST e imprime con SumatraPDF silencioso |
| Solo cajón (sin papel) | `{ abrirCajon: true, imprimirTicket: false }` |
| Solo papel (sin cajón) | `{ abrirCajon: false, imprimirTicket: true, comprobanteId: "..." }` |

## Requisitos previos

- Windows 10/11 (o Linux con AppImage)
- Impresora térmica conectada por USB o COM
- Cajón registrador conectado a la impresora vía RJ11/RJ12
- Node.js 18+ y npm (solo para compilar/desarrollar)

## Instalación (producción)

1. Descargar `PrintAgent-Setup-1.0.0.exe` de los releases
2. Ejecutar el instalador → siguiente → instalar
3. El agente se auto-inicia con Windows (bandeja del sistema)
4. Clic derecho en el ícono de la bandeja → **Configuración**
5. Ingresar el nombre exacto de la impresora (Panel de Control → Dispositivos e impresoras)
6. Guardar y reiniciar

## Agregar SumatraPDF (requerido para imprimir tickets)

1. Descargar `SumatraPDF.exe` portable desde: https://www.sumatrapdfreader.org/download-free-pdf-viewer
2. Copiar el `.exe` a la carpeta `vendor/` del proyecto (antes de compilar)
3. `electron-builder` lo empaqueta automáticamente en el instalador

## Desarrollo

```bash
npm install
npm run dev          # Compila TypeScript y lanza Electron
npm run dist:win     # Genera instalador .exe para Windows
npm run dist:linux   # Genera .AppImage para Linux
```

## API

### `POST http://localhost:7979/print`

```json
{
  "comprobanteId": "uuid-del-comprobante",  // opcional — requerido si imprimirTicket=true
  "imprimirTicket": true,
  "abrirCajon": true
}
```

Respuesta OK: `{ "ok": true }`
Respuesta error parcial (ej: cajón abrió pero fallo impresión): `{ "ok": false, "errors": [...] }`

### `GET http://localhost:7979/status`

```json
{ "ok": true, "printer": "EPSON TM-T20", "version": "1.0.0" }
```

## Conexión del cajón registrador

El cajón NO se conecta directamente a la PC. Se conecta a la impresora:

```
PC  ──USB──►  Impresora térmica  ──RJ11/RJ12──►  Cajón registrador
```

El agente envía el comando ESC/POS a la impresora, que a su vez envía el pulso eléctrico al cajón.
Si la impresora no está encendida, el cajón no se abrirá aunque el agente esté activo.
# factufast-print-agent
