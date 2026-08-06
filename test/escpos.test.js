// Tests de las piezas puras ESC/POS. Corre con: npm test (tsc && node --test)
const { test } = require('node:test');
const assert = require('node:assert');
const {
  DRAWER_KICK,
  ESC_POS_DRAWER_PIN2,
  ESC_POS_DRAWER_PIN5,
  construirTicketPrueba,
  parseCuponIds,
  buildWinspoolScript,
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

// ── buildWinspoolScript ──────────────────────────────────────────────────────
// El bug que arregla v1.4.0: los bytes iban incrustados como hex en la línea de
// comandos (~5 caracteres por byte) contra el techo de 32.767 de CreateProcess, así
// que solo cabían payloads de pocos KB. El cajón y el recibo de prueba pasaban; toda
// factura real fallaba y terminaba imprimiéndose por PDF (donde sale recortada).

test('buildWinspoolScript lee los bytes de un ARCHIVO, no incrustados en el script', () => {
  const ps = buildWinspoolScript('C:\\Temp\\ff_raw_1.bin', 'RONGTA 80mm Series Printer');
  assert.ok(ps.includes("[System.IO.File]::ReadAllBytes('C:\\Temp\\ff_raw_1.bin')"));
  assert.ok(!/\[byte\[\]\]@\(/.test(ps), 'no debe declarar el array de bytes inline');
  assert.ok(!/0x[0-9a-f]{2},0x[0-9a-f]{2}/i.test(ps), 'no debe contener hex de datos');
});

test('buildWinspoolScript es de tamaño constante: 300 KB de ticket no inflan el comando', () => {
  const ps = buildWinspoolScript('C:\\Temp\\ff_raw_grande.bin', 'RONGTA 80mm Series Printer');
  // Muy por debajo del límite de línea de comandos de Windows (32.767 caracteres),
  // y sobre todo INDEPENDIENTE del tamaño del ticket.
  assert.ok(ps.length < 4000, `script de ${ps.length} caracteres`);
});

test('buildWinspoolScript escapa las comillas simples de la ruta y del nombre', () => {
  const ps = buildWinspoolScript("C:\\Te'mp\\a.bin", "Cajero's Printer");
  assert.ok(ps.includes("ReadAllBytes('C:\\Te''mp\\a.bin')"));
  assert.ok(ps.includes("OpenPrinter('Cajero''s Printer'"));
});

test('buildWinspoolScript conserva el endurecimiento de v1.2.1 (StructLayout + verificaciones)', () => {
  const ps = buildWinspoolScript('C:\\Temp\\a.bin', 'P');
  // Sin CharSet=Auto las cadenas se marshalean ANSI → el documento nunca inicia y
  // WritePrinter escribe 0 bytes sin reportar error ("OK" falso, sin papel).
  assert.ok(ps.includes('StructLayout(LayoutKind.Sequential, CharSet=CharSet.Auto)'));
  assert.ok(ps.includes('$job -eq 0'), 'debe verificar el jobId de StartDocPrinter');
  assert.ok(ps.includes('$written -ne $bytes.Length'), 'debe verificar los bytes escritos');
  assert.ok(ps.trimEnd().endsWith("Write-Output 'OK'"));
});

test('parseCuponIds normaliza string, array y vacíos', () => {
  assert.deepStrictEqual(parseCuponIds('a, b ,c'), ['a', 'b', 'c']);
  assert.deepStrictEqual(parseCuponIds(['a,b', 'c']), ['a', 'b', 'c']);
  assert.deepStrictEqual(parseCuponIds(''), []);
  assert.deepStrictEqual(parseCuponIds(undefined), []);
  assert.deepStrictEqual(parseCuponIds(' , , '), []);
});
