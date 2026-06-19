// Descarga vendor/SumatraPDF.exe si falta, para que `npm run dev` / build local
// no se rompan. En CI el workflow ya lo descarga; en el instalador va empaquetado.
// Es idempotente y NUNCA falla el install (best-effort).
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = 'https://www.sumatrapdfreader.org/dl/rel/3.5.2/SumatraPDF-3.5.2-64.exe';
const destDir = path.join(__dirname, '..', 'vendor');
const dest = path.join(destDir, 'SumatraPDF.exe');

function ya() {
  try { return fs.statSync(dest).size > 1_000_000; } catch { return false; }
}

if (ya()) {
  console.log('[ensure-sumatra] vendor/SumatraPDF.exe ya presente — ok');
  process.exit(0);
}

fs.mkdirSync(destDir, { recursive: true });
console.log('[ensure-sumatra] descargando SumatraPDF.exe...');

function descargar(url, redirecciones = 0) {
  if (redirecciones > 5) { console.warn('[ensure-sumatra] demasiadas redirecciones — omitido'); return; }
  https.get(url, (res) => {
    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return descargar(res.headers.location, redirecciones + 1);
    }
    if (res.statusCode !== 200) {
      console.warn(`[ensure-sumatra] HTTP ${res.statusCode} — omitido (descárgalo manualmente a vendor/)`);
      res.resume();
      return;
    }
    const file = fs.createWriteStream(dest);
    res.pipe(file);
    file.on('finish', () => { file.close(); console.log('[ensure-sumatra] descargado OK'); });
    file.on('error', () => { try { fs.unlinkSync(dest); } catch {} });
  }).on('error', (e) => {
    console.warn('[ensure-sumatra] sin red — omitido:', e.message);
  });
}

descargar(URL);
