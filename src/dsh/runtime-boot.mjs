import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  boot,
  composeEntries,
  loadLayeredEnv,
  loadOverlayPatches,
  resolveBundleDir
} from '@deepseek-ai/dsh-app-boot';
import { DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment';

const NAME = 'dshx';
const ROOT_CONFIG = fileURLToPath(new URL('../../config/dshx-runtime/cordis.yml', import.meta.url));
const OFFICIAL_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'];
const DSHX_SURFACE_PATCHES = [
  // The official headless bundle is our composition source, but its startup
  // provider and one-shot runner are themselves a presentation surface. DSHX
  // replaces only those rows; all Agent/Session/tool/provider services remain
  // exactly the official headless composition.
  { id: 'headless-startup', disabled: true },
  { id: 'headless-runner', disabled: true }
];

function installationAnchor() {
  // @deepseek-ai/dsh is the published closed runtime carrying the official
  // bundle/plugin dependency closure. It intentionally has no `exports`
  // restriction, so its package.json is a stable resolution anchor.
  return createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json');
}

function bundleLayer(packageName, installAnchor) {
  const configDir = dirname(ROOT_CONFIG);
  const packageDir = resolveBundleDir(NAME, packageName, installAnchor, configDir);
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  const patch = manifest?.dsh?.bundle?.patch;
  if (typeof patch !== 'string' || patch.length === 0) {
    throw new Error(`dshx: official bundle ${packageName} declares no dsh.bundle.patch`);
  }
  return loadOverlayPatches(NAME, join(packageDir, patch));
}

/**
 * Return the exact patch list DSHX boots: official base + official headless,
 * then the two presentation-row disables above, then optional DSHX-owned
 * presentation overlays supplied by the caller.
 */
export function dshxRuntimePatches({ installAnchor = installationAnchor(), overlays = [] } = {}) {
  return [
    ...OFFICIAL_BUNDLES.flatMap((name) => bundleLayer(name, installAnchor)),
    ...structuredClone(DSHX_SURFACE_PATCHES),
    ...structuredClone(overlays)
  ];
}

/** Offline composition view used by doctor/CI to prove DSHX did not grow a second runtime. */
export function dshxRuntimeEntries(options = {}) {
  return composeEntries([dshxRuntimePatches(options)]);
}

/**
 * Boot the official Harness composition in-process and return its root Context.
 * DSHX owns only the surrounding presentation lifetime. The environment
 * snapshot is provided before any config entry mounts, matching the official
 * dsh launcher contract.
 */
export async function bootDshxRuntime({
  cwd = process.cwd(),
  environment = loadLayeredEnv(NAME, cwd),
  overlays = []
} = {}) {
  const installAnchor = installationAnchor();
  const patches = dshxRuntimePatches({ installAnchor, overlays });
  return boot(
    NAME,
    ROOT_CONFIG,
    structuredClone(patches),
    (ctx) => {
      ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment);
    },
    pathToFileURL(installAnchor).href
  );
}

export const runtimeInternals = {
  NAME,
  ROOT_CONFIG,
  OFFICIAL_BUNDLES,
  DSHX_SURFACE_PATCHES,
  installationAnchor
};
