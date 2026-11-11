<#
.SYNOPSIS
  Prepara la 1.8.0 del agente: Electron 28 → 44 y fuses en el ejecutable.

.DESCRIPTION
  Va DESPUÉS de publicar la 1.7.0 (la corrección de seguridad sale primero y sola; el
  salto de Electron es el cambio más grande y se prueba aparte).

  Probado el 10-nov-2026 en una copia del repo: compila con los tipos de Electron 44,
  pasan las 42 pruebas, electron-builder 26 empaqueta (@serialport/bindings-cpp sin
  recompilar: es N-API) y los fuses quedan aplicados. FALTA probarlo en una PC de caja de
  prueba: imprimir un ticket, abrir el cajón, «Probar impresora», y que una 1.7.0 instalada
  se actualice sola a la 1.8.0.

  Qué cambia:
  - electron 44.10.2 y electron-builder 26.18.1 (versiones EXACTAS), @types/node 22, Node ≥ 22.
  - Fuses: sin ELECTRON_RUN_AS_NODE, sin --inspect, sin NODE_OPTIONS, solo carga su app.asar
    con integridad verificada, cookies cifradas. El CI los comprueba (ver release.yml).
  - Se quita electron-packager (abandonado): `dist:win` / `dist:linux` usan electron-builder --dir.

.EXAMPLE
  .\scripts\preparar-1.8.0.ps1
  npm test
  npx electron-builder --win --dir --publish never
  npx --no-install electron-fuses read --app "release\win-unpacked\FactuFAST PrintAgent.exe"
#>
#Requires -Version 7
# PowerShell 7: en la 5.1 ConvertTo-Json escapa caracteres y Set-Content escribe con BOM, y
# un package.json con BOM hace que el agente anuncie la versión 1.0.0.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$p = Get-Content package.json -Raw | ConvertFrom-Json
if ($p.version -ne '1.7.0') { throw "Se esperaba la 1.7.0 publicada; package.json dice $($p.version)." }

$p.version = '1.8.0'
$p.devDependencies.electron = '44.10.2'
$p.devDependencies.'electron-builder' = '26.18.1'
$p.devDependencies.'@types/node' = '^22.18.0'
$p.devDependencies.PSObject.Properties.Remove('electron-packager')
$p.scripts.'dist:win' = 'npm run build && electron-builder --win --dir --publish never'
$p.scripts.'dist:linux' = 'npm run build && electron-builder --linux --dir --publish never'
$p.scripts.PSObject.Properties.Remove('dist:all')
$p | Add-Member -NotePropertyName engines -NotePropertyValue ([ordered]@{ node = '>=22' }) -Force
$p.build | Add-Member -NotePropertyName electronFuses -Force -NotePropertyValue ([ordered]@{
  runAsNode                             = $false
  enableNodeCliInspectArguments         = $false
  enableNodeOptionsEnvironmentVariable  = $false
  onlyLoadAppFromAsar                   = $true
  enableEmbeddedAsarIntegrityValidation = $true
  enableCookieEncryption                = $true
  grantFileProtocolExtraPrivileges      = $false
})
[IO.File]::WriteAllText((Join-Path (Get-Location) 'package.json'), ($p | ConvertTo-Json -Depth 10) + "`n", [Text.UTF8Encoding]::new($false))

npm install
if ($LASTEXITCODE -ne 0) { throw 'npm install falló' }
Write-Host "`nListo. Sigue con: npm test · npx electron-builder --win --dir · leer los fuses (ver .EXAMPLE)." -ForegroundColor Green
Write-Host 'El CI (release.yml) ya comprueba los fuses en cuanto package.json los declara.' -ForegroundColor Gray
