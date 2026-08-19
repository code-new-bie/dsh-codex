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

/**
 * Select the exact durable DSH event prefix represented by Codex fork params.
 * No event is synthesized or rewritten: the returned array contains existing
 * SessionEvent objects and is handed to the official AgentFactory seed seam.
 */
export function dshForkSeed(events = [], { lastTurnId, beforeTurnId } = {}) {
  if (lastTurnId != null && beforeTurnId != null) {
    throw new Error('thread/fork lastTurnId and beforeTurnId are mutually exclusive');
  }
  const active = openTurn(events);
  if (active != null) {
    throw new Error(`DSHX refuses to fork a DSH session with active turn ${active}`);
  }

  if (lastTurnId == null && beforeTurnId == null) return [...events];

  if (lastTurnId != null) {
    const target = turnNumber(lastTurnId);
    const end = events.findIndex((event) => event?.type === 'turn/end' && event.data?.turn === target);
    if (end < 0) throw new Error(`DSH session has no completed ${lastTurnId}`);
    return events.slice(0, end + 1);
  }

  const target = turnNumber(beforeTurnId);
  const start = events.findIndex((event) => event?.type === 'turn/start' && event.data?.turn === target);
  if (start < 0) throw new Error(`DSH session has no ${beforeTurnId}`);
  return events.slice(0, start);
}

export const forkInternals = { turnNumber, openTurn };
