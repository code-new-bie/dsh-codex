export function parseLaunchArgs(args) {
  if (args[0] !== 'resume') return { tuiArgs: args, resumeEnv: {} };
  const rest = args.slice(1);
  if (rest.length === 0) return { tuiArgs: [], resumeEnv: { DSHX_RESUME_MODE: 'picker' } };
  if (rest.length === 1 && rest[0] === '--last') {
    return { tuiArgs: [], resumeEnv: { DSHX_RESUME_MODE: 'last' } };
  }
  if (rest.length === 1 && !rest[0].startsWith('-')) {
    return {
      tuiArgs: [],
      resumeEnv: { DSHX_RESUME_MODE: 'id', DSHX_RESUME_SESSION_ID: rest[0] }
    };
  }
  throw new Error('Usage: dshx resume [--last|<session>]');
}

export function parseCliInvocation(args) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    return { kind: 'help' };
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-V')) {
    return { kind: 'version' };
  }
  if (args[0] === 'doctor') {
    if (args.length !== 1) throw new Error('Usage: dshx doctor');
    return { kind: 'doctor' };
  }
  return { kind: 'launch', ...parseLaunchArgs(args) };
}
