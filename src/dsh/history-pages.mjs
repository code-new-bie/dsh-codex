import { dshTurnsFromSession } from './codex-shapes.mjs';

function cursorOffset(cursor) {
  if (cursor == null) return 0;
  const match = /^dshx:(\d+)$/.exec(String(cursor));
  if (!match) throw new Error(`invalid DSHX history cursor: ${JSON.stringify(cursor)}`);
  const value = Number(match[1]);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid DSHX history cursor');
  return value;
}

function pageSize(limit, fallback) {
  if (limit == null) return fallback;
  const value = Number(limit);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('history limit must be a positive integer');
  return Math.min(value, 1000);
}

function page(values, { cursor, limit, sortDirection, fallbackLimit }) {
  const ordered = sortDirection === 'asc' ? values : [...values].reverse();
  const start = cursorOffset(cursor);
  const size = pageSize(limit, fallbackLimit);
  const end = Math.min(ordered.length, start + size);
  return {
    data: ordered.slice(start, end),
    nextCursor: end < ordered.length ? `dshx:${end}` : null,
    // DSHX cursors are forward-only presentation cursors. The TUI only needs
    // nextCursor for bounded backwards hydration; no durable cursor state is owned here.
    backwardsCursor: null
  };
}

function projectedTurns(controller, diagnostics) {
  return dshTurnsFromSession({
    ctx: controller.agent.ctx,
    agent: controller.agent,
    diagnostics
  });
}

function viewTurn(turn, requestedView) {
  if (requestedView === 'notLoaded') {
    return { ...turn, items: [], itemsView: 'notLoaded' };
  }
  // DSHX has a faithful full presentation fold, not a second lossy summary
  // algorithm. When Codex asks for summary, return full and label it honestly.
  return { ...turn, itemsView: 'full' };
}

export function dshThreadTurnsPage({ controller, params = {}, diagnostics = () => {} }) {
  const turns = projectedTurns(controller, diagnostics).map((turn) => viewTurn(turn, params.itemsView));
  return page(turns, {
    cursor: params.cursor,
    limit: params.limit,
    sortDirection: params.sortDirection,
    fallbackLimit: 5
  });
}

export function dshThreadItemsPage({ controller, params = {}, diagnostics = () => {} }) {
  let turns = projectedTurns(controller, diagnostics);
  if (params.turnId != null) {
    turns = turns.filter((turn) => turn.id === String(params.turnId));
  }
  const entries = [];
  for (const turn of turns) {
    for (const item of turn.items) entries.push({ turnId: turn.id, item });
  }
  return page(entries, {
    cursor: params.cursor,
    limit: params.limit,
    sortDirection: params.sortDirection,
    fallbackLimit: 100
  });
}

export const historyInternals = { cursorOffset, pageSize, page, viewTurn };
