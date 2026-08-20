import { writeFileSync } from 'node:fs';
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
  PROFILE_PATCH_FILENAME,
  watchUserPatches
} from '@deepseek-ai/dsh-app-boot';
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment';

const NAME = 'dshx';
const DSH_PROFILE_BIN_NAME = 'dsh';
const DEFAULT_PROFILE = 'headless';
const PROFILE_ROOT_FILENAME = 'cordis.yml';
// Match the official `dsh` launcher's profile-root contract: this file is only
// the Loader/include base anchor. The real user-owned configuration is carried
// by the profile's `cordis.patch.yml` plus `$DSH_HOME/cordis.patch.yml`.
// Rewriting this empty root on every boot is intentional DSH behavior and
// prevents Loader tree write-back from becoming a second persisted config.
const PROFILE_ROOT_CONFIG = `# DSHX uses the same empty profile root contract as the official dsh launcher.\n# The effective tree is composed from DSH bundle and patch layers.\n# Edit cordis.patch.yml, not this file.\n[]\n`;
const DSHX_SURFACE_PATCHES = [
  // The official headless profile is the default because it is the DSH runtime
  // without a browser surface. Its one-shot CLI startup/runner are themselves
  // presentation rows, so DSHX replaces only those two rows with Codex TUI.
  { id: 'headless-startup', disabled: true },
  { id: 'headless-runner', disabled: true }
];

function installationAnchor() {
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
  return dirname(dirname(profile.dir));
}

function homePatchPath(profile) {
  return join(profileHome(profile), PROFILE_PATCH_FILENAME);
}

function shippedAgentPresetPatch(entries, installAnchor) {
  const agentPresets = entries.find((entry) => entry.id === 'agent-presets');
  if (!agentPresets) return [];
  return [{
    id: 'agent-presets',
    config: {
      ...(agentPresets.config ?? {}),
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
  // Official DSH deliberately rewrites this empty include root before boot.
  // Never write `profile.patchPath` or the home patch here: those are the
  // authoritative user configuration layers and are read-only to DSHX.
  writeFileSync(rootConfig, PROFILE_ROOT_CONFIG);

  const bundlePatches = profile.layers.flatMap((layer) => layer.patches);
  const homePatches = loadOptionalPatches(DSH_PROFILE_BIN_NAME, homePatchPath(profile)) ?? [];
  const beforeLauncher = composeEntries([[...bundlePatches, ...profile.patches, ...homePatches]]);
  const launcherPatches = [
    ...shippedAgentPresetPatch(beforeLauncher, installAnchor),
    ...telemetryPatch(beforeLauncher),
    ...structuredClone(overlays),
    // Last on purpose: DSH user/profile configuration owns capabilities, but
    // cannot re-enable a competing presentation runner in the DSHX process.
    ...structuredClone(DSHX_SURFACE_PATCHES)
  ];

  return {
    name: profileName,
    profile,
    rootConfig,
    installAnchor,
    homePatchPath: homePatchPath(profile),
    patches: [
      ...structuredClone(bundlePatches),
      ...structuredClone(profile.patches),
      ...structuredClone(homePatches),
      ...launcherPatches
    ]
  };
}

export function dshxRuntimePatches(options = {}) {
  return dshxRuntimeProfile(options).patches;
}

export function dshxRuntimeEntries(options = {}) {
  return composeEntries([dshxRuntimePatches(options)]);
}

async function installProfileWatchers(ctx, options) {
  if (ctx.get('loader') == null) {
    throw new Error('dshx: official DSH profile boot has no Loader for profile hot reload');
  }
  if (ctx.get('hmr') == null) {
    if (ctx.get('timer') == null) {
      await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' });
    }
    await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } });
  }

  const current = () => dshxRuntimeProfile(options).patches;
  const composition = dshxRuntimeProfile(options);
  await watchUserPatches(ctx, {
    binName: NAME,
    filename: composition.profile.patchPath,
    compose: () => current()
  });
  await watchUserPatches(ctx, {
    binName: NAME,
    filename: composition.homePatchPath,
    compose: () => current()
  });
}

async function disposeOfficialContext(ctx) {
  if (!ctx) return;
  if (typeof ctx.fiber?.dispose !== 'function') {
    throw new Error('dshx: official DSH Context has no root fiber disposal contract');
  }
  await ctx.fiber.dispose();
}

function attachPresentationLifetime(ctx) {
  // Cordis Context intentionally owns teardown through its root Fiber rather
  // than a Context.dispose() method. DSHX keeps its launcher/local-server
  // lifetime API small by exposing a non-enumerable alias that delegates to
  // that official root-fiber contract; no runtime service is replaced.
  Object.defineProperty(ctx, 'dispose', {
    configurable: true,
    enumerable: false,
    value: () => disposeOfficialContext(ctx)
  });
  return ctx;
}

/**
 * Boot the selected official Harness profile in-process and return its root Context.
 * DSHX owns only presentation lifetime. Project and DSH-home environment and
 * live patch behavior intentionally follow the official DSH profile launcher.
 */
export async function bootDshxRuntime({
  cwd = process.cwd(),
  profile,
  environment = loadLayeredEnv(DSH_PROFILE_BIN_NAME, cwd),
  overlays = [],
  home,
  watch = true
} = {}) {
  const options = { profile, overlays, home };
  const composition = dshxRuntimeProfile(options);
  let ctx;
  try {
    ctx = await boot(
      NAME,
      composition.rootConfig,
      structuredClone(composition.patches),
      (hostCtx) => {
        hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
      },
      pathToFileURL(composition.installAnchor).href
    );
    attachPresentationLifetime(ctx);
    if (watch) await installProfileWatchers(ctx, options);
    return ctx;
  } catch (error) {
    if (ctx) {
      try {
        await disposeOfficialContext(ctx);
      } catch (disposeError) {
        if (error && typeof error === 'object') {
          try { Object.defineProperty(error, 'dshxCleanupError', { value: disposeError }); } catch {}
        }
      }
    }
    throw error;
  }
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
  profileHome,
  homePatchPath,
  installProfileWatchers,
  disposeOfficialContext,
  attachPresentationLifetime
};
