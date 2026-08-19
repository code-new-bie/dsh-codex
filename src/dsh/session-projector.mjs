const nowSeconds = () => Math.floor(Date.now() / 1000);
const nowMillis = () => Date.now();

function parseJsonOrString(value) {
  if (typeof value !== 'string') return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}

function visibleText(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function reasoningContent(message) {
  return (message?.content ?? [])
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text);
}

function toolResultCallId(data) {
  const sourceId = data?.message?.source?.kind === 'tool' ? data.message.source.callId : undefined;
  if (sourceId !== undefined) return sourceId;
  const block = data?.message?.content?.find?.((entry) => entry?.type === 'tool-result');
  return block?.toolCallId;
}

function toolResultFailed(data) {
  const block = data?.message?.content?.find?.((entry) => entry?.type === 'tool-result');
  return Boolean(block?.isError ?? data?.error);
}

function mapTurnStatus(reason) {
  switch (reason?.kind) {
    case 'completed': return 'completed';
    case 'aborted':
    case 'interrupted': return 'interrupted';
    default: return 'failed';
  }
}

function mapPlanStatus(status) {
  if (status === 'in_progress') return 'inProgress';
  if (status === 'completed') return 'completed';
  return 'pending';
}

function turnRecord(id, status, startedAt, completedAt = null, error = null) {
  return {
    id,
    items: [],
    itemsView: 'full',
    status,
    error,
    startedAt,
    completedAt,
    durationMs: startedAt != null && completedAt != null
      ? Math.max(0, (completedAt - startedAt) * 1000)
      : null
  };
}

/**
 * Stateful presentation projection of official DSH Session events.
 * Durable truth stays in DSH; all maps here are disposable UI correlation.
 */
export class DshSessionProjector {
  constructor({ threadId, sessionId = threadId, toolPresentation = null } = {}) {
    if (!threadId) throw new Error('DshSessionProjector requires threadId');
    this.threadId = threadId;
    this.sessionId = sessionId;
    this.toolPresentation = toolPresentation;
    this.turns = new Map();
    this.assistantItems = new Map();
    this.reasoningItems = new Map();
    this.tools = new Map();
    this.currentTurn = null;
    this.latestHeader = null;
    this.latestContext = null;
  }

  project(event) {
    if (!event || typeof event.type !== 'string') return [];
    switch (event.type) {
      case 'turn/start': return this.turnStarted(event);
      case 'turn/end': return this.turnEnded(event);
      case 'assistant/chunk': return this.assistantChunk(event);
      case 'assistant/message': return this.assistantMessage(event);
      case 'tool/call': return this.toolCall(event);
      case 'tool/result': return this.toolResult(event);
      case 'todo/write': return this.todoWrite(event);
      case 'request/header':
        this.latestHeader = event.data?.header ?? null;
        return [];
      case 'request/context':
        this.latestContext = event.data ?? null;
        return [];
      default:
        return [];
    }
  }

  turnStarted(event) {
    const dshTurn = event.data?.turn;
    if (!Number.isInteger(dshTurn)) return [];
    const turnId = `dsh-turn-${dshTurn}`;
    const startedAt = Number.isFinite(event.time) ? Math.floor(event.time / 1000) : nowSeconds();
    this.turns.set(dshTurn, { id: turnId, startedAt });
    this.currentTurn = dshTurn;
    return [{ method: 'turn/started', params: { threadId: this.threadId, turn: turnRecord(turnId, 'inProgress', startedAt) } }];
  }

  turnEnded(event) {
    const dshTurn = event.data?.turn;
    const state = this.turns.get(dshTurn);
    if (!state) return [];
    const reason = event.data?.reason;
    const status = mapTurnStatus(reason);
    const completedAt = Number.isFinite(event.time) ? Math.floor(event.time / 1000) : nowSeconds();
    const error = status === 'failed' && reason?.kind === 'error'
      ? { message: reason.error?.message ?? 'DSH turn failed', codexErrorInfo: null, additionalDetails: null }
      : null;
    if (this.currentTurn === dshTurn) this.currentTurn = null;
    return [{ method: 'turn/completed', params: { threadId: this.threadId, turn: turnRecord(state.id, status, state.startedAt, completedAt, error) } }];
  }

  assistantChunk(event) {
    const { turn, step, chunk } = event.data ?? {};
    if (!Number.isInteger(turn) || !Number.isInteger(step) || !chunk) return [];
    const turnState = this.turns.get(turn);
    if (!turnState) return [];

    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      const key = `${turn}:${step}`;
      let item = this.reasoningItems.get(key);
      const events = [];
      if (!item) {
        item = { id: `dsh-reasoning-${turn}-${step}`, content: [] };
        this.reasoningItems.set(key, item);
        events.push({
          method: 'item/started',
          params: {
            threadId: this.threadId,
            turnId: turnState.id,
            startedAtMs: Number.isFinite(event.time) ? event.time : nowMillis(),
            item: { type: 'reasoning', id: item.id, summary: [], content: [] }
          }
        });
      }
      const index = Number.isInteger(chunk.index) && chunk.index >= 0 ? chunk.index : 0;
      item.content[index] = `${item.content[index] ?? ''}${chunk.text}`;
      events.push({
        method: 'item/reasoning/textDelta',
        params: {
          threadId: this.threadId,
          turnId: turnState.id,
          itemId: item.id,
          delta: chunk.text,
          contentIndex: index
        }
      });
      return events;
    }

    if (chunk.type !== 'text-delta' || typeof chunk.text !== 'string') return [];
    const key = `${turn}:${step}`;
    let item = this.assistantItems.get(key);
    const events = [];
    if (!item) {
      item = { id: `dsh-assistant-${turn}-${step}`, text: '' };
      this.assistantItems.set(key, item);
      events.push({
        method: 'item/started',
        params: {
          threadId: this.threadId,
          turnId: turnState.id,
          startedAtMs: Number.isFinite(event.time) ? event.time : nowMillis(),
          item: { type: 'agentMessage', id: item.id, text: '', phase: null, memoryCitation: null, delivery: null }
        }
      });
    }
    item.text += chunk.text;
    events.push({
      method: 'item/agentMessage/delta',
      params: { threadId: this.threadId, turnId: turnState.id, itemId: item.id, delta: chunk.text }
    });
    return events;
  }

  assistantMessage(event) {
    const { turn, step, message } = event.data ?? {};
    if (!Number.isInteger(turn) || !Number.isInteger(step) || !message) return [];
    const turnState = this.turns.get(turn);
    if (!turnState) return [];
    const key = `${turn}:${step}`;
    const completedAtMs = Number.isFinite(event.time) ? event.time : nowMillis();
    const events = [];

    const finalReasoning = reasoningContent(message);
    let reasoning = this.reasoningItems.get(key);
    if (reasoning || finalReasoning.length > 0) {
      if (!reasoning) {
        reasoning = { id: `dsh-reasoning-${turn}-${step}`, content: [] };
        this.reasoningItems.set(key, reasoning);
        events.push({
          method: 'item/started',
          params: {
            threadId: this.threadId,
            turnId: turnState.id,
            startedAtMs: completedAtMs,
            item: { type: 'reasoning', id: reasoning.id, summary: [], content: [] }
          }
        });
      }
      reasoning.content = finalReasoning.length > 0 ? finalReasoning : reasoning.content;
      events.push({
        method: 'item/completed',
        params: {
          threadId: this.threadId,
          turnId: turnState.id,
          completedAtMs,
          item: { type: 'reasoning', id: reasoning.id, summary: [], content: reasoning.content }
        }
      });
    }

    const finalText = visibleText(message);
    let item = this.assistantItems.get(key);
    if (!item && finalText.length > 0) {
      item = { id: `dsh-assistant-${turn}-${step}`, text: '' };
      this.assistantItems.set(key, item);
      events.push({
        method: 'item/started',
        params: {
          threadId: this.threadId,
          turnId: turnState.id,
          startedAtMs: completedAtMs,
          item: { type: 'agentMessage', id: item.id, text: '', phase: null, memoryCitation: null, delivery: null }
        }
      });
    }
    if (item) {
      item.text = finalText;
      events.push({
        method: 'item/completed',
        params: {
          threadId: this.threadId,
          turnId: turnState.id,
          completedAtMs,
          item: { type: 'agentMessage', id: item.id, text: finalText, phase: null, memoryCitation: null, delivery: null }
        }
      });
    }
    return events;
  }

  toolCall(event) {
    const { turn, callId, name, arguments: rawArguments } = event.data ?? {};
    const turnState = this.turns.get(turn);
    if (!turnState || !callId || typeof name !== 'string') return [];
    const startedAtMs = Number.isFinite(event.time) ? event.time : nowMillis();

    let item;
    if (this.toolPresentation) {
      ({ item } = this.toolPresentation.start({
        turnId: turnState.id,
        callId,
        name,
        rawArguments,
        startedAtMs
      }));
    } else {
      item = {
        type: 'dynamicToolCall',
        id: `dsh-tool-${String(callId)}`,
        namespace: null,
        tool: name,
        arguments: parseJsonOrString(rawArguments),
        status: 'inProgress',
        contentItems: null,
        success: null,
        durationMs: null
      };
      this.tools.set(String(callId), { item, turnId: turnState.id, startedAt: startedAtMs });
    }

    return [{ method: 'item/started', params: { threadId: this.threadId, turnId: turnState.id, startedAtMs, item } }];
  }

  toolResult(event) {
    const callId = toolResultCallId(event.data);
    if (callId === undefined) return [];
    const completedAtMs = Number.isFinite(event.time) ? event.time : nowMillis();

    if (this.toolPresentation) {
      const completed = this.toolPresentation.complete({ callId, resultData: event.data, completedAtMs });
      if (!completed) return [];
      return [{
        method: 'item/completed',
        params: {
          threadId: this.threadId,
          turnId: completed.state.turnId,
          completedAtMs,
          item: completed.item
        }
      }];
    }

    const state = this.tools.get(String(callId));
    if (!state) return [];
    const failed = toolResultFailed(event.data);
    const completed = {
      ...state.item,
      status: failed ? 'failed' : 'completed',
      success: !failed,
      durationMs: Math.max(0, completedAtMs - state.startedAt)
    };
    this.tools.delete(String(callId));
    return [{ method: 'item/completed', params: { threadId: this.threadId, turnId: state.turnId, completedAtMs, item: completed } }];
  }

  todoWrite(event) {
    if (this.currentTurn == null) return [];
    const turnState = this.turns.get(this.currentTurn);
    if (!turnState) return [];
    const todos = Array.isArray(event.data?.todos) ? event.data.todos : [];
    return [{
      method: 'turn/plan/updated',
      params: {
        threadId: this.threadId,
        turnId: turnState.id,
        explanation: null,
        plan: todos.map((todo) => ({ step: String(todo.content ?? ''), status: mapPlanStatus(todo.status) }))
      }
    }];
  }
}
