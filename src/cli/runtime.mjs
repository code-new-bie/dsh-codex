export const DSHX_NODE_ENGINE = '^22.19.0 || >=24.0.0';
export const DSHX_RELEASE_NODE_MAJOR = 24;

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
