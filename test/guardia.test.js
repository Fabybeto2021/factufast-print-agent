// Guardia del servidor local (v1.7.0). Corre con: npm test
//
// Lo que esta prueba fija: una página ajena abierta en la PC de caja NO puede abrir el
// cajón ni imprimir, y el POS de la plataforma sigue pudiendo.
const { test } = require('node:test');
const assert = require('node:assert');
const { evaluarPeticion, hostValido, esJson, crearFrenoRegistro } = require('../dist/guardia.js');

const OPC = { puerto: 7979, serverUrl: 'https://app.reslez.com', extra: [] };
const POS = 'https://app.reslez.com';

function pedir(extra) {
  return evaluarPeticion({ metodo: 'POST', host: '127.0.0.1:7979', contentType: 'application/json', ...extra }, OPC);
}

test('el POS de la plataforma imprime (POST JSON con su Origin)', () => {
  const v = pedir({ origin: POS });
  assert.deepStrictEqual(v, { ok: true, origenPermitido: true });
  assert.ok(pedir({ origin: 'https://beta.reslez.com' }).ok);
  assert.ok(pedir({ origin: POS, contentType: 'application/json; charset=utf-8' }).ok);
});

test('el preflight del POS pasa (OPTIONS sin Content-Type)', () => {
  const v = evaluarPeticion({ metodo: 'OPTIONS', host: 'localhost:7979', origin: POS }, OPC);
  assert.ok(v.ok);
});

test('POST /selftest sin cuerpo desde otra página → 415 (era lo que abría el cajón)', () => {
  // Un formulario o un fetch "simple" de otra página: sin JSON, con su Origin.
  const v = pedir({ origin: 'https://evil.example', contentType: 'text/plain' });
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.status, 403, 'el origen ajeno se corta primero');
  // Aun sin Origin, sin JSON no pasa.
  const sinOrigen = pedir({ contentType: undefined });
  assert.strictEqual(sinOrigen.ok, false);
  assert.strictEqual(sinOrigen.status, 415);
  assert.strictEqual(pedir({ contentType: 'application/x-www-form-urlencoded' }).status, 415);
  assert.strictEqual(pedir({ contentType: 'multipart/form-data; boundary=x' }).status, 415);
});

test('cualquier método con un Origin ajeno → 403', () => {
  for (const metodo of ['GET', 'POST', 'OPTIONS']) {
    const v = evaluarPeticion({ metodo, host: '127.0.0.1:7979', origin: 'https://evil.example', contentType: 'application/json' }, OPC);
    assert.strictEqual(v.ok, false, metodo);
    assert.strictEqual(v.status, 403, metodo);
  }
});

test('la web del cliente en serviplast.pro ya no es la plataforma → 403', () => {
  assert.strictEqual(pedir({ origin: 'https://www.serviplast.pro' }).status, 403);
  assert.strictEqual(pedir({ origin: 'https://serviplast.pro' }).status, 403);
});

test('un archivo local (Origin "null") → 403', () => {
  assert.strictEqual(pedir({ origin: 'null' }).status, 403);
});

test('DNS rebinding: Host distinto de 127.0.0.1/localhost → 403', () => {
  const v = evaluarPeticion({ metodo: 'GET', host: 'evil.example:7979' }, OPC);
  assert.strictEqual(v.status, 403);
  assert.strictEqual(evaluarPeticion({ metodo: 'GET', host: '127.0.0.1:8080' }, OPC).status, 403);
  assert.strictEqual(evaluarPeticion({ metodo: 'GET', host: undefined }, OPC).status, 403);
  assert.ok(hostValido('LOCALHOST:7979', 7979));
});

test('sin Origin pero desde otra página (Sec-Fetch-Site: cross-site) → 403', () => {
  // <img src="http://127.0.0.1:7979/status"> o un enlace.
  const v = evaluarPeticion({ metodo: 'GET', host: '127.0.0.1:7979', secFetchSite: 'cross-site' }, OPC);
  assert.strictEqual(v.status, 403);
});

test('curl y los procesos locales (sin Origin ni Sec-Fetch-Site) siguen funcionando', () => {
  assert.ok(evaluarPeticion({ metodo: 'GET', host: '127.0.0.1:7979' }, OPC).ok);
  assert.ok(pedir({}).ok, 'POST JSON local (FactuFAST Desktop desde su proceso principal)');
  assert.ok(evaluarPeticion({ metodo: 'GET', host: '127.0.0.1:7979', secFetchSite: 'none' }, OPC).ok);
});

test('localhost de desarrollo solo con permitirOrigenLocal', () => {
  const opc = { ...OPC };
  assert.strictEqual(evaluarPeticion({ metodo: 'POST', host: '127.0.0.1:7979', origin: 'http://localhost:5173', contentType: 'application/json' }, opc).status, 403);
  const v = evaluarPeticion(
    { metodo: 'POST', host: '127.0.0.1:7979', origin: 'http://localhost:5173', contentType: 'application/json' },
    { ...opc, permitirOrigenLocal: true },
  );
  assert.ok(v.ok);
});

test('esJson', () => {
  assert.ok(esJson('application/json'));
  assert.ok(esJson('Application/JSON; charset=UTF-8'));
  assert.ok(!esJson('text/plain'));
  assert.ok(!esJson(undefined));
  assert.ok(!esJson('application/jsonp'));
});

test('el 415 al POS de la plataforma lleva origenPermitido (para sus cabeceras CORS)', () => {
  // La web vieja manda /selftest sin JSON: el rechazo tiene que llegarle legible, no como
  // «no se pudo contactar al agente».
  const v = pedir({ origin: POS, contentType: 'text/plain' });
  assert.strictEqual(v.status, 415);
  assert.strictEqual(v.origenPermitido, true);
  assert.strictEqual(pedir({ origin: 'https://evil.example' }).origenPermitido, false);
});

test('freno del registro: una línea por motivo y minuto, con lo omitido', () => {
  const freno = crearFrenoRegistro(60_000, 3);
  assert.strictEqual(freno('A', 0), 'A');
  assert.strictEqual(freno('A', 1_000), null);
  assert.strictEqual(freno('A', 2_000), null);
  assert.strictEqual(freno('A', 61_000), 'A (+2 omitidos)');
  assert.strictEqual(freno('B', 61_000), 'B');
  assert.strictEqual(freno('C', 61_000), 'C');
  // Lleno: los motivos nuevos se cuentan juntos y la memoria no crece.
  assert.strictEqual(freno('D', 61_000), 'D');
  assert.strictEqual(freno('E', 62_000), null);
  assert.strictEqual(freno('F', 130_000), 'F (+1 omitidos)');
});