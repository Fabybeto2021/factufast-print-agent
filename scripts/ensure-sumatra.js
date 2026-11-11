// Descarga vendor/SumatraPDF.exe si falta y COMPRUEBA su huella SHA-256.
//
// SumatraPDF va DENTRO del instalador del agente y se ejecuta en cada caja para
// imprimir: un binario cambiado en el servidor de descarga (o en el camino) acabaría
// en toda la flota con la próxima actualización automática. Por eso se fija la huella.
// La de abajo se comprobó el 10-nov-2026 con dos descargas independientes del sitio
// oficial, ambas con la firma Authenticode válida de su autor (Krzysztof Kowalczyk).
//
// Para pasar a otra versión de SumatraPDF: cambiar URL y HUELLA juntas, comprobando
// antes la firma del .exe nuevo (Get-AuthenticodeSignature en Windows).
//
// Uso:
//   node scripts/ensure-sumatra.js             → best-effort (postinstall): nunca rompe el install
//   node scripts/ensure-sumatra.js --estricto  → CI: sale con 1 si no puede dejar el archivo correcto
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = 'https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64.exe';
const HUELLA = '290e4aa7ed64c728138711c011e89aab7aa48dbc1ae430371dc2be4100b92bf0';
const estricto = process.argv.includes('--estricto');
const destDir = path.join(__dirname, '..', 'vendor');
const dest = path.join(destDir, 'SumatraPDF.exe');

function huellaDe(ruta) {
  return crypto.createHash('sha256').update(fs.readFileSync(ruta)).digest('hex');
}

function terminar(ok, mensaje) {
  (ok ? console.log : console.warn)(`[ensure-sumatra] ${mensaje}`);
  process.exit(ok || !estricto ? 0 : 1);
}

if (fs.existsSync(dest)) {
  if (huellaDe(dest) === HUELLA) terminar(true, 'vendor/SumatraPDF.exe presente y con la huella esperada — ok');
  console.warn('[ensure-sumatra] vendor/SumatraPDF.exe NO tiene la huella esperada: se reemplaza');
  fs.rmSync(dest, { force: true });
}

fs.mkdirSync(destDir, { recursive: true });
console.log('[ensure-sumatra] descargando SumatraPDF.exe...');

function descargar(url, redirecciones = 0) {
  if (redirecciones > 5) return terminar(false, 'demasiadas redirecciones');
  // Solo https: una redirección a http dejaría el binario expuesto en el camino.
  if (!url.startsWith('https://')) return terminar(false, `redirección no segura: ${url}`);
  https.get(url, (res) => {
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return descargar(new globalThis.URL(res.headers.location, url).toString(), redirecciones + 1);
    }
    if (res.statusCode !== 200) {
      res.resume();
      return terminar(false, `HTTP ${res.statusCode} (descárgalo a mano a vendor/ y vuelve a correr el script)`);
    }
    // A un archivo temporal: el definitivo solo aparece si la huella coincide.
    const tmp = `${dest}.descarga`;
    const file = fs.createWriteStream(tmp);
    res.pipe(file);
    file.on('finish', () => {
      file.close(() => {
        const h = huellaDe(tmp);
        if (h !== HUELLA) {
          fs.rmSync(tmp, { force: true });
          return terminar(false, `la descarga NO tiene la huella esperada (${h}); no se usa`);
        }
        fs.renameSync(tmp, dest);
        terminar(true, 'descargado y comprobado OK');
      });
    });
    file.on('error', (e) => { fs.rmSync(tmp, { force: true }); terminar(false, `no se pudo escribir: ${e.message}`); });
  }).on('error', (e) => terminar(false, `sin red — omitido: ${e.message}`));
}

descargar(URL);
