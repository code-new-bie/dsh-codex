import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ProtocolStub, normalizeDispatchResult } from '../devtools/protocol-poc.mjs';

function request(stub, id, method, params = {}) {
  return normalizeDispatchResult(stub, { id, method, params });
}

const workspace = path.resolve('tmp', 'workspace');
const dshxHome = path.resolve('tmp', 'dshx-home');

test('initialize matches Codex remote handshake fields', () => {
  const stub = new ProtocolStub({ cwd: workspace, home: dshxHome });
  const { response } = request(stub, 'initialize', 'initialize', {
    clientInfo: { name: 'codex-tui', version: 'test' }
  });
  assert.equal(response.id, 'initialize');
  assert.equal(response.result.codexHome, dshxHome);
  assert.match(response.result.userAgent, /^dsh-codex-app-server\//);
  assert.equal(typeof response.result.platformFamily, 'string');
  assert.equal(typeof response.result.platformOs, 'string');
});

test('bootstrap methods return auth-free model catalog', () => {
  const stub = new ProtocolStub({ cwd: workspace });
  assert.deepEqual(request(stub, 1, 'account/read').response.result, {
    account: null,
    requiresOpenaiAuth: false
  });
  const models = request(stub, 2, 'model/list').response.result;
  assert.equal(models.data.length, 1);
  assert.equal(models.data[0].model, 'dshx-stub');
  assert.equal(models.data[0].isDefault, true);
  assert.deepEqual(request(stub, 3, 'configRequirements/read').response.result, {
    requirements: null
  });
});

test('thread start emits thread/started and uses DSH-like provider identity', () => {
  const stub = new ProtocolStub({ cwd: workspace });
  const { response, events } = request(stub, 4, 'thread/start', { cwd: workspace });
  assert.equal(response.result.modelProvider, 'dsh');
  assert.equal(response.result.thread.modelProvider, 'dsh');
  assert.equal(response.result.thread.status.type, 'idle');
  assert.equal(response.result.cwd, workspace);
  assert.equal(response.result.thread.cwd, workspace);
  assert.equal(events[0].method, 'thread/started');
  assert.equal(events[0].params.thread.id, response.result.thread.id);
});

test('turn start emits the minimal Codex streaming lifecycle', () => {
  const stub = new ProtocolStub({ cwd: workspace });
  const thread = request(stub, 4, 'thread/start', { cwd: workspace }).response.result.thread;
  const { response, events } = request(stub, 5, 'turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'hello dshx', text_elements: [] }]
  });
  assert.equal(response.result.turn.status, 'inProgress');
  assert.equal(events[0].method, 'turn/started');
  assert.equal(events[1].method, 'item/started');
  assert.ok(events.some((event) => event.method === 'item/agentMessage/delta'));
  assert.equal(events.at(-2).method, 'item/completed');
  assert.equal(events.at(-1).method, 'turn/completed');
  assert.match(events.at(-2).params.item.text, /hello dshx/);
});

test('interrupt emits an interrupted turn completion', () => {
  const stub = new ProtocolStub({ cwd: workspace });
  const thread = request(stub, 10, 'thread/start', { cwd: workspace }).response.result.thread;
  const started = request(stub, 11, 'turn/start', {
    threadId: thread.id,
    input: [{ type: 'text', text: 'long task', text_elements: [] }]
  });
  const turnId = started.response.result.turn.id;
  assert.equal(stub.isTurnActive(thread.id, turnId), true);
  const interrupted = request(stub, 12, 'turn/interrupt', { threadId: thread.id, turnId });
  assert.deepEqual(interrupted.response.result, {});
  assert.equal(stub.isTurnActive(thread.id, turnId), false);
  assert.equal(interrupted.events[0].method, 'turn/completed');
  assert.equal(interrupted.events[0].params.turn.status, 'interrupted');
});

test('unknown method is rejected with JSON-RPC method-not-found', () => {
  const stub = new ProtocolStub();
  const { response } = normalizeDispatchResult(stub, { id: 9, method: 'nope/unknown', params: {} });
  assert.equal(response.error.code, -32601);
});
