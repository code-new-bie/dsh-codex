function turnNumber(turnId) {
  const match = /^dsh-turn-(\d+)$/.exec(String(turnId ?? ''));
  if (!match) throw new Error(`DSHX cannot map Codex turn id to DSH turn: ${JSON.stringify(turnId)}`);
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid DSH turn id: ${turnId}`);
  return value;
}

function completedTurnEnd(events, turn) {
  return (events ?? []).find((event) => event?.type === 'turn/end' && event.data?.turn === turn);
}

/**
 * Translate Codex's fork presentation anchors into the one `atSeq` hint owned
 * by DSH Host `sessions.fork`. This function deliberately does NOT select or
 * copy a seed, decide lineage, inherit model state, or create a Session.
 */
export function codexForkAtSeq(events = [], { lastTurnId, beforeTurnId } = {}) {
  if (lastTurnId != null && beforeTurnId != null) {
    throw new Error('thread/fork lastTurnId and beforeTurnId are mutually exclusive');
  }

  if (lastTurnId != null) {
    const turn = turnNumber(lastTurnId);
    const end = completedTurnEnd(events, turn);
    if (!end || !Number.isInteger(end.seq)) {
      throw new Error(`DSH session has no completed ${lastTurnId}`);
    }
    return end.seq;
  }

  if (beforeTurnId != null) {
    const turn = turnNumber(beforeTurnId);
    const start = (events ?? []).find((event) => event?.type === 'turn/start' && event.data?.turn === turn);
    if (!start || !Number.isInteger(start.seq)) {
      throw new Error(`DSH session has no ${beforeTurnId}`);
    }
    const priorEnds = (events ?? []).filter((event) =>
      event?.type === 'turn/end'
      && Number.isInteger(event.seq)
      && event.seq < start.seq
    );
    const prior = priorEnds.at(-1);
    if (!prior) {
      throw new Error('DSH Host fork cannot represent a Codex beforeTurnId before the first completed turn');
    }
    return prior.seq;
  }

  // Omission is meaningful: the official DSH Host chooses the latest completed
  // turn, including its own handling for live/cold sessions and open tails.
  return undefined;
}

export const forkInternals = { turnNumber, completedTurnEnd };
