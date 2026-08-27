/**
 * @code-new-bie/dshx-tui — Codex-TUI surface bundle for DeepSeek Harness.
 *
 * Programmatic entry point. The runtime capability lives in the two
 * loader-mounted rows (`./startup`, `./presentation`); this index exists so
 * tooling and tests can consume the contract metadata without importing the
 * transport implementation.
 */
export {
  name,
  inject,
  Config,
  apply,
  plugin,
  SERVICE_KEY,
  internals
} from './presentation-plugin.mjs';
export {
  name as startupName,
  inject as startupInject,
  Config as startupConfig,
  apply as startupApply,
  plugin as startupPlugin,
  internals as startupInternals
} from './startup-plugin.mjs';
