import path from 'node:path';
import { randomUUID } from 'node:crypto';

function shellTool(agent) {
  const tools = agent?.ctx?.get?.('tools');
  if (!tools) throw new Error('DSHX workspace command requires DSH service: tools');
  const preferred = process.platform === 'win32' ? ['pwsh', 'bash'] : ['bash', 'pwsh'];
  for (const name of preferred) {
    if (tools.get?.(name, agent)) return { tools, name };
  }
  throw new Error('No DSH shell tool is visible in the active Agent scope');
}

function bashQuote(value) {
  const text = String(value);
  if (text.includes('\0')) throw new Error('command/exec argv cannot contain NUL');
  return `'${text.replaceAll("'", `'"'"'`)}'`;
}

function pwshQuote(value) {
  const text = String(value);
  if (text.includes('\0')) throw new Error('command/exec argv cannot contain NUL');
  return `'${text.replaceAll("'", "''")}'`;
}

function envName(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`command/exec environment key is not portable: ${JSON.stringify(name)}`);
  }
  return name;
}

function commandText(argv, env, dialect) {
  const quote = dialect === 'pwsh' ? pwshQuote : bashQuote;
  const invocation = dialect === 'pwsh'
    ? `& ${argv.map(quote).join(' ')}`
    : argv.map(quote).join(' ');
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return invocation;

  if (dialect === 'pwsh') {
    const prefix = entries.map(([rawName, value]) => {
      const name = envName(rawName);
      return value == null
        ? `Remove-Item Env:${name} -ErrorAction SilentlyContinue`
        : `$env:${name} = ${quote(value)}`;
    });
    return `${prefix.join('; ')}; ${invocation}`;
  }

  const prefix = entries.map(([rawName, value]) => {
    const name = envName(rawName);
    return value == null ? `unset ${name}` : `export ${name}=${quote(value)}`;
  });
  return `${prefix.join('; ')}; ${invocation}`;
}

function textError(result) {
  return (result?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function capUtf8(text, limit) {
  if (!Number.isSafeInteger(limit) || limit < 0) return text;
  const bytes = Buffer.from(String(text), 'utf8');
  if (bytes.length <= limit) return String(text);
  let end = Math.min(limit, bytes.length);
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

function bufferedResult(result, params) {
  if (result?.isError) {
    throw new Error(textError(result) || result.error?.message || 'DSH workspace command failed');
  }
  const value = result?.value;
  if (!value || value.kind !== 'foreground') {
    throw new Error(`DSH shell returned non-foreground command/exec result: ${JSON.stringify(value?.kind)}`);
  }
  const exitCode = Number.isInteger(value.exitCode) ? value.exitCode : 1;
  const cap = params.disableOutputCap === true ? undefined : params.outputBytesCap;
  return {
    exitCode,
    stdout: capUtf8(value.stdout?.text ?? '', cap),
    stderr: capUtf8(value.stderr?.text ?? '', cap)
  };
}

function validateParams(params) {
  if (!Array.isArray(params.command) || params.command.length === 0 || params.command.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new Error('command/exec requires a non-empty argv string array');
  }
  if (params.processId != null || params.tty === true || params.streamStdin === true || params.streamStdoutStderr === true || params.size != null) {
    throw new Error('DSHX command/exec supports buffered non-TTY workspace commands only');
  }
  if (params.disableTimeout === true) {
    throw new Error('DSHX command/exec does not override the DSH shell executor timeout policy');
  }
  if (params.outputBytesCap != null && params.disableOutputCap === true) {
    throw new Error('command/exec outputBytesCap and disableOutputCap are mutually exclusive');
  }
  if (params.timeoutMs != null && (!Number.isSafeInteger(params.timeoutMs) || params.timeoutMs <= 0)) {
    throw new Error('command/exec timeoutMs must be a positive integer');
  }
  if (params.sandboxPolicy != null || params.permissionProfile != null) {
    throw new Error('DSHX command/exec uses the active DSH session permission policy and rejects Codex policy overrides');
  }
}

/**
 * TUI-owned one-off workspace probes (`git`, `/diff`, status metadata) mapped
 * onto the official DSH shell tool runtime. No process is spawned by DSHX.
 */
export class DshWorkspaceCommandBridge {
  constructor({ driver } = {}) {
    if (!driver?.listRootAgents) throw new Error('DshWorkspaceCommandBridge requires DshAgentDriver');
    this.driver = driver;
  }

  agentFor(cwd) {
    const roots = this.driver.listRootAgents();
    if (roots.length === 0) throw new Error('command/exec requires an active DSH root Agent');
    if (cwd != null) {
      const wanted = path.resolve(cwd);
      const matches = roots.filter((agent) => path.resolve(agent.session?.header?.cwd ?? process.cwd()) === wanted);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new Error(`command/exec cwd matches multiple active DSH Agents: ${wanted}`);
    }
    if (roots.length === 1) return roots[0];
    throw new Error('command/exec cannot choose among multiple active DSH root Agents without an exact cwd match');
  }

  async execute(params = {}) {
    validateParams(params);
    const agent = this.agentFor(params.cwd);
    const { tools, name } = shellTool(agent);
    const args = {
      command: commandText(params.command, params.env, name),
      description: 'Run DSHX TUI workspace command',
      workdir: params.cwd ?? agent.session?.header?.cwd,
      run_in_background: false,
      ...(params.timeoutMs == null ? {} : { timeoutMs: params.timeoutMs })
    };
    const result = await tools.execute({
      callId: `dshx-workspace-${randomUUID()}`,
      name,
      arguments: args,
      signal: new AbortController().signal,
      agent
    });
    return bufferedResult(result, params);
  }
}

export const workspaceCommandInternals = {
  bashQuote,
  pwshQuote,
  commandText,
  bufferedResult,
  validateParams,
  capUtf8,
  shellTool
};
