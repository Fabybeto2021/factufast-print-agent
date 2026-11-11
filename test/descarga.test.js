// Descarga segura del PDF y envío del token (v1.7.0). Corre con: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const { rutaDescargaSegura, tokenPermitido, esUuid } = require('../dist/descarga.js');
const { validarConfigEntrante, esVentanaConfig } = require('../dist/config-validacion.js');

const BASE = 'https://app.reslez.com';

test('una ruta de la API del mismo servidor se arma bien', () => {
  assert.strictEqual(
    rutaDescargaSegura(BASE, '/api/cobros/recibo?grupo=abc&formato=ticket'),
    'https://app.reslez.com/api/cobros/recibo?grupo=abc&formato=ticket',
  );
  assert.strictEqual(rutaDescargaSegura(`${BASE}/`, '/api/x'), `${BASE}/api/x`);
});

test('el token NO puede salir a otro host', () => {
  // Hasta la 1.6.0: `${servidor}${ruta}` → https://app.reslez.com@evil.com/x → host evil.com.
  assert.throws(() => rutaDescargaSegura(BASE, '@evil.com/x'));
  assert.throws(() => rutaDescargaSegura(BASE, '/api/x@evil.com'));
  assert.throws(() => rutaDescargaSegura(BASE, '//evil.com/api/x'));
  assert.throws(() => rutaDescargaSegura(BASE, '/api//evil.com'));
  assert.throws(() => rutaDescargaSegura(BASE, '/api/\\evil.com'));
  assert.throws(() => rutaDescargaSegura(BASE, 'https://evil.com/api/x'));
  assert.throws(() => rutaDescargaSegura(BASE, '.evil.com/api/x'));
});

test('solo rutas de la API, sin salir de ella con ..', () => {
  assert.throws(() => rutaDescargaSegura(BASE, '/pos'));
  assert.throws(() => rutaDescargaSegura(BASE, '/api/../login'));
  assert.throws(() => rutaDescargaSegura(BASE, '/api/%2e%2e/login'));
  assert.throws(() => rutaDescargaSegura(BASE, '/api/x y'));
  assert.throws(() => rutaDescargaSegura(BASE, '/api/x\n'));
  assert.throws(() => rutaDescargaSegura(BASE, ''));
  assert.throws(() => rutaDescargaSegura(BASE, '/api/' + 'a'.repeat(600)));
  assert.throws(() => rutaDescargaSegura('no-url', '/api/x'));
});

test('el token solo viaja por https o a esta misma PC', () => {
  assert.ok(tokenPermitido('https://app.reslez.com'));
  assert.ok(tokenPermitido('http://localhost:3000'));
  assert.ok(tokenPermitido('http://127.0.0.1:3000'));
  assert.ok(!tokenPermitido('http://192.168.1.50:3000'));
  assert.ok(!tokenPermitido('http://app.reslez.com'));
  assert.ok(!tokenPermitido(''));
});

test('esUuid', () => {
  assert.ok(esUuid('5f0c8a2e-1b2c-4d3e-8f90-123456789abc'));
  assert.ok(!esUuid('../../x'));
  assert.ok(!esUuid(''));
  assert.ok(!esUuid(undefined));
});

test('la ventana de configuración solo guarda campos válidos', () => {
  const v = validarConfigEntrante({
    printerName: ' POS-80C ',
    printerInterface: 'usb',
    modoTicket: 'pdf',
    serialPort: 'COM3',
    networkHost: '192.168.1.100',
    networkPort: '9100',
    serverUrl: 'https://app.reslez.com/pos/',
    notificaciones: false,
    // Lo que NO se puede poner desde la ventana:
    origenesPermitidos: ['https://evil.example'],
    permitirOrigenLocal: true,
  });
  assert.deepStrictEqual(v, {
    printerName: 'POS-80C',
    printerInterface: 'usb',
    modoTicket: 'pdf',
    serialPort: 'COM3',
    networkHost: '192.168.1.100',
    networkPort: 9100,
    serverUrl: 'https://app.reslez.com',
    notificaciones: false,
  });
});

test('valores basura se descartan', () => {
  const v = validarConfigEntrante({
    printerInterface: 'bluetooth', modoTicket: 'raw', networkPort: 99999, serverUrl: 'javascript:alert(1)',
    printerName: 'x'.repeat(500), notificaciones: 'si',
  });
  assert.deepStrictEqual(v, {});
  assert.strictEqual(validarConfigEntrante(null), null);
  assert.strictEqual(validarConfigEntrante([1, 2]), null);
  assert.strictEqual(validarConfigEntrante('x'), null);
});

test('IPC solo desde assets/config.html', () => {
  assert.ok(esVentanaConfig('file:///C:/Program%20Files/FactuFAST%20PrintAgent/resources/app.asar/assets/config.html'));
  assert.ok(!esVentanaConfig('https://app.reslez.com/assets/config.html'));
  assert.ok(!esVentanaConfig('file:///C:/tmp/evil.html'));
  assert.ok(!esVentanaConfig(undefined));
});
