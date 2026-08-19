import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  boot,
  composeEntries,
  healProfilesModuleFallback,
  loadLayeredEnv,
  loadOptionalPatches,
  loadProfile,
  PROFILE_PATCH_FILENAME
} from '@deepseek-ai/dsh-app-boot';
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment';

const NAME = 'dshx';
const DSH_PROFILE_BIN_NAME = 'dsh';
const DEFAULT_PROFILE = 'headless';
const PROFILE_ROOT_FILENAME = 'cordis.yml';
const PROFILE_ROOT_CONFIG = `# dshx profile root — composition remains owned by DeepSeek Harness.\n[]\n`;
const DSHX_SURFACE_PATCHES = [
  // The official headless profile is the default because it is the DSH runtime
  // without a browser surface. Its one-shot CLI startup/runner are themselves
  // presentation rows, so DSHX replaces only those two rows with Codex TUI.
  { id: 'headless-startup', disabled: true },
  { id: 'headless-runner', disabled: true }
];

function installationAnchor() {
  // @deepseek-ai/dsh is the published profile owner and carries the official
  // dependency closure. No exports restriction blocks package.json resolution.
  return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json');
}

function selectedProfile(explicit) {
  const value = explicit ?? process.env.DSHX_PROFILE ?? DEFAULT_PROFILE;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('dshx: DSH profile name must be non-empty');
  }
  return value.trim();
}

function profileHome(profile) {
  // <DSH_HOME>/profiles/<name> -> <DSH_HOME>
  return dirname(dirname(profile.dir));
}

function shippedAgentPresetPatch(entries, installAnchor) {
  const agentPresets = entries.find((entry) => entry.id === 'agent-presets');
  if (!agentPresets) return [];
  return [{
    id: 'agent-presets',
    config: {
      ...(agentPresets.config ?? {}),
      // This is the same installation-owned preset root used by the official
      // dsh profile launcher. User/writable roots remain owned by the roster.
      roots: [{ path: join(dirname(installAnchor), 'config', 'agent-presets'), trust: 'system' }]
    }
  }];
}

function telemetryPatch(entries) {
  if (!process.env.DSH_TELEMETRY_DISABLED) return [];
  if (!entries.some((entry) => entry.id === 'session-telemetry-otel')) return [];
  return [{ id: 'session-telemetry-otel', disabled: true }];
}

/**
 * Load the exact official DSH profile layers that DSHX presents.
 *
 * Order remains DSH-owned: profile bundle layers -> profile user patch ->
 * $DSH_HOME/cordis.patch.yml. DSHX then adds only installation-equivalent
 * launcher patches and its presentation locks. Out-of-tree profile plugins
 * resolve from the profile directory through DSH's own healed module fallback.
 */
export function dshxRuntimeProfile({
  profile: explicitProfile,
  installAnchor = installationAnchor(),
  home,
  overlays = []
} = {}) {
  const profileName = selectedProfile(explicitProfile);
  healProfilesModuleFallback(installAnchor, home);
  const profile = loadProfile(DSH_PROFILE_BIN_NAME, profileName, installAnchor, home);
  const rootConfig = join(profile.dir, PROFILE_ROOT_FILENAME);
  // Loader requires a real root anchored in the profile directory so
  // profile-local plugins resolve exactly as they do under `dsh --profile`.
  writeFileSync(rootConfig, PROFILE_ROOT_CONFIG);

  const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
  const homePatches = loadOptionalPatches(
    DSH_PROFILE_BIN_NAME,
    join(profileHome(profile), PROFILE_PATCH_FILENAME)
  ) ?? [];
  const beforeLauncher = composeEntries([[...bundlePatches, ...profile.patches, ...homePatches]]);
  const launcherPatches = [
    ...shippedAgentPresetPatch(beforeLauncher, installAnchor),
    ...telemetryPatch(beforeLauncher),
    ...structuredClone(overlays),
    // Last on purpose: a profile may customize DSH capabilities, but it cannot
    // re-enable a competing presentation runner inside the DSHX process.
    ...structuredClone(DSHX_SURFACE_PATCHES)
  ];

  return {
    name: profileName,
    profile,
    rootConfig,
    installAnchor,
    patches: [
      ...structuredClone(bundlePatches),
      ...structuredClone(profile.patches),
      ...structuredClone(homePatches),
      ...launcherPatches
    ]
  };
}

/** Exact patch list DSHX boots; exposed for doctor/ownership tests only. */
export function dshxRuntimePatches(options = {}) {
  return dshxRuntimeProfile(options).patches;
}

/** Offline composition view used by doctor/CI; it includes the user's selected DSH profile. */
export function dshxRuntimeEntries(options = {}) {
  return composeEntries([dshxRuntimePatches(options)]);
}

/**
 * Boot the selected official Harness profile in-process and return its root Context.
 * DSHX owns only the surrounding presentation lifetime. Environment discovery
 * intentionally uses the official `dsh` namespace so project and DSH-home .env
 * behavior stays identical to ordinary Harness launches.
 */
export async function bootDshxRuntime({
  cwd = process.cwd(),
  profile,
  environment = loadLayeredEnv(DSH_PROFILE_BIN_NAME, cwd),
  overlays = [],
  home
} = {}) {
  const composition = dshxRuntimeProfile({ profile, overlays, home });
  return boot(
    NAME,
    composition.rootConfig,
    structuredClone(composition.patches),
    (ctx) => {
      ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    },
    pathToFileURL(composition.installAnchor).href
  );
}

export const runtimeInternals = {
  NAME,
  DSH_PROFILE_BIN_NAME,
  DEFAULT_PROFILE,
  PROFILE_ROOT_FILENAME,
  PROFILE_ROOT_CONFIG,
  DSHX_SURFACE_PATCHES,
  installationAnchor,
  selectedProfile,
  profileHome
};
