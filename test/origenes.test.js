// Orígenes permitidos y servidor de descarga (v1.6.0). Corre con: npm test
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
});

test('caja con el agente apuntando al dominio VIEJO entra por el NUEVO → se acepta', () => {
  assert.ok(origenPermitido(NUEVO, VIEJO));
  assert.ok(origenPermitido(VIEJO, NUEVO));
  assert.ok(origenPermitido('https://beta.reslez.com', VIEJO));
});

test('el serverUrl configurado sigue valiendo aunque no sea de la plataforma, con o sin barra', () => {
  assert.ok(origenPermitido('https://otra.empresa.com', 'https://otra.empresa.com/'));
});

test('un origen ajeno NO se acepta', () => {
  assert.ok(!origenPermitido('https://evil.com', VIEJO));
  assert.ok(!origenPermitido('https://app.reslez.com.evil.com', VIEJO));
  assert.ok(!origenPermitido('http://app.reslez.com', VIEJO), 'http, no https');
});

test('localhost por igualdad exacta de host (antes bastaba el prefijo)', () => {
  assert.ok(esOrigenLocal('http://localhost:3000'));
  assert.ok(esOrigenLocal('http://127.0.0.1:7979'));
  assert.ok(!esOrigenLocal('http://localhost.evil.com'));
  assert.ok(!origenPermitido('http://localhost.evil.com', VIEJO));
});

test('sin Origin (curl, procesos locales) se acepta', () => {
  assert.ok(origenPermitido(undefined, VIEJO));
  assert.ok(origenPermitido('', VIEJO));
});

test('orígenes extra de config.json', () => {
  assert.ok(origenPermitido('https://pruebas.ejemplo.com', VIEJO, ['https://pruebas.ejemplo.com/']));
});

test('descarga del MISMO origen que pidió la impresión', () => {
  assert.strictEqual(baseDescarga(NUEVO, VIEJO), NUEVO);
  assert.strictEqual(baseDescarga(VIEJO, NUEVO), VIEJO);
});

test('sin Origin o con uno ajeno, descarga del serverUrl (sin barra final)', () => {
  assert.strictEqual(baseDescarga(undefined, 'https://www.serviplast.pro/'), VIEJO);
  assert.strictEqual(baseDescarga('https://evil.com', VIEJO), VIEJO);
  assert.strictEqual(baseDescarga(undefined, 'http://localhost:3000'), 'http://localhost:3000');
});

test('la lista de la plataforma incluye el dominio nuevo y el viejo', () => {
  assert.ok(ORIGENES_PLATAFORMA.includes(NUEVO));
  assert.ok(ORIGENES_PLATAFORMA.includes(VIEJO));
});
