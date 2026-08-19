import assert from 'node:assert/strict';
import test from 'node:test';
import { DshxReleaseAdapter } from '../src/dsh/release-adapter.mjs';

function childController() {
  let cancelled = 0;
  const agent = {
    id: 'child-1',
    session: {
      header: {
        id: 'child-1',
        origin: 'subagent',
        parentSession: 'root-1',
        cwd: '/work'
      }
    },
    cancel() { cancelled += 1; }
  };
  return { controller: { agent }, cancelled: () => cancelled };
}

function adapterWithChild() {
  const { controller, cancelled } = childController();
  const adapter = Object.create(DshxReleaseAdapter.prototype);
  adapter.controllers = new Map([['child-1', controller]]);
  adapter.diagnostics = () => {};
  return { adapter, controller, cancelled };
}

test('Codex direct turns cannot bypass DSH continuation authority for child agents', async () => {
  const { adapter } = adapterWithChild();
  await assert.rejects(
    () => adapter.richUserTurn('turn/start', {
      threadId: 'child-1',
      input: [{ type: 'text', text: 'bypass child authority', text_elements: [] }]
    }),
    /send\/steer authority remains owned by ctx\.subagents/
  );
  await assert.rejects(
    () => adapter.richUserTurn('turn/steer', {
      threadId: 'child-1',
      expectedTurnId: 'dsh-turn-1',
      input: [{ type: 'text', text: 'bypass steer', text_elements: [] }]
    }),
    /ctx\.subagents/
  );
});

test('Codex shell, compaction, and settings are presentation-blocked on child agents', async () => {
  const { adapter } = adapterWithChild();
  assert.throws(
    () => adapter.threadShellCommand({ threadId: 'child-1', command: 'pwd' }),
    /child runtime control remains owned by ctx\.subagents/
  );
  assert.throws(
    () => adapter.directController('child-1', 'direct compaction'),
    /child runtime control remains owned by ctx\.subagents/
  );
  await assert.rejects(
    () => adapter.threadSettingsUpdatePresentation({ threadId: 'child-1', model: 'anything' }),
    /composition remains DSH-owned/
  );
});

test('child interrupt delegates only to official ctx.subagents interrupt authority', async () => {
  const { adapter, controller, cancelled } = adapterWithChild();
  const calls = [];
  adapter.ctx = {
    get(name) {
      if (name !== 'subagents') return undefined;
      return {
        async interrupt(childId, authority) {
          calls.push({ childId, authority });
        }
      };
    }
  };

  assert.deepEqual(await adapter.interruptSubagent(controller), { result: {} });
  assert.deepEqual(calls, [{
    childId: 'child-1',
    authority: { kind: 'user', parentSessionId: 'root-1' }
  }]);
  assert.equal(cancelled(), 0, 'DSHX must not call child Agent.cancel() directly');
});

test('child interrupt fails closed without durable parent authority', async () => {
  const { adapter, controller } = adapterWithChild();
  controller.agent.session.header.parentSession = undefined;
  adapter.ctx = { get() { throw new Error('subagent service must not be consulted without parent authority'); } };
  await assert.rejects(
    () => adapter.interruptSubagent(controller),
    /missing durable parentSession authority/
  );
});
