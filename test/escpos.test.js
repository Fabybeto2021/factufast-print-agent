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
  construirRasterPrueba,
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

// ── construirRasterPrueba ────────────────────────────────────────────────────
// El recibo de texto (~250 bytes) pasa siempre, incluso en una caja donde toda factura
// real sale mal: fue lo que escondió el fallo de transporte de v1.3.x y lo que dejó sin
// diagnosticar la impresora de SPPLAST. Esta prueba ejercita el camino REAL del ticket
// fiscal (ráster GS v 0 en bandas), así que su forma tiene que ser la misma.

/** Camina el flujo y devuelve las bandas, avances y filas totales. */
function leerRaster(buf) {
  const r = { bandas: [], avances: [], filas: 0, mayorPayload: 0, anchoBytes: null };
  for (let i = 0; i < buf.length; ) {
    if (buf[i] === 0x1d && buf[i + 1] === 0x76 && buf[i + 2] === 0x30) {
      const anchoBytes = buf[i + 4] | (buf[i + 5] << 8);
      const rows = buf[i + 6] | (buf[i + 7] << 8);
      r.anchoBytes = anchoBytes;
      r.bandas.push(rows);
      r.filas += rows;
      r.mayorPayload = Math.max(r.mayorPayload, anchoBytes * rows);
      i += 8 + anchoBytes * rows;
    } else if (buf[i] === 0x1b && buf[i + 1] === 0x4a) {
      r.avances.push(buf[i + 2]);
      r.filas += buf[i + 2];
      i += 3;
    } else {
      i++;
    }
  }
  return r;
}

test('construirRasterPrueba emite exactamente las filas pedidas (bandas + avances)', () => {
  const buf = construirRasterPrueba({ filas: 400, titulo: 'PRUEBA' });
  const r = leerRaster(buf);
  assert.strictEqual(r.filas, 400, 'el papel avanzado debe ser el alto pedido');
  assert.strictEqual(r.anchoBytes, 72, '576 puntos = 72 bytes por fila');
  assert.ok(r.avances.length > 0, 'debe ejercitar el avance ESC J de los huecos en blanco');
});

test('ninguna banda supera el buffer de una térmica barata', () => {
  const r = leerRaster(construirRasterPrueba({ filas: 2400, titulo: 'LARGO' }));
  // Espejo de BAND_HEIGHT en el servidor (png-a-escpos.ts): 24 filas × 72 bytes = 1.728.
  assert.ok(Math.max(...r.bandas) <= 24, 'bandas de 24 filas como mucho');
  assert.ok(r.mayorPayload <= 2048, `payload máximo ${r.mayorPayload} > 2 KB`);
});

test('el ráster de prueba se rotula y se corta, y fija la unidad de avance', () => {
  const buf = construirRasterPrueba({ filas: 400, titulo: 'PRUEBA DE RASTER (corto)' });
  const txt = buf.toString('latin1');
  assert.deepStrictEqual([...buf.subarray(0, 2)], [0x1b, 0x40]);        // ESC @
  assert.deepStrictEqual([...buf.subarray(2, 6)], [0x1d, 0x50, 203, 203]); // GS P 203 203
  assert.ok(txt.includes('PRUEBA DE RASTER (corto)'));
  // Si el rótulo final sale impreso pero el dibujo salió como caracteres, la impresora
  // perdió la sincronía DENTRO de un GS v 0 — el fallo que se está buscando.
  assert.ok(txt.includes('FIN OK'));
  assert.deepStrictEqual([...buf.subarray(buf.length - 3)], [0x1d, 0x56, 0x00]); // GS V 0
});
