function turnNumber(turnId) {
  const match = /^dsh-turn-(\d+)$/.exec(String(turnId ?? ''));
  if (!match) throw new Error(`DSHX cannot map Codex turn id to DSH turn: ${JSON.stringify(turnId)}`);
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid DSH turn id: ${turnId}`);
  return value;
}

function openTurn(events) {
  let open = null;
  for (const event of events ?? []) {
    if (event?.type === 'turn/start') open = event.data?.turn;
    else if (event?.type === 'turn/end' && event.data?.turn === open) open = null;
  }
  return open;
}

function cutAfterCompletedTurn(events, target) {
  const end = events.findIndex((event) => event?.type === 'turn/end' && event.data?.turn === target);
  if (end < 0) throw new Error(`DSH session has no completed dsh-turn-${target}`);

  // Match the official DSH Host fork contract: keep standalone durable events
  // that landed after the selected completed turn (for example session/title),
  // but never copy the next turn/start or anything owned by that later turn.
  let cut = end + 1;
  while (cut < events.length && events[cut]?.type !== 'turn/start') cut += 1;
  return cut;
}

/**
 * Select the exact durable DSH event prefix represented by Codex fork params.
 * No event is synthesized or rewritten: the returned array contains existing
 * SessionEvent objects and is handed to the official AgentFactory seed seam.
 *
 * The default fork follows DSH Host semantics: fork through the latest
 * completed turn and include trailing standalone events up to (but excluding)
 * the next turn/start. A currently-open later turn is therefore never copied.
 */
export function dshForkSeed(events = [], { lastTurnId, beforeTurnId } = {}) {
  if (lastTurnId != null && beforeTurnId != null) {
    throw new Error('thread/fork lastTurnId and beforeTurnId are mutually exclusive');
  }

  if (beforeTurnId != null) {
    const target = turnNumber(beforeTurnId);
    const start = events.findIndex((event) => event?.type === 'turn/start' && event.data?.turn === target);
    if (start < 0) throw new Error(`DSH session has no ${beforeTurnId}`);
    return events.slice(0, start);
  }

  if (lastTurnId != null) {
    const target = turnNumber(lastTurnId);
    return events.slice(0, cutAfterCompletedTurn(events, target));
  }

  const latestEnd = events.findLast?.((event) => event?.type === 'turn/end')
    ?? [...events].reverse().find((event) => event?.type === 'turn/end');
  if (!latestEnd || !Number.isInteger(latestEnd.data?.turn)) {
    throw new Error('DSH session has no completed turn to fork from');
  }
  return events.slice(0, cutAfterCompletedTurn(events, latestEnd.data.turn));
}

export const forkInternals = { turnNumber, openTurn, cutAfterCompletedTurn };
