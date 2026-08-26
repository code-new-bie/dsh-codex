export const DSHX_NODE_ENGINE = '^22.19.0 || >=24.0.0';
export const DSHX_RELEASE_NODE_MAJOR = 24;
// `dshx doctor` deliberately boots the full official DSH composition, including
// profile watchers. A fresh Windows install can incur one-time module/native
// initialization that exceeds 20s even though subsequent and normal product
// startup are healthy. Keep the diagnostic bounded, but allow realistic cold
// starts on supported desktop hardware.
export const DSHX_DOCTOR_BOOT_TIMEOUT_MS = 60_000;
export const DSHX_DOCTOR_DISPOSE_TIMEOUT_MS = 10_000;

export function isSupportedNodeVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (major === 22 && minor >= 19) || major >= 24;
}

export function assertReleaseNodeVersion(version = process.versions.node) {
  const major = Number(String(version).split('.')[0]);
  if (major !== DSHX_RELEASE_NODE_MAJOR) {
    throw new Error(
      `DSHX dependency freeze/release baseline requires Node ${DSHX_RELEASE_NODE_MAJOR}.x; got ${version}. ` +
      `Runtime compatibility follows pinned DSH (${DSHX_NODE_ENGINE}).`
    );
  }
}
