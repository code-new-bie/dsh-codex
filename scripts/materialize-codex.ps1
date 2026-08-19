$ErrorActionPreference = 'Stop'

$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Pin = (Get-Content (Join-Path $Root 'upstream/CODEX_COMMIT') -Raw).Trim()
$Dest = if ($env:DSHX_CODEX_DIR) { $env:DSHX_CODEX_DIR } else { Join-Path $Root '.upstream\codex' }
$Repo = if ($env:DSHX_CODEX_REPO) { $env:DSHX_CODEX_REPO } else { 'https://github.com/openai/codex.git' }

if (Test-Path (Join-Path $Dest '.git')) {
    git -C $Dest fetch --quiet origin $Pin
} else {
    if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }
    New-Item -ItemType Directory -Force (Split-Path -Parent $Dest) | Out-Null
    git clone --filter=blob:none --no-checkout $Repo $Dest
    git -C $Dest fetch --quiet origin $Pin
}

git -C $Dest checkout --detach --force $Pin
git -C $Dest reset --hard $Pin | Out-Null
git -C $Dest clean -ffd | Out-Null

$Patches = Get-ChildItem (Join-Path $Root 'upstream\patches\codex\*.patch') -ErrorAction SilentlyContinue | Sort-Object Name
foreach ($Patch in $Patches) {
    git -C $Dest apply --check $Patch.FullName
    git -C $Dest apply $Patch.FullName
}

Write-Host "Materialized Codex $Pin at $Dest"
