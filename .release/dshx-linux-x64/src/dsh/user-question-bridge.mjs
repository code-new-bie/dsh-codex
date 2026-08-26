function requireService(ctx, name) {
  const service = ctx.get(name);
  if (service === undefined) throw new Error(`DSHX requires DSH service: ${name}`);
  return service;
}

function codexQuestion(question) {
  const prompt = question.detail === undefined
    ? question.question
    : `${question.question}\n\n${question.detail}`;
  return {
    id: question.id,
    header: question.header ?? 'Question',
    question: prompt,
    isOther: true,
    isSecret: false,
    options: question.options === undefined
      ? null
      : question.options.map((option) => ({
          label: option.label,
          description: option.description ?? ''
        }))
  };
}

function dshAnswer(question, response) {
  const values = response?.answers?.[question.id]?.answers ?? [];
  const labels = new Set((question.options ?? []).map((option) => option.label));
  const selected = values.filter((value) => labels.has(value));
  const custom = values.filter((value) => !labels.has(value));
  return {
    id: question.id,
    selected,
    ...(custom.length === 0 ? {} : { custom: custom.join('\n') })
  };
}

/**
 * UI provider for the official DSH `ctx.userQuestions` seam.
 *
 * DSH's public AskUserQuestionRequest deliberately has no tool call id. The
 * bridge therefore asks its owner for a PRESENTATION interaction location; a
 * Codex client may attach the dialog to a synthetic UI-only item for the live
 * DSH turn instead of guessing which parallel tool call caused the question.
 * No question/answer semantics or durable state are owned here.
 */
export class DshUserQuestionBridge {
  constructor({ ctx, broker, locate, complete = () => {}, diagnostics = () => {} }) {
    if (!ctx || typeof ctx.get !== 'function') throw new Error('DshUserQuestionBridge requires a Cordis Context');
    if (!broker) throw new Error('DshUserQuestionBridge requires a UiRequestBroker');
    if (typeof locate !== 'function') throw new Error('DshUserQuestionBridge requires locate(request)');
    if (typeof complete !== 'function') throw new Error('DshUserQuestionBridge complete must be a function');
    this.ctx = ctx;
    this.broker = broker;
    this.locate = locate;
    this.complete = complete;
    this.diagnostics = diagnostics;
    this.disposeProvider = requireService(ctx, 'userQuestions').registerProvider({
      ask: (request) => this.ask(request)
    });
  }

  async ask(request) {
    if (request.questions.some((question) => question.multiSelect === true)) {
      throw new Error('DSHX pinned Codex TUI does not yet represent DSH multi-select questions faithfully');
    }
    const location = await this.locate(request);
    if (!location?.threadId || !location?.turnId || !location?.itemId) {
      throw new Error('DSHX could not open a Codex presentation item for the DSH user question');
    }

    try {
      const response = await this.broker.request(
        'item/tool/requestUserInput',
        {
          threadId: location.threadId,
          turnId: location.turnId,
          itemId: location.itemId,
          questions: request.questions.map(codexQuestion),
          isBlocking: true,
          autoResolutionMs: null
        },
        { signal: request.signal }
      );
      const answer = { answers: request.questions.map((question) => dshAnswer(question, response)) };
      await this.complete(location, { status: 'completed', answer });
      return answer;
    } catch (error) {
      this.diagnostics(error instanceof Error ? error.message : String(error));
      try { await this.complete(location, { status: 'failed', error }); } catch (completeError) {
        this.diagnostics(completeError instanceof Error ? completeError.message : String(completeError));
      }
      throw error;
    }
  }

  dispose() {
    this.disposeProvider?.();
    this.disposeProvider = undefined;
  }
}
