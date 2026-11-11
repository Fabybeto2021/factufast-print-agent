// Orígenes permitidos y servidor de descarga (v1.6.0 → v1.7.0). Corre con: npm test
const { test } = require('node:test');
const assert = require('node:assert');
const {
  ORIGENES_PLATAFORMA, normalizarOrigen, esOrigenLocal, origenPermitido, baseDescarga,
} = require('../dist/origenes.js');

const VIEJO = 'https://www.serviplast.pro';
const NUEVO = 'https://app.reslez.com';

test('normaliza mayúsculas, puerto por defecto, ruta y barra final', () => {
  assert.strictEqual(normalizarOrigen('HTTPS://App.Reslez.com:443/pos/'), NUEVO);
  assert.strictEqual(normalizarOrigen('https://www.serviplast.pro/'), VIEJO);
  assert.strictEqual(normalizarOrigen('ftp://x.com'), '');
  assert.strictEqual(normalizarOrigen('no es url'), '');
  assert.strictEqual(normalizarOrigen(''), '');
  assert.strictEqual(normalizarOrigen('null'), '', 'el Origin de un file:// no es un origen');
});

test('los dominios de la plataforma se aceptan aunque el agente apunte a otro', () => {
  assert.ok(origenPermitido(NUEVO, 'https://beta.reslez.com'));
  assert.ok(origenPermitido('https://beta.reslez.com', NUEVO));
});

test('v1.7.0: serviplast.pro es la web de un cliente — NUNCA se acepta', () => {
  assert.ok(!ORIGENES_PLATAFORMA.includes(VIEJO));
  assert.ok(!ORIGENES_PLATAFORMA.includes('https://serviplast.pro'));
  assert.ok(!origenPermitido(VIEJO, NUEVO));
  assert.ok(!origenPermitido('https://serviplast.pro', NUEVO));
  // Ni aunque esté escrito como serverUrl o en los orígenes extra.
  assert.ok(!origenPermitido(VIEJO, VIEJO));
  assert.ok(!origenPermitido(VIEJO, NUEVO, [VIEJO]));
});

test('el serverUrl configurado sigue valiendo aunque no sea de la plataforma, con o sin barra', () => {
  assert.ok(origenPermitido('https://otra.empresa.com', 'https://otra.empresa.com/'));
});

test('un origen ajeno NO se acepta', () => {
  assert.ok(!origenPermitido('https://evil.com', NUEVO));
  assert.ok(!origenPermitido('https://app.reslez.com.evil.com', NUEVO));
  assert.ok(!origenPermitido('http://app.reslez.com', NUEVO), 'http, no https');
  assert.ok(!origenPermitido('https://temp.reslez.com', NUEVO), 'subdominio de archivos subidos');
  assert.ok(!origenPermitido('null', NUEVO));
});

test('localhost por igualdad exacta de host', () => {
  assert.ok(esOrigenLocal('http://localhost:3000'));
  assert.ok(esOrigenLocal('http://127.0.0.1:7979'));
  assert.ok(!esOrigenLocal('http://localhost.evil.com'));
});

test('v1.7.0: cualquier localhost solo con permitirLocal (desarrollo)', () => {
  assert.ok(!origenPermitido('http://localhost:5173', NUEVO));
  assert.ok(origenPermitido('http://localhost:5173', NUEVO, [], { permitirLocal: true }));
  assert.ok(!origenPermitido('http://localhost.evil.com', NUEVO, [], { permitirLocal: true }));
  // Un serverUrl local tampoco basta: hasta la 1.6.0 era el valor por defecto, y un agente
  // nunca configurado le abría el cajón a cualquier página del puerto 3000 de la PC.
  assert.ok(!origenPermitido('http://localhost:3000', 'http://localhost:3000'));
  assert.ok(origenPermitido('http://localhost:3000', 'http://localhost:3000', [], { permitirLocal: true }));
});

test('sin Origin (curl, procesos locales) se acepta — lo filtra la guardia', () => {
  assert.ok(origenPermitido(undefined, NUEVO));
  assert.ok(origenPermitido('', NUEVO));
});

test('orígenes extra de config.json', () => {
  assert.ok(origenPermitido('https://pruebas.ejemplo.com', NUEVO, ['https://pruebas.ejemplo.com/']));
});

test('descarga del MISMO origen que pidió la impresión', () => {
  assert.strictEqual(baseDescarga(NUEVO, 'https://beta.reslez.com'), NUEVO);
  assert.strictEqual(baseDescarga('https://beta.reslez.com', NUEVO), 'https://beta.reslez.com');
});

test('sin Origin o con uno ajeno, descarga del serverUrl (sin barra final)', () => {
  assert.strictEqual(baseDescarga(undefined, 'https://app.reslez.com/'), NUEVO);
  assert.strictEqual(baseDescarga('https://evil.com', NUEVO), NUEVO);
  assert.strictEqual(baseDescarga(undefined, 'http://localhost:3000'), 'http://localhost:3000');
});

test('v1.7.0: con serverUrl retirado, la descarga va al dominio actual', () => {
  assert.strictEqual(baseDescarga(undefined, VIEJO), NUEVO);
  assert.strictEqual(baseDescarga(VIEJO, VIEJO), NUEVO);
});

test('un agente con el dominio retirado (serviplast.pro) pasa solo a app.reslez.com', () => {
  const { migrarServerUrl, SERVIDOR_ACTUAL } = require('../dist/origenes.js');
  assert.strictEqual(SERVIDOR_ACTUAL, NUEVO);
  assert.strictEqual(migrarServerUrl(VIEJO), NUEVO);
  assert.strictEqual(migrarServerUrl('https://serviplast.pro/'), NUEVO);
  assert.strictEqual(migrarServerUrl('HTTPS://WWW.SERVIPLAST.PRO:443'), NUEVO);
  // Lo demás no se toca.
  assert.strictEqual(migrarServerUrl('https://beta.reslez.com'), 'https://beta.reslez.com');
  assert.strictEqual(migrarServerUrl('http://192.168.1.50:3000'), 'http://192.168.1.50:3000');
  assert.strictEqual(migrarServerUrl('https://otro.serviplast.pro'), 'https://otro.serviplast.pro');
  assert.strictEqual(migrarServerUrl(''), '');
});
