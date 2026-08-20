import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const nowSeconds = () => Math.floor(Date.now() / 1000);
const nowMillis = () => Date.now();
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function platformFamily() {
  return process.platform === 'win32' ? 'windows' : 'unix';
}

function platformOs() {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'linux') return 'linux';
  return process.platform;
}

function absoluteCwd(value) {
  return path.resolve(value || process.cwd());
}

function modelRecord() {
  return {
    id: 'dshx-stub',
    model: 'dshx-stub',
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: 'DSHX Protocol Stub',
    description: 'Deterministic M0 model used only to validate Codex TUI protocol compatibility.',
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: 'medium', description: 'M0 deterministic protocol mode' }
    ],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: true
  };
}

function emptyThread(cwd) {
  const timestamp = nowSeconds();
  // Codex treats thread IDs as UUIDs and validates them before opening a remote thread.
  // Keep the deterministic protocol stub aligned with that public app-server contract.
  const threadId = crypto.randomUUID();
  return {
    id: threadId,
    sessionId: threadId,
    forkedFromId: null,
    parentThreadId: null,
    preview: '',
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    modelProvider: 'dsh',
    createdAt: timestamp,
    updatedAt: timestamp,
    recencyAt: timestamp,
    status: { type: 'idle' },
    path: null,
    cwd,
    cliVersion: '0.0.0-m0',
    source: { custom: 'dshx' },
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: null,
    name: null,
    turns: []
  };
}

function turnRecord(turnId, status = 'inProgress', completed = false) {
  const startedAt = nowSeconds();
  return {
    id: turnId,
    items: [],
    itemsView: 'full',
    status,
    error: null,
    startedAt,
    completedAt: completed ? nowSeconds() : null,
    durationMs: completed ? 0 : null
  };
}

function textFromTurnStart(params = {}) {
  const input = Array.isArray(params.input) ? params.input : [];
  return input
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n')
    .trim();
}

export class ProtocolStub {
  constructor({ cwd = process.cwd(), home = null } = {}) {
    this.cwd = absoluteCwd(cwd);
    this.home = home ? path.resolve(home) : path.join(os.homedir(), '.dshx');
    this.threads = new Map();
    this.activeTurns = new Map();
  }

  dispatch(method, params) {
    switch (method) {
      case 'initialize':
        return {
          result: {
            userAgent: 'dsh-codex-app-server/0.0.0-m0',
            codexHome: this.home,
            platformFamily: platformFamily(),
            platformOs: platformOs()
          }
        };
      case 'account/read':
        return { result: { account: null, requiresOpenaiAuth: false } };
      case 'model/list':
        return { result: { data: [modelRecord()], nextCursor: null } };
      case 'configRequirements/read':
        return { result: { requirements: null } };
      case 'skills/list':
        return { result: { data: [] } };
      case 'thread/list':
        return { result: { data: [...this.threads.values()], nextCursor: null, backwardsCursor: null } };
      case 'thread/start':
        return this.startThread(params);
      case 'turn/start':
        return this.startTurn(params);
      case 'turn/interrupt':
        return this.interruptTurn(params);
      default:
        return {
          result: undefined,
          events: [],
          error: { code: -32601, message: `Method not found: ${method}` }
        };
    }
  }

  startThread(params) {
    const cwd = absoluteCwd(params.cwd || this.cwd);
    const thread = emptyThread(cwd);
    this.threads.set(thread.id, thread);
    return {
      result: {
        thread,
        model: 'dshx-stub',
        modelProvider: 'dsh',
        serviceTier: null,
        cwd,
        instructionSources: [],
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: {
          type: 'workspaceWrite',
          writableRoots: [cwd],
          networkAccess: false,
          excludeTmpdirEnvVar: false,
          excludeSlashTmp: false
        },
        reasoningEffort: 'medium'
      },
      events: [this.notification('thread/started', { thread })]
    };
  }

  startTurn(params) {
    const threadId = params.threadId;
    if (typeof threadId !== 'string' || !this.threads.has(threadId)) {
      throw new Error(`Unknown thread: ${threadId ?? '<missing>'}`);
    }

    const turnId = id('turn');
    const itemId = id('item');
    const turn = turnRecord(turnId);
    const prompt = textFromTurnStart(params);
    const answer = prompt
      ? `DSHX protocol stub received: ${prompt}`
      : 'DSHX protocol stub is connected.';
    const chunks = answer.match(/.{1,24}(?:\s|$)/g) ?? [answer];
    const startedItem = {
      type: 'agentMessage',
      id: itemId,
      text: '',
      phase: null,
      memoryCitation: null,
      delivery: null
    };
    const completedItem = { ...startedItem, text: answer };
    const completedTurn = turnRecord(turnId, 'completed', true);
    completedTurn.items = [completedItem];

    this.activeTurns.set(threadId, { turnId, itemId, startedAt: nowSeconds() });
    const events = [
      this.notification('turn/started', { threadId, turn }),
      this.notification('item/started', {
        item: startedItem,
        threadId,
        turnId,
        startedAtMs: nowMillis()
      }),
      ...chunks.map((delta) =>
        this.notification('item/agentMessage/delta', { threadId, turnId, itemId, delta })
      ),
      this.notification('item/completed', {
        item: completedItem,
        threadId,
        turnId,
        completedAtMs: nowMillis()
      }),
      this.notification('turn/completed', { threadId, turn: completedTurn })
    ];

    return { result: { turn }, events };
  }

  interruptTurn(params) {
    const threadId = params.threadId;
    const active = this.activeTurns.get(threadId);
    if (!active) return { result: {} };
    this.activeTurns.delete(threadId);
    const turn = {
      ...turnRecord(active.turnId, 'interrupted', true),
      startedAt: active.startedAt
    };
    return {
      result: {},
      events: [this.notification('turn/completed', { threadId, turn })]
    };
  }

  isTurnActive(threadId, turnId) {
    return this.activeTurns.get(threadId)?.turnId === turnId;
  }

  completeTurn(threadId, turnId) {
    if (this.isTurnActive(threadId, turnId)) this.activeTurns.delete(threadId);
  }

  notification(method, params) {
    return { method, params };
  }

  error(requestId, code, message, data = undefined) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    return { id: requestId, error };
  }
}

export function normalizeDispatchResult(stub, message) {
  const { id: requestId, method } = message ?? {};
  if (requestId === undefined || typeof method !== 'string') {
    return { response: stub.error(requestId ?? null, -32600, 'Invalid Request'), events: [] };
  }

  try {
    const dispatched = stub.dispatch(method, message?.params ?? {});
    if (dispatched.error) {
      return {
        response: stub.error(requestId, dispatched.error.code, dispatched.error.message),
        events: []
      };
    }
    return {
      response: { id: requestId, result: dispatched.result },
      events: dispatched.events ?? []
    };
  } catch (error) {
    return {
      response: stub.error(
        requestId,
        -32603,
        error instanceof Error ? error.message : String(error)
      ),
      events: []
    };
  }
}
