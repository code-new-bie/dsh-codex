function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0 ? Number(value) : 0;
}

function breakdown(usage = {}) {
  const inputTokens = finiteNonNegative(usage.inputTokens ?? usage.uncachedInputTokens);
  const cachedInputTokens = finiteNonNegative(usage.cacheReadTokens);
  const cacheWriteInputTokens = finiteNonNegative(usage.cacheWriteTokens);
  const outputTokens = finiteNonNegative(usage.outputTokens);
  const reasoningOutputTokens = finiteNonNegative(usage.reasoningTokens);
  return {
    totalTokens: inputTokens + cachedInputTokens + cacheWriteInputTokens + outputTokens,
    inputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens
  };
}

function usageSamples(events = []) {
  const byStep = new Map();
  let last = null;
  let lastTurn = null;
  for (const event of events) {
    const data = event?.data;
    if (!Number.isInteger(data?.turn) || !Number.isInteger(data?.step)) continue;
    let usage;
    if (event.type === 'assistant/chunk' && data.chunk?.type === 'usage') {
      usage = data.chunk.usage;
    } else if (event.type === 'assistant/message' && data.usage) {
      usage = data.usage;
    }
    if (!usage) continue;
    const sample = { ...usage };
    byStep.set(`${data.turn}:${data.step}`, sample);
    last = sample;
    lastTurn = data.turn;
  }
  return { byStep, last, lastTurn };
}

function reasoningTotal(events = []) {
  const { byStep } = usageSamples(events);
  let total = 0;
  for (const usage of byStep.values()) total += finiteNonNegative(usage.reasoningTokens);
  return total;
}

function latestContextWindow(events = []) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'request/context' && Number.isFinite(event.data?.contextWindow)) {
      return Number(event.data.contextWindow);
    }
  }
  return null;
}

/**
 * Read-only presentation snapshot over official DSH session projections.
 * DSH token-meter owns accounting; this module only reshapes its values into
 * the pinned Codex TUI contract.
 */
export function codexThreadTokenUsage({ ctx, session }) {
  const projections = ctx?.get?.('sessionProjections');
  if (!session || !projections?.snapshot) return null;
  const snapshot = projections.snapshot(session);
  const cumulative = snapshot?.values?.tokenUsage;
  if (!cumulative) return null;

  const events = session.events ?? [];
  const { last } = usageSamples(events);
  const total = breakdown({
    inputTokens: cumulative.uncachedInputTokens,
    cacheReadTokens: cumulative.cacheReadTokens,
    cacheWriteTokens: cumulative.cacheWriteTokens,
    outputTokens: cumulative.outputTokens,
    reasoningTokens: reasoningTotal(events)
  });
  const contextWindow = Number.isFinite(snapshot?.values?.contextPressure?.contextWindow)
    ? Number(snapshot.values.contextPressure.contextWindow)
    : latestContextWindow(events);

  return {
    total,
    last: breakdown(last ?? {}),
    modelContextWindow: contextWindow
  };
}

export function latestTokenUsageTurnId(session) {
  const { lastTurn } = usageSamples(session?.events ?? []);
  return Number.isInteger(lastTurn) ? `dsh-turn-${lastTurn}` : null;
}

export function tokenUsageNotification({ ctx, session, threadId, turnId }) {
  const tokenUsage = codexThreadTokenUsage({ ctx, session });
  if (!tokenUsage || !threadId || !turnId) return null;
  return {
    method: 'thread/tokenUsage/updated',
    params: { threadId, turnId, tokenUsage }
  };
}

export function persistedTokenUsageNotification({ ctx, session, threadId }) {
  const turnId = latestTokenUsageTurnId(session);
  return tokenUsageNotification({ ctx, session, threadId, turnId });
}

export const tokenUsageInternals = {
  breakdown,
  usageSamples,
  reasoningTotal,
  latestContextWindow
};
