import assert from 'node:assert/strict';
import test from 'node:test';
import { dshThreadFromSnapshot } from '../src/tui-protocol/shapes.mjs';
import { DshxPresentationAdapter } from '../src/tui-protocol/adapter.mjs';

function childAgent() {
  return {
    id: 'child-1',
    status: 'running',
    session: {
      header: {
        id: 'child-1',
        origin: 'subagent',
        parentSession: 'root-1',
        delegationDepth: 2,
        createdAt: 1_700_000_000_000,
        cwd: '/work'
      },
      events: [
        {
          type: 'subagent/descriptor',
          time: 1_700_000_000_010,
          data: { version: 2, mode: 'continuable', provider: 'in-process', label: 'Scout' }
        }
      ],
      requestHeader() { return { config: { provider: 'deepseek', model: 'model-a' } }; }
    }
  };
}

test('DSH subagent lineage becomes native Codex thread_spawn metadata without fake fork ancestry', () => {
  const agent = childAgent();
  const thread = dshThreadFromSnapshot({
    meta: agent.session.header,
    events: agent.session.events,
    model: agent.session.requestHeader().config,
    loaded: true
  });

  assert.equal(thread.forkedFromId, null);
  assert.equal(thread.parentThreadId, 'root-1');
  assert.equal(thread.agentNickname, 'Scout');
  assert.equal(thread.agentRole, null);
  assert.equal(thread.canAcceptDirectInput, false);
  assert.deepEqual(thread.source, {
    subagent: {
      thread_spawn: {
        parent_thread_id: 'root-1',
        depth: 2,
        agent_path: null,
        agent_nickname: 'Scout',
        agent_role: null
      }
    }
  });
});

test('release loaded-thread wire response lists official DSH live ids while rich child metadata stays on thread projections', () => {
  const root = {
    id: 'root-1',
    status: 'idle',
    session: {
      header: { id: 'root-1', createdAt: 1_700_000_000_000, cwd: '/work' },
      events: [],
      requestHeader() { return { config: { provider: 'deepseek', model: 'model-a' } }; }
    }
  };
  const child = childAgent();
  const adapter = Object.create(DshxPresentationAdapter.prototype);
  adapter.version = 'test';
  adapter.driver = {
    listLive() { return [root, child]; },
    currentTitle(agent) { return agent.id === 'child-1' ? { title: 'Scout' } : undefined; }
  };

  const response = adapter.loadedThreadList();
  assert.deepEqual(response.result.data, ['root-1', 'child-1']);

  const projectedChild = adapter.liveAgentThread(child);
  assert.equal(projectedChild.name, 'Scout');
  assert.equal(projectedChild.status.type, 'active');
  assert.equal(projectedChild.canAcceptDirectInput, false);
  assert.equal(projectedChild.source.subagent.thread_spawn.parent_thread_id, 'root-1');
});