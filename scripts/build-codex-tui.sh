#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$ROOT/scripts/materialize-codex.sh"
node "$ROOT/scripts/verify-slash-contract.mjs"
CODEX_DIR="${DSHX_CODEX_DIR:-$ROOT/.upstream/codex}"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/.build/codex}"
OUT_DIR="${DSHX_TUI_OUT_DIR:-$ROOT/dist/bin}"

mkdir -p "$OUT_DIR"
export CARGO_PROFILE_RELEASE_DEBUG="${CARGO_PROFILE_RELEASE_DEBUG:-0}"
CARGO_TARGET_DIR="$TARGET_DIR" cargo build \
  --manifest-path "$CODEX_DIR/codex-rs/Cargo.toml" \
  --locked --release -p codex-tui --bin codex-tui

cp "$TARGET_DIR/release/codex-tui" "$OUT_DIR/dshx-tui"
if command -v strip >/dev/null 2>&1; then
  strip "$OUT_DIR/dshx-tui"
fi
chmod +x "$OUT_DIR/dshx-tui"
printf '%s\n' "$OUT_DIR/dshx-tui"
