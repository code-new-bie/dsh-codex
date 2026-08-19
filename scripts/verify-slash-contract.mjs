#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLASH = path.join(ROOT, '.upstream', 'codex', 'codex-rs', 'tui', 'src', 'slash_command.rs');

if (!fs.existsSync(SLASH)) {
  throw new Error(`materialized pinned Codex slash_command.rs is missing: ${SLASH}`);
}

const source = fs.readFileSync(SLASH, 'utf8');
const enumMatch = source.match(/pub enum SlashCommand\s*\{([\s\S]*?)\n\}/);
if (!enumMatch) throw new Error('cannot parse pinned Codex SlashCommand enum');
const variants = new Set(
  [...enumMatch[1].matchAll(/^\s*([A-Z][A-Za-z0-9_]*)\s*,\s*$/gm)].map((match) => match[1])
);

const visibilityMatch = source.match(
  /if crate::dshx_backend\(\)[\s\S]*?matches!\([\s\S]*?self,([\s\S]*?)\)\s*\{\s*return false;/
);
if (!visibilityMatch) throw new Error('cannot find DSHX slash visibility guard in patched Codex');
const dshxHidden = new Set(
  [...visibilityMatch[1].matchAll(/SlashCommand::([A-Z][A-Za-z0-9_]*)/g)].map((match) => match[1])
);

// Commands whose behavior is entirely presentation-local. Their state lives in
// the isolated DSHX Codex home or the terminal process, never in a shadow Agent runtime.
const presentationOnly = new Set([
  'Keymap', 'Vim', 'Copy', 'Export', 'Raw', 'Mention', 'Status', 'Pwd',
  'Title', 'Statusline', 'Theme', 'Pets', 'Quit', 'Exit'
]);

// Release-only upstream visibility guards keep these out of normal builds.
const upstreamDebugOnly = new Set(['Rollout', 'TestApproval']);

// Visible runtime-owned commands must have a faithful DSH-backed app-server surface.
// The method strings are also asserted to exist in the adapter sources below.
const runtimeBacked = new Map([
  ['Model', ['thread/settings/update', 'model/list']],
  ['Permissions', ['thread/settings/update']],
  ['Skills', ['skills/list']],
  ['Rename', ['thread/name/set']],
  ['New', ['thread/start']],
  ['Clear', ['thread/start']],
  ['Resume', ['thread/list', 'thread/resume']],
  ['Fork', ['thread/fork']],
  ['Init', ['turn/start']],
  ['Compact', ['thread/compact/start']],
  ['Plan', ['thread/settings/update']],
  ['Agents', ['thread/loaded/list']],
  ['Diff', ['command/exec']]
]);

const classified = new Set([
  ...dshxHidden,
  ...presentationOnly,
  ...upstreamDebugOnly,
  ...runtimeBacked.keys()
]);
const unclassified = [...variants].filter((variant) => !classified.has(variant)).sort();
if (unclassified.length > 0) {
  throw new Error(
    `Pinned Codex introduced visible/unclassified slash commands: ${unclassified.join(', ')}. ` +
    'Classify each as DSH-backed, presentation-only, upstream-debug-only, or hide it explicitly for DSHX.'
  );
}

for (const hidden of dshxHidden) {
  if (!variants.has(hidden)) throw new Error(`DSHX hides unknown SlashCommand variant ${hidden}`);
}

const adapterSources = [
  'src/dsh/app-server-adapter.mjs',
  'src/dsh/product-adapter.mjs',
  'src/dsh/release-adapter.mjs'
].map((relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8')).join('\n');
for (const [command, methods] of runtimeBacked) {
  for (const method of methods) {
    if (!adapterSources.includes(`'${method}'`) && !adapterSources.includes(`\"${method}\"`)) {
      throw new Error(`/${command} is visible in DSHX but adapter source does not claim ${method}`);
    }
  }
}

process.stdout.write(
  `DSHX slash contract OK: ${variants.size} pinned commands; ` +
  `${dshxHidden.size} hidden, ${runtimeBacked.size} DSH-backed, ` +
  `${presentationOnly.size} presentation-only, ${upstreamDebugOnly.size} debug-only.\n`
);
