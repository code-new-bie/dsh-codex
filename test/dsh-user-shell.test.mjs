import assert from 'node:assert/strict';
import test from 'node:test';
import { DshToolPresentationResolver } from '../src/dsh/tool-presentation.mjs';
import { DshUserShellBridge } from '../src/dsh/user-shell.mjs';

function fixture({ activeTurn = null, execute } = {}) {
  const sent = [];
  const calls = [];
  const session = { header: { cwd: process.cwd() }, events: [] };
  const definition = {
    presentCall(args) {
      return { card: 'terminal', title: args.command, cwd: args.workdir };
    },
    presentResult(_args, result) {
      const text = result.content?.find?.((block) => block?.type === 'text')?.text ?? '';
      return { card: 'terminal', output: text, exitCode: result.isError ? 1 : 0 };
    }
  };
  const tools = {
    get(name) {
      if (name === 'bash' || name === 'pwsh') return definition;
      return undefined;
    },
    async execute(input) {
      calls.push(input);
      if (execute) return execute(input);
      return { isError: false, value: {}, content: [{ type: 'text', text: 'safe output\n' }] };
    }
  };
  const agent = {
    id: 'session-1',
    session,
    ctx: { get(name) { return name === 'tools' ? tools : undefined; } }
  };
  const controller = {
    threadId: 'session-1',
    agent,
    currentLocation() {
      return activeTurn ? { threadId: 'session-1', turnId: activeTurn } : undefined;
    }
  };
  controller.toolPresentation = new DshToolPresentationResolver({
    ctx: agent.ctx,
    agent,
    threadId: controller.threadId,
    workspaceCwd: session.header.cwd
  });
  const bridge = new DshUserShellBridge({ send: (message) => sent.push(message) });
  return { bridge, controller, sent, calls, session };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test('idle bang shell uses a non-durable presentation turn and DSH ToolRuntime', async () => {
  const fx = fixture();
  const response = fx.bridge.start(fx.controller, 'echo hello');
  assert.deepEqual(response.result, {});
  assert.deepEqual(fx.sent, [], 'events must wait until shellCommand RPC response');
  response.afterResponse();
  await settle();

  assert.equal(fx.calls.length, 1);
  const input = fx.calls[0];
  assert.equal(input.agent, fx.controller.agent);
  assert.equal(input.arguments.command, 'echo hello');
  assert.equal(input.arguments.workdir, process.cwd());
  assert.equal(input.arguments.run_in_background, false);
  assert.equal('sandbox_permissions' in input.arguments, false);
  assert.equal(input.signal instanceof AbortSignal, true);
  assert.ok(input.name === 'bash' || input.name === 'pwsh');

  assert.deepEqual(fx.sent.map((message) => message.method), [
    'turn/started',
    'item/started',
    'item/completed',
    'turn/completed'
  ]);
  assert.equal(fx.sent[1].params.item.type, 'commandExecution');
  assert.equal(fx.sent[1].params.item.source, 'userShell');
  assert.equal(fx.sent[2].params.item.source, 'userShell');
  assert.equal(fx.sent[2].params.item.aggregatedOutput, 'safe output\n');
  assert.deepEqual(fx.session.events, [], 'user shell stays out of durable DSH conversation history');
});

test('bang shell during an active DSH turn attaches only its command item to that live turn', async () => {
  const fx = fixture({ activeTurn: 'dsh-turn-4' });
  const response = fx.bridge.start(fx.controller, 'pwd');
  response.afterResponse();
  await settle();
  assert.deepEqual(fx.sent.map((message) => message.method), ['item/started', 'item/completed']);
  assert.equal(fx.sent[0].params.turnId, 'dsh-turn-4');
  assert.equal(fx.sent[1].params.turnId, 'dsh-turn-4');
});

test('Ctrl+C aborts the exact official DSH tool signal instead of killing a host process directly', async () => {
  let observedAbort = false;
  const fx = fixture({
    execute: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        observedAbort = true;
        resolve({
          isError: true,
          error: { message: 'aborted' },
          content: [{ type: 'text', text: 'aborted' }]
        });
      }, { once: true });
    })
  });
  const response = fx.bridge.start(fx.controller, 'sleep 30');
  const state = fx.bridge.active.get('session-1');
  assert.ok(state);
  response.afterResponse();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.bridge.interrupt('session-1', state.turnId), true);
  await settle();
  assert.equal(observedAbort, true);
  assert.equal(fx.bridge.active.has('session-1'), false);
});

test('thread close aborts active DSH shell execution', async () => {
  let observedAbort = false;
  const fx = fixture({
    execute: ({ signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        observedAbort = true;
        resolve({ isError: true, error: { message: 'closed' }, content: [] });
      }, { once: true });
    })
  });
  const response = fx.bridge.start(fx.controller, 'long command');
  response.afterResponse();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.bridge.abortThread('session-1'), true);
  await settle();
  assert.equal(observedAbort, true);
});
