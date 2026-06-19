// Tests de las piezas puras ESC/POS. Corre con: npm test (tsc && node --test)
const { test } = require('node:test');
const assert = require('node:assert');
const {
  DRAWER_KICK,
  ESC_POS_DRAWER_PIN2,
  ESC_POS_DRAWER_PIN5,
  construirTicketPrueba,
  parseCuponIds,
} = require('../dist/escpos.js');

test('DRAWER_KICK = pin2 + pin5 (10 bytes, secuencias ESC p correctas)', () => {
  assert.strictEqual(DRAWER_KICK.length, 10);
  assert.deepStrictEqual([...ESC_POS_DRAWER_PIN2], [0x1b, 0x70, 0x00, 0x3c, 0x3c]);
  assert.deepStrictEqual([...ESC_POS_DRAWER_PIN5], [0x1b, 0x70, 0x01, 0x3c, 0x3c]);
  assert.deepStrictEqual([...DRAWER_KICK].slice(0, 5), [...ESC_POS_DRAWER_PIN2]);
});

test('construirTicketPrueba emite init (ESC @) y corte (GS V 0)', () => {
  const buf = construirTicketPrueba({ printerName: 'EPSON TM-T20', printerInterface: 'usb' });
  assert.ok(Buffer.isBuffer(buf));
  assert.deepStrictEqual([...buf.subarray(0, 2)], [0x1b, 0x40]); // ESC @
  assert.deepStrictEqual([...buf.subarray(buf.length - 3)], [0x1d, 0x56, 0x00]); // GS V 0
  assert.ok(buf.toString('latin1').includes('EPSON TM-T20'));
});

test('parseCuponIds normaliza string, array y vacíos', () => {
  assert.deepStrictEqual(parseCuponIds('a, b ,c'), ['a', 'b', 'c']);
  assert.deepStrictEqual(parseCuponIds(['a,b', 'c']), ['a', 'b', 'c']);
  assert.deepStrictEqual(parseCuponIds(''), []);
  assert.deepStrictEqual(parseCuponIds(undefined), []);
  assert.deepStrictEqual(parseCuponIds(' , , '), []);
});
