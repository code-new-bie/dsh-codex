import assert from 'node:assert/strict';
import test from 'node:test';
import { DshWorkspaceCommandBridge, workspaceCommandInternals } from '../src/dsh/workspace-command.mjs';

function agent(id, cwd, calls) {
  const tools = {
    get(name) {
      return name === 'bash' ? { name: 'bash' } : undefined;
    },
    async execute(input) {
      calls.push(input);
      return {
        isError: false,
        value: {
          kind: 'foreground',
          exitCode: 7,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: 1234,
          stdout: { text: 'héllo\n', truncated: false },
          stderr: { text: 'warn\n', truncated: false }
        },
        content: [{ type: 'text', text: 'rendered output' }]
      };
    }
  };
  return {
    id,
    session: { header: { id, cwd } },
    ctx: { get(name) { return name === 'tools' ? tools : undefined; } }
  };
}

test('workspace command maps buffered Codex argv execution through official DSH tools', async () => {
  const calls = [];
  const a = agent('a', '/workspace/a', calls);
  const b = agent('b', '/workspace/b', calls);
  const bridge = new DshWorkspaceCommandBridge({
    driver: { listRootAgents() { return [a, b]; } }
  });

  const result = await bridge.execute({
    command: ['git', 'show', "a'b"],
    cwd: '/workspace/b',
    env: { NO_COLOR: '1', REMOVE_ME: null },
    timeoutMs: 1234,
    outputBytesCap: 5
  });

  assert.deepEqual(result, { exitCode: 7, stdout: 'héll', stderr: 'warn\n' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent, b);
  assert.equal(calls[0].name, 'bash');
  assert.equal(calls[0].arguments.workdir, '/workspace/b');
  assert.equal(calls[0].arguments.timeoutMs, 1234);
  assert.match(calls[0].arguments.command, /export NO_COLOR='1'/);
  assert.match(calls[0].arguments.command, /unset REMOVE_ME/);
  assert.match(calls[0].arguments.command, /'a'"'"'b'/);
});

test('workspace command quoting is dialect-safe for bash and PowerShell', () => {
  assert.equal(workspaceCommandInternals.bashQuote("a'b"), `'a'"'"'b'`);
  assert.equal(workspaceCommandInternals.pwshQuote("a'b"), `'a''b'`);
  assert.match(
    workspaceCommandInternals.commandText(['git', 'status'], { FLAG: "a'b" }, 'pwsh'),
    /\$env:FLAG = 'a''b'; & 'git' 'status'/
  );
});

test('workspace command preserves complete output when disableOutputCap is true', () => {
  const result = workspaceCommandInternals.bufferedResult({
    isError: false,
    value: {
      kind: 'foreground',
      exitCode: 0,
      stdout: { text: '0123456789' },
      stderr: { text: 'abcdefghij' }
    }
  }, { disableOutputCap: true, outputBytesCap: null });
  assert.deepEqual(result, { exitCode: 0, stdout: '0123456789', stderr: 'abcdefghij' });
});

test('workspace command rejects Codex capabilities DSHX cannot faithfully own', async () => {
  const calls = [];
  const bridge = new DshWorkspaceCommandBridge({
    driver: { listRootAgents() { return [agent('a', process.cwd(), calls)]; } }
  });
  await assert.rejects(
    () => bridge.execute({ command: ['git'], tty: true }),
    /buffered non-TTY/
  );
  await assert.rejects(
    () => bridge.execute({ command: ['git'], sandboxPolicy: { type: 'dangerFullAccess' } }),
    /active DSH session permission policy/
  );
  await assert.rejects(
    () => bridge.execute({ command: ['git'], disableTimeout: true }),
    /does not override the DSH shell executor timeout policy/
  );
});

test('workspace command fails closed when multiple active roots are ambiguous', async () => {
  const calls = [];
  const bridge = new DshWorkspaceCommandBridge({
    driver: {
      listRootAgents() {
        return [agent('a', '/one', calls), agent('b', '/two', calls)];
      }
    }
  });
  await assert.rejects(
    () => bridge.execute({ command: ['git', 'status'] }),
    /cannot choose among multiple active DSH root Agents/
  );
});
