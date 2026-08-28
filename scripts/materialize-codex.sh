#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIN="$(tr -d '\r\n' < "$ROOT/upstream/CODEX_COMMIT")"
DEST="${DSHX_CODEX_DIR:-$ROOT/.upstream/codex}"
REPO="${DSHX_CODEX_REPO:-https://github.com/openai/codex.git}"

if [[ -d "$DEST/.git" ]]; then
  git -C "$DEST" fetch --quiet origin "$PIN"
else
  rm -rf "$DEST"
  mkdir -p "$(dirname "$DEST")"
  git clone --filter=blob:none --no-checkout "$REPO" "$DEST"
  git -C "$DEST" fetch --quiet origin "$PIN"
fi

git -C "$DEST" checkout --detach --force "$PIN"
git -C "$DEST" reset --hard "$PIN" >/dev/null
git -C "$DEST" clean -ffd >/dev/null

for patch in "$ROOT"/upstream/patches/codex/*.patch; do
  [[ -e "$patch" ]] || continue
  # The maintained thin-fork patches are intentionally compact and may carry
  # fewer context lines than git-apply's traditional unified-diff minimum, as
  # well as stale hunk line counts after upstream rebases. --unidiff-zero only
  # permits that compact shape; every context line that is present must still
  # match exactly. --recount derives counts from the hunk body, and --check
  # fails closed before any patch mutates the pinned tree.
  git -C "$DEST" apply --verbose --unidiff-zero --recount --check "$patch"
  git -C "$DEST" apply --verbose --unidiff-zero --recount "$patch"
done

printf '%s\n' "Materialized Codex $PIN at $DEST"
