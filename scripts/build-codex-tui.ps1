$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
& (Join-Path $Root 'scripts\materialize-codex.ps1')
node (Join-Path $Root 'scripts\verify-slash-contract.mjs')
$CodeXDir = if ($env:DSHX_CODEX_DIR) { $env:DSHX_CODEX_DIR } else { Join-Path $Root '.upstream\codex' }
$TargetDir = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $Root '.build\codex' }
$OutDir = if ($env:DSHX_TUI_OUT_DIR) { $env:DSHX_TUI_OUT_DIR } else { Join-Path $Root 'dist\bin' }

New-Item -ItemType Directory -Force $OutDir | Out-Null
$env:CARGO_TARGET_DIR = $TargetDir
cargo build --manifest-path (Join-Path $CodeXDir 'codex-rs\Cargo.toml') --locked --release -p codex-tui --bin codex-tui
cargo build --manifest-path (Join-Path $CodeXDir 'codex-rs\Cargo.toml') --locked --release -p codex-stdio-to-uds --bin dshx-ipc-bridge
$TuiSource = Join-Path $TargetDir 'release\codex-tui.exe'
$TuiDestination = Join-Path $OutDir 'dshx-tui.exe'
$BridgeSource = Join-Path $TargetDir 'release\dshx-ipc-bridge.exe'
$BridgeDestination = Join-Path $OutDir 'dshx-ipc-bridge.exe'
Copy-Item -Force $TuiSource $TuiDestination
Copy-Item -Force $BridgeSource $BridgeDestination
Write-Host $TuiDestination
Write-Host $BridgeDestination
