import { DshToolPresentationResolver } from './tool-presentation.mjs';

const MODEL_PREFIX = 'dshx:';
const DEFAULT_REASONING_SENTINEL = 'dsh-default';
const DSH_SUBAGENT_DESCRIPTOR_VERSION = 2;

function seconds(timeMs, fallback = Math.floor(Date.now() / 1000)) {
  return Number.isFinite(timeMs) ? Math.floor(timeMs / 1000) : fallback;
}

function visibleText(content) {
  return (content ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function visibleReasoning(content) {
  return (content ?? [])
    .filter((block) => block?.type === 'reasoning' && typeof block.text === 'string')
    .map((block) => block.text);
}

function latestRequestConfig(events) {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'request/header') return event.data?.header?.config ?? null;
  }
  return null;
}

function firstHumanPreview(events) {
  for (const event of events ?? []) {
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'user') continue;
    const text = visibleText(event.data.content).trim();
    if (text) return text.slice(0, 240);
  }
  return '';
}

function turnStatus(reason) {
  switch (reason?.kind) {
    case 'completed': return 'completed';
    case 'aborted':
    case 'interrupted': return 'interrupted';
    default: return 'failed';
  }
}

function turnError(reason) {
  if (reason?.kind !== 'error') return null;
  return {
    message: reason.error?.message ?? 'DSH turn failed',
    codexErrorInfo: null,
    additionalDetails: null
  };
}

function compactionError(message) {
  return message == null
    ? null
    : { message: String(message), codexErrorInfo: null, additionalDetails: null };
}

function normalizeList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.entries)) return value.entries;
  return [];
}

function subagentDescriptor(events = []) {
  const event = events.find((candidate) => candidate?.type === 'subagent/descriptor');
  const value = event?.data;
  if (!value || value.version !== DSH_SUBAGENT_DESCRIPTOR_VERSION) return null;
  if ((value.mode !== 'one-shot' && value.mode !== 'continuable') || typeof value.provider !== 'string') return null;
  return {
    mode: value.mode,
    provider: value.provider,
    label: typeof value.label === 'string' && value.label.length > 0 ? value.label : null
  };
}

function sourceForHeader(header, events = []) {
  if (header?.origin === 'subagent' && header.parentSession != null) {
    const descriptor = subagentDescriptor(events);
    return {
      subagent: {
        thread_spawn: {
          parent_thread_id: String(header.parentSession),
          depth: Number.isInteger(header.delegationDepth) ? header.delegationDepth : 1,
          agent_path: null,
          agent_nickname: descriptor?.label ?? null,
          agent_role: null
        }
      }
    };
  }
  return { custom: 'dshx' };
}

function inputFromDshMessage(message) {
  const content = [];
  for (const block of message?.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      content.push({ type: 'text', text: block.text, text_elements: [] });
    }
  }
  return content;
}

function historyTurn(id, startedAt) {
  return {
    id,
    items: [],
    itemsView: 'full',
    status: 'inProgress',
    error: null,
    startedAt,
    completedAt: null,
    durationMs: null
  };
}

export function encodeDshModel(selection) {
  if (!selection?.provider || !selection?.model) throw new Error('DSHX model selection requires provider and model');
  const payload = Buffer.from(JSON.stringify([selection.provider, selection.model]), 'utf8').toString('base64url');
  return `${MODEL_PREFIX}${payload}`;
}

export function decodeDshModel(value) {
  if (typeof value !== 'string' || !value.startsWith(MODEL_PREFIX)) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value.slice(MODEL_PREFIX.length), 'base64url').toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== 2 || decoded.some((part) => typeof part !== 'string' || !part)) {
      return undefined;
    }
    return { provider: decoded[0], model: decoded[1] };
  } catch {
    return undefined;
  }
}

export function normalizeCodexEffort(value) {
  return value === DEFAULT_REASONING_SENTINEL ? undefined : value;
}

/**
 * Translate the public DSH LLM registry into Codex's provider-less model picker.
 * Provider identity is encoded only in the opaque `model`/`id` value and decoded
 * again by DSHX before calling `ctx.llm.resolveCallConfig()`.
 */
export function codexModelsFromDsh(directory, currentSelection) {
  const groups = directory?.groups ?? [];
  const multipleProviders = groups.length > 1;
  const models = [];
  for (const group of groups) {
    for (const model of group.models ?? []) {
      const encoded = encodeDshModel({ provider: group.provider, model: model.id });
      const efforts = model.reasoning?.efforts ?? [];
      const supportedReasoningEfforts = efforts.length > 0
        ? efforts.map((effort) => ({
            reasoningEffort: effort.id,
            description: effort.description ?? effort.name ?? effort.id
          }))
        : [{ reasoningEffort: DEFAULT_REASONING_SENTINEL, description: 'Use the DSH provider default' }];
      const defaultReasoningEffort = model.reasoning?.defaultEffort ?? DEFAULT_REASONING_SENTINEL;
      const displayName = multipleProviders
        ? `${model.name ?? model.id} · ${group.name ?? group.provider}`
        : (model.name ?? model.id);
      models.push({
        id: encoded,
        model: encoded,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName,
        description: model.description ?? `${group.name ?? group.provider} / ${model.id}`,
        modelSpecialty: null,
        hidden: false,
        supportedReasoningEfforts,
        defaultReasoningEffort,
        inputModalities: (model.inputModalities ?? []).filter((entry) => entry === 'text' || entry === 'image'),
        supportsPersonality: false,
        multiAgentVersion: null,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        isDefault: currentSelection?.provider === group.provider && currentSelection?.model === model.id
      });
    }
  }
  return models;
}

export function dshThreadFromSnapshot({ meta, events = [], model, turns = [], loaded = false, cliVersion = 'dshx' }) {
  if (!meta?.id) throw new Error('DSHX thread projection requires SessionHeader.id');
  const config = model ?? latestRequestConfig(events) ?? {};
  const createdAt = seconds(meta.createdAt);
  const lastTime = events.length > 0 ? events[events.length - 1]?.time : meta.createdAt;
  const isSubagent = meta.origin === 'subagent';
  const descriptor = isSubagent ? subagentDescriptor(events) : null;
  let openTurn = false;
  for (const event of events) {
    if (event?.type === 'turn/start') openTurn = true;
    else if (event?.type === 'turn/end') openTurn = false;
  }
  return {
    id: String(meta.id),
    extra: null,
    sessionId: String(meta.id),
    forkedFromId: !isSubagent && meta.parentSession ? String(meta.parentSession) : null,
    parentThreadId: isSubagent && meta.parentSession ? String(meta.parentSession) : null,
    preview: firstHumanPreview(events),
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: 'paginated',
    modelProvider: config.provider ?? 'dsh',
    createdAt,
    updatedAt: seconds(lastTime, createdAt),
    recencyAt: seconds(lastTime, createdAt),
    status: loaded ? (openTurn ? { type: 'active', activeFlags: [] } : { type: 'idle' }) : { type: 'notLoaded' },
    path: null,
    cwd: meta.cwd ?? process.cwd(),
    cliVersion,
    source: sourceForHeader(meta, events),
    // DSH continuation authority belongs to ctx.subagents. Showing a child in
    // Codex navigation must never create a presentation-side bypass that sends
    // a user turn directly to the child Agent.
    canAcceptDirectInput: isSubagent ? false : loaded ? true : null,
    threadSource: null,
    agentNickname: descriptor?.label ?? null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns
  };
}

/**
 * Replay the authoritative DSH raw log as a human transcript. This intentionally
 * does not fold the model surface: DSH's own terminal/web transcript contract
 * keeps messages shadowed by compaction visible to the human and inserts a
 * compaction marker at the landed checkpoint. The plugin-sourced replacement
 * user/message is therefore ignored as model-only framing.
 */
export function dshTurnsFromSession({ ctx, agent, diagnostics = () => {} }) {
  const session = agent?.session;
  if (!session) return [];
  const turns = new Map();
  const compactions = new Map();
  let currentTurn;
  const toolPresenter = new DshToolPresentationResolver({
    ctx: agent.ctx ?? ctx,
    agent,
    threadId: String(agent.id),
    workspaceCwd: session.header?.cwd ?? process.cwd(),
    diagnostics
  });

  for (const event of session.events ?? []) {
    switch (event.type) {
      case 'turn/start': {
        const number = event.data?.turn;
        if (!Number.isInteger(number)) break;
        const startedAt = seconds(event.time);
        turns.set(number, historyTurn(`dsh-turn-${number}`, startedAt));
        currentTurn = number;
        break;
      }
      case 'user/message': {
        const turn = turns.get(currentTurn);
        const message = event.data;
        if (!turn || message?.source?.kind !== 'user') break;
        const content = inputFromDshMessage(message);
        if (content.length === 0) break;
        turn.items.push({ type: 'userMessage', id: String(message.id), clientId: null, content });
        break;
      }
      case 'assistant/message': {
        const turn = turns.get(event.data?.turn);
        const message = event.data?.message;
        if (!turn || !message) break;
        const reasoning = visibleReasoning(message.content);
        if (reasoning.length > 0) {
          turn.items.push({
            type: 'reasoning',
            id: `dsh-reasoning-${event.data.turn}-${event.data.step}`,
            summary: [],
            content: reasoning
          });
        }
        const text = visibleText(message.content);
        if (text.length > 0) {
          turn.items.push({
            type: 'agentMessage',
            id: String(message.id ?? `dsh-assistant-${event.data.turn}-${event.data.step}`),
            text,
            phase: null,
            memoryCitation: null,
            delivery: null
          });
        }
        break;
      }
      case 'tool/call': {
        const turn = turns.get(event.data?.turn);
        if (!turn) break;
        const projected = toolPresenter.start({
          turnId: turn.id,
          callId: event.data.callId,
          name: event.data.name,
          rawArguments: event.data.arguments,
          startedAtMs: event.time
        });
        turn.items.push(projected.item);
        break;
      }
      case 'tool/result': {
        const callId = event.data?.message?.source?.callId
          ?? event.data?.message?.content?.find?.((block) => block?.type === 'tool-result')?.toolCallId;
        if (!callId) break;
        const completed = toolPresenter.complete({ callId, resultData: event.data, completedAtMs: event.time });
        if (!completed) break;
        for (const turn of turns.values()) {
          const index = turn.items.findIndex((item) => item.id === completed.item.id);
          if (index >= 0) {
            turn.items[index] = completed.item;
            break;
          }
        }
        break;
      }
      case 'compaction/start': {
        const { compactionId, turn } = event.data ?? {};
        if (typeof compactionId !== 'string' || compactionId.length === 0) break;
        let turnKey;
        let target;
        let manual = false;
        if (Number.isInteger(turn)) {
          turnKey = turn;
          target = turns.get(turnKey);
          if (!target) break;
        } else if (turn === null) {
          manual = true;
          turnKey = `compact:${compactionId}`;
          target = historyTurn(`dsh-maintenance-compaction-${compactionId}`, seconds(event.time));
          turns.set(turnKey, target);
        } else {
          break;
        }
        compactions.set(compactionId, {
          turnKey,
          turn: target,
          manual,
          summarized: false,
          itemId: `dsh-compaction-${compactionId}`
        });
        break;
      }
      case 'compaction/summary': {
        const state = compactions.get(event.data?.compactionId);
        if (!state) break;
        state.summarized = true;
        state.turn.items.push({ type: 'contextCompaction', id: state.itemId });
        break;
      }
      case 'compaction/end': {
        const state = compactions.get(event.data?.compactionId);
        if (!state) break;
        compactions.delete(event.data.compactionId);
        if (state.manual) {
          if (!state.summarized) {
            turns.delete(state.turnKey);
            break;
          }
          const completedAt = seconds(event.time);
          state.turn.status = event.data?.error == null ? 'completed' : 'failed';
          state.turn.error = compactionError(event.data?.error);
          state.turn.completedAt = completedAt;
          state.turn.durationMs = state.turn.startedAt == null
            ? null
            : Math.max(0, (completedAt - state.turn.startedAt) * 1000);
        }
        break;
      }
      case 'turn/end': {
        const number = event.data?.turn;
        const turn = turns.get(number);
        if (!turn) break;
        const completedAt = seconds(event.time);
        turn.status = turnStatus(event.data.reason);
        turn.error = turnError(event.data.reason);
        turn.completedAt = completedAt;
        turn.durationMs = turn.startedAt == null ? null : Math.max(0, (completedAt - turn.startedAt) * 1000);
        if (currentTurn === number) currentTurn = undefined;
        break;
      }
      default:
        break;
    }
  }
  return [...turns.values()];
}

export function normalizeSessionHeaders(value) {
  return normalizeList(value);
}

export const internals = {
  DEFAULT_REASONING_SENTINEL,
  latestRequestConfig,
  firstHumanPreview,
  inputFromDshMessage,
  visibleReasoning,
  subagentDescriptor,
  sourceForHeader
};
