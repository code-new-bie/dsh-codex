param(
  [Parameter(Mandatory = $true)]
  [string]$Tarball,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedSha256,

  [string]$Prefix = (Join-Path $env:TEMP 'dshx-rc-acceptance')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$artifact = (Resolve-Path -LiteralPath $Tarball).Path
$expected = $ExpectedSha256.Trim().ToLowerInvariant()
if ($expected -notmatch '^[0-9a-f]{64}$') {
  throw 'ExpectedSha256 must be exactly 64 hexadecimal characters.'
}

$actual = (Get-FileHash -LiteralPath $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) {
  throw "RC artifact SHA-256 mismatch. expected=$expected actual=$actual"
}

if (Test-Path -LiteralPath $Prefix) {
  Remove-Item -LiteralPath $Prefix -Recurse -Force
}
New-Item -ItemType Directory -Path $Prefix -Force | Out-Null

npm install --global --prefix $Prefix $artifact
if ($LASTEXITCODE -ne 0) {
  throw "npm failed to install RC artifact $artifact"
}

$dshx = Join-Path $Prefix 'dshx.cmd'
if (-not (Test-Path -LiteralPath $dshx)) {
  throw "installed dshx launcher not found: $dshx"
}

# This is a thin DSH profile launcher; it intentionally has no private
# `doctor` control plane. `--version` crosses the same official DSH profile and
# native TUI startup path while terminating before an interactive session.
$version = (& $dshx --version | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) {
  throw 'installed dshx --version failed; verify that official DeepSeek Harness is installed and resolvable'
}

Write-Host ''
Write-Host 'DSHX RC Windows acceptance setup passed.'
Write-Host "Artifact: $artifact"
Write-Host "SHA-256:  $actual"
Write-Host "Version:  $version"
Write-Host "Launcher: $dshx"
Write-Host ''
Write-Host 'Use this exact launcher in the project directory for Windows Terminal/IME acceptance:'
Write-Host "  & '$dshx'"
Write-Host ''
Write-Host 'Do not replace the generated artifact with a source checkout during IME/visual acceptance.'
