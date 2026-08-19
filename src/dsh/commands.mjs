function requireService(ctx, name) {
  const service = ctx?.get?.(name);
  if (service == null) throw new Error(`DSHX requires DSH service: ${name}`);
  return service;
}

/**
 * Execute one human-facing DSH command through the official command plane.
 * DSHX does not parse, implement, persist, or run the domain operation itself.
 */
export async function executeDshCommand({ ctx, agent, line, signal }) {
  if (!agent) throw new Error('DSHX command execution requires a live DSH Agent');
  const commands = requireService(ctx, 'commands');
  const execution = await commands.execute(agent, line, signal);
  if (execution == null) throw new Error(`DSH command is not registered: ${line}`);
  if (execution.result?.kind === 'error') {
    throw new Error(execution.result.text || `DSH command failed: ${line}`);
  }
  return execution;
}

/** Read the current agent-scoped command catalog from DSH. */
export function listDshCommands({ ctx, agent }) {
  const commands = requireService(ctx, 'commands');
  return commands.list(agent);
}
