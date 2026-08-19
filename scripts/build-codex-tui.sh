#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bash "$ROOT/scripts/materialize-codex.sh"
CODEX_DIR="${DSHX_CODEX_DIR:-$ROOT/.upstream/codex}"
TARGET_DIR="${CARGO_TARGET_DIR:-$ROOT/.build/codex}"
OUT_DIR="${DSHX_TUI_OUT_DIR:-$ROOT/dist/bin}"

mkdir -p "$OUT_DIR"
CARGO_TARGET_DIR="$TARGET_DIR" cargo build \
  --manifest-path "$CODEX_DIR/codex-rs/Cargo.toml" \
  --locked --release -p codex-tui --bin codex-tui

cp "$TARGET_DIR/release/codex-tui" "$OUT_DIR/dshx-tui"
chmod +x "$OUT_DIR/dshx-tui"
printf '%s\n' "$OUT_DIR/dshx-tui"
