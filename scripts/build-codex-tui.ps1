$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
& (Join-Path $Root 'scripts\materialize-codex.ps1')
$CodeXDir = if ($env:DSHX_CODEX_DIR) { $env:DSHX_CODEX_DIR } else { Join-Path $Root '.upstream\codex' }
$TargetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $Root '.build\codex' }
$OutDir = if ($env:DSHX_TUI_OUT_DIR) { $env:DSHX_TUI_OUT_DIR } else { Join-Path $Root 'dist\bin' }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$env:CARGO_TARGET_DIR = $TargetDir
cargo build --manifest-path (Join-Path $CodeXDir 'codex-rs\Cargo.toml') --locked --release -p codex-tui --bin codex-tui
$Source = Join-Path $TargetDir 'release\codex-tui.exe'
$Destination = Join-Path $OutDir 'dshx-tui.exe'
Copy-Item -Force $Source $Destination
Write-Host $Destination
