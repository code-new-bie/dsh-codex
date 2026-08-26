import path from 'node:path';

function parseArguments(raw) {
  if (typeof raw !== 'string') return raw ?? {};
  try { return JSON.parse(raw); } catch { return { raw }; }
}

function toolResultFromEvent(data) {
  const block = data?.message?.content?.find?.((entry) => entry?.type === 'tool-result');
  return {
    content: Array.isArray(block?.content) ? block.content : [],
    isError: Boolean(block?.isError ?? data?.error),
    ...(data?.meta === undefined ? {} : { meta: data.meta })
  };
}

function textContentItems(content) {
  const items = [];
  for (const block of content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      items.push({ type: 'inputText', text: block.text });
    }
  }
  return items.length === 0 ? null : items;
}

function resolveCwd(workspaceCwd, candidate) {
  if (!candidate) return workspaceCwd;
  return path.isAbsolute(candidate) ? candidate : path.resolve(workspaceCwd, candidate);
}

function lineCount(text) {
  if (text === '') return 0;
  return text.split(/\r?\n/).length;
}

function displayDiff(file) {
  // DSH FileDiff may represent a contextual hunk rather than whole-file text.
  // Codex only needs display diff text here; avoid fabricating source line numbers.
  const oldLines = String(file.oldText ?? '').split(/\r?\n/);
  const newLines = String(file.newText ?? '').split(/\r?\n/);
  const oldCount = lineCount(String(file.oldText ?? ''));
  const newCount = lineCount(String(file.newText ?? ''));
  return [
    `--- a/${file.path}`,
    `+++ b/${file.path}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`)
  ].join('\n');
}

function canUseCodexFileChange(view) {
  return view?.card === 'diff' &&
    Array.isArray(view.diffs) &&
    view.diffs.length > 0 &&
    view.diffs.every((diff) => typeof diff?.path === 'string' && diff.oldText !== null);
}

function fileChangeItem(id, view, status) {
  return {
    type: 'fileChange',
    id,
    changes: view.diffs.map((diff) => ({
      path: diff.path,
      kind: { type: 'update', move_path: null },
      diff: displayDiff(diff)
    })),
    status
  };
}

function dynamicItem(id, toolName, args, status, result = null, durationMs = null) {
  return {
    type: 'dynamicToolCall',
    id,
    namespace: null,
    tool: toolName,
    arguments: args,
    status,
    contentItems: result ? textContentItems(result.content) : null,
    success: result ? !result.isError : null,
    durationMs
  };
}

/**
 * Resolves UI semantics exclusively through DSH ToolDefinition presenters.
 *
 * No tool names or argument schemas are embedded here. `ctx.tools.get(name,
 * agent)` is authoritative for the definition visible to this Agent; its pure
 * `presentCall/presentResult` methods decide terminal/diff/generic intent.
 */
export class DshToolPresentationResolver {
  constructor({ ctx, agent, threadId, workspaceCwd = process.cwd(), diagnostics = () => {} }) {
    if (!ctx || typeof ctx.get !== 'function') throw new Error('DshToolPresentationResolver requires a Cordis Context');
    if (!agent) throw new Error('DshToolPresentationResolver requires a DSH Agent');
    this.ctx = ctx;
    this.agent = agent;
    this.threadId = String(threadId ?? agent.id);
    this.workspaceCwd = path.resolve(workspaceCwd);
    this.diagnostics = diagnostics;
    this.calls = new Map();
  }

  definition(name) {
    return this.ctx.get('tools')?.get?.(name, this.agent);
  }

  start({ turnId, callId, name, rawArguments, startedAtMs = Date.now() }) {
    const args = parseArguments(rawArguments);
    const definition = this.definition(name);
    let view;
    try { view = definition?.presentCall?.(args); }
    catch (error) { this.diagnostics(`presentCall(${name}): ${error instanceof Error ? error.message : error}`); }

    const id = `dsh-tool-${String(callId)}`;
    let item;
    let semantic = 'generic';
    if (view?.card === 'terminal') {
      semantic = 'command';
      item = {
        type: 'commandExecution',
        id,
        pluginId: null,
        scriptPath: null,
        command: view.title,
        cwd: resolveCwd(this.workspaceCwd, view.cwd),
        processId: null,
        source: 'agent',
        status: 'inProgress',
        commandActions: [],
        aggregatedOutput: null,
        exitCode: null,
        durationMs: null
      };
    } else if (canUseCodexFileChange(view)) {
      semantic = 'fileChange';
      item = fileChangeItem(id, view, 'inProgress');
    } else {
      // DSH `oldText:null` is intentionally ambiguous between create and
      // overwrite, while Codex requires add/delete/update. Stay generic rather
      // than fabricate a PatchChangeKind.
      item = dynamicItem(id, name, args, 'inProgress');
    }

    const state = {
      callId: String(callId),
      name,
      args,
      definition,
      callView: view,
      semantic,
      item,
      turnId,
      startedAtMs
    };
    this.calls.set(String(callId), state);
    return { item, state };
  }

  complete({ callId, resultData, completedAtMs = Date.now() }) {
    const state = this.calls.get(String(callId));
    if (!state) return undefined;
    const result = toolResultFromEvent(resultData);
    let view;
    try { view = state.definition?.presentResult?.(state.args, result); }
    catch (error) { this.diagnostics(`presentResult(${state.name}): ${error instanceof Error ? error.message : error}`); }
    const durationMs = Math.max(0, completedAtMs - state.startedAtMs);

    let item;
    if (state.semantic === 'command') {
      const terminal = view?.card === 'terminal' ? view : undefined;
      const failed = result.isError || Boolean(terminal?.signal) ||
        (terminal?.exitCode !== undefined && terminal.exitCode !== 0);
      item = {
        ...state.item,
        status: failed ? 'failed' : 'completed',
        aggregatedOutput: terminal?.output ?? textContentItems(result.content)?.map((entry) => entry.text).join('\n') ?? null,
        exitCode: terminal?.exitCode ?? null,
        durationMs
      };
    } else if (state.semantic === 'fileChange') {
      item = view?.card === 'diff' && canUseCodexFileChange(view)
        ? fileChangeItem(state.item.id, view, result.isError ? 'failed' : 'completed')
        : { ...state.item, status: result.isError ? 'failed' : 'completed' };
    } else {
      item = dynamicItem(
        state.item.id,
        state.name,
        state.args,
        result.isError ? 'failed' : 'completed',
        result,
        durationMs
      );
    }

    state.item = item;
    state.resultView = view;
    state.result = result;
    return { item, state };
  }

  correlation(callId) {
    const state = this.calls.get(String(callId));
    if (!state) return undefined;
    return {
      threadId: this.threadId,
      turnId: state.turnId,
      itemId: state.item.id,
      semantic: state.semantic,
      ...(state.semantic === 'command'
        ? { kind: 'command', command: state.item.command, cwd: state.item.cwd }
        : state.semantic === 'fileChange'
          ? { kind: 'fileChange' }
          : {})
    };
  }
}
