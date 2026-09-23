# Installs the current Node.js LTS on Windows, verifying the installer against
# the SHA-256 checksums published by nodejs.org. Used by the first-time setup.

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host '[*] Looking up the current Node.js LTS release...'
$release = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' | Where-Object { $_.lts } | Select-Object -First 1
if (-not $release) { throw 'Could not determine the latest Node.js LTS version.' }
$version = $release.version

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$file = "node-$version-$arch.msi"
$installer = Join-Path $env:TEMP $file

Write-Host "[*] Downloading Node.js $version ($arch)..."
Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/$file" -OutFile $installer -UseBasicParsing

Write-Host '[*] Verifying download...'
$sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$version/SHASUMS256.txt" -UseBasicParsing).Content
$line = ($sums -split "`n") | Where-Object { $_ -match "\s$([regex]::Escape($file))\s*$" } | Select-Object -First 1
if (-not $line) { throw "No published checksum found for $file." }
$expected = ($line -split '\s+')[0]
$actual = (Get-FileHash -Path $installer -Algorithm SHA256).Hash
if ($actual -ne $expected) {
  Remove-Item $installer -Force
  throw 'Checksum mismatch - the download may be corrupted.'
}

Write-Host '[*] Running the Node.js installer (click Yes if Windows asks for permission)...'
$proc = Start-Process -FilePath 'msiexec.exe' -ArgumentList '/i', "`"$installer`"", '/passive', '/norestart' -Wait -PassThru
Remove-Item $installer -Force -ErrorAction SilentlyContinue
if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) { throw "Installer exited with code $($proc.ExitCode)." }
