// Only this adapter knows the pinned pi session API. One model response per call;
// the orchestrator, not the SDK, owns retries, tools, accounting and completion.
import {
  createAgentSession,
  createExtensionRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { PROTOCOL, GenerationError, providerFailure } from './protocol.mjs';
import { configuredReasoning } from './models.mjs';
export function emptyLedger() {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    retries: 0,
    reportedReasoningTokens: 0,
    thinkingBytes: 0,
    answerBytes: 0,
  };
}
export class ModelCaller {
  constructor({
    runtime,
    model,
    dir,
    ledger,
    deadlineAt,
    onSave = async () => {},
    onOperation = () => {},
    emit = () => {},
    trace = () => {},
    streamOverride,
    limits = PROTOCOL.limits,
    signal,
    reasoningEffort,
  }) {
    Object.assign(this, {
      runtime,
      model,
      dir,
      ledger,
      deadlineAt,
      onSave,
      onOperation,
      emit,
      trace,
      streamOverride,
      limits,
      signal,
      reasoningEffort,
    });
  }
  async call({
    system,
    prompt,
    tools,
    role = 'author',
    phase = 'build',
    images = [],
    targetTokens = this.limits.buildTokens,
  }) {
    const l = this.ledger,
      m = this.model,
      caps = this.limits;
    const reasoningEffort = configuredReasoning(m, role, process.env, this.reasoningEffort);
    // Additive metrics for checkpoints written before reasoning observability.
    for (const key of ['reportedReasoningTokens', 'thinkingBytes', 'answerBytes']) l[key] ??= 0;
    if (this.signal?.aborted) throw new GenerationError('worker_error');
    const remainingMs = this.deadlineAt - Date.now() - PROTOCOL.deliveryReserveMs;
    if (remainingMs < 1000) throw new GenerationError('timeout');
    if (l.requests >= caps.requests) throw new GenerationError('request_limit');
    const inputEstimate =
      Math.ceil(
        Buffer.byteLength(system + prompt + JSON.stringify(tools.map((t) => t.parameters))) / 2,
      ) +
      images.length * 4096 +
      512;
    const maxTokens = Math.floor(
      Math.min(
        targetTokens,
        m.maxTokens,
        m.contextWindow - inputEstimate - 512,
        caps.outputTokens - l.outputTokens,
      ),
    );
    if (maxTokens < 256 || inputEstimate + l.inputTokens > caps.inputTokens)
      throw new GenerationError('budget_exhausted');
    const cost = Math.ceil(inputEstimate * m.cost.input + maxTokens * m.cost.output);
    if (l.costMicros + cost > caps.costMicros) throw new GenerationError('budget_exhausted');
    // Persist worst-case reservation BEFORE calling. A crash cannot refund unknown usage.
    l.requests++;
    l.inputTokens += inputEstimate;
    l.outputTokens += maxTokens;
    l.costMicros += cost;
    l.inflight = { role, phase, request: l.requests, maxTokens, reasoningEffort };
    await this.onSave();
    const details = () => ({
      ...l,
      role,
      phase,
      maxTokens,
      reasoningEffort,
      remainingMs: Math.max(0, this.deadlineAt - Date.now()),
    });
    this.emit('model_request', details());
    const loader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => system,
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    let session,
      timer,
      firstTimer,
      idleTimer,
      last,
      bytes = 0,
      received = false,
      block = false,
      requested = false,
      deadlineReject;
    const timeout = new Promise((_, reject) => {
      deadlineReject = reject;
    });
    const stop = (code) => {
      deadlineReject(new GenerationError(code));
      session?.dispose();
    };
    const abort = () => stop('worker_error');
    try {
      // Deliberately do not execute model tools inside the SDK. Typed schemas are
      // exposed, then the host validates the completed single call atomically.
      const capture = tools.map((t) => ({
        ...t,
        execute: async () => ({
          content: [{ type: 'text', text: 'Host will apply this operation.' }],
          details: {},
          terminate: true,
        }),
      }));
      ({ session } = await createAgentSession({
        cwd: this.dir,
        agentDir: this.dir,
        modelRuntime: this.runtime,
        model: m,
        thinkingLevel: reasoningEffort,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(this.dir),
        settingsManager: SettingsManager.inMemory({
          defaultTools: [],
          compaction: { enabled: false },
          retry: { enabled: false, provider: { maxRetries: 0 } },
          cacheWarming: 'off',
          enableInstallTelemetry: false,
          enableAnalytics: false,
        }),
        tools: capture.map((t) => t.name),
        customTools: capture,
      }));
      if (
        session.getActiveToolNames().sort().join() !==
        capture
          .map((t) => t.name)
          .sort()
          .join()
      )
        throw new GenerationError('configuration_error');
      // Version-specific isolation seam, covered with the real locked SDK.
      session.agent.beforeToolCall = async () => ({
        block: true,
        reason: 'Host-owned atomic operation',
        terminate: true,
      });
      session.agent.finishTurn = async () => ({ action: 'end' });
      const stream = this.streamOverride || session.agent.streamFunction;
      session.agent.streamFunction = async (model, context, options) => {
        if (requested) throw new GenerationError('tool_protocol');
        requested = true;
        this.trace('model_request', {
          role,
          phase,
          model: { provider: m.provider, id: m.id },
          maxTokens,
          context,
        });
        return stream(model, context, {
          ...options,
          maxTokens,
          timeoutMs: Math.min(caps.callMs, remainingMs),
          maxRetries: 0,
        });
      };
      let lastProgress = 0;
      session.subscribe((event) => {
        if (event.type === 'message_update') {
          const delta = event.assistantMessageEvent?.delta;
          // Count traffic, never publish or persist thinking/reasoning text.
          const size = typeof delta === 'string' ? Buffer.byteLength(delta) : 0;
          bytes += size;
          const type = event.assistantMessageEvent?.type;
          if (type === 'thinking_delta') l.thinkingBytes += size;
          else if (type === 'text_delta' || type === 'toolcall_delta') l.answerBytes += size;
          if (!received) {
            received = true;
            clearTimeout(firstTimer);
            this.emit('model_first_response', details());
          }
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => stop('provider_idle_timeout'), caps.idleMs);
          if (Date.now() - lastProgress > 5000) {
            lastProgress = Date.now();
            this.emit('model_streaming', { ...details(), streamBytes: bytes });
          }
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          last = event.message;
          block = ['length', 'error', 'aborted', 'deferred'].includes(last.stopReason);
          this.trace('message', { role, phase, message: last });
        }
      });
      timer = setTimeout(() => stop('provider_timeout'), Math.min(caps.callMs, remainingMs));
      firstTimer = setTimeout(
        () => stop('provider_first_timeout'),
        Math.min(caps.firstMs, remainingMs),
      );
      this.signal?.addEventListener('abort', abort, { once: true });
      if (this.signal?.aborted) abort();
      await Promise.race([session.prompt(prompt, images.length ? { images } : undefined), timeout]);
      if (!last) throw new GenerationError('provider_error');
      // Only reconcile a completed authoritative message. Otherwise retain reservation.
      if (
        ['stop', 'toolUse', 'length'].includes(last.stopReason) &&
        last.usage &&
        ['input', 'output'].every(
          (key) => Number.isSafeInteger(last.usage[key]) && last.usage[key] >= 0,
        ) &&
        ['cacheRead', 'cacheWrite'].every(
          (key) => Number.isSafeInteger(last.usage[key] ?? 0) && (last.usage[key] ?? 0) >= 0,
        )
      ) {
        l.inputTokens +=
          last.usage.input +
          (last.usage.cacheRead || 0) +
          (last.usage.cacheWrite || 0) -
          inputEstimate;
        l.outputTokens += last.usage.output - maxTokens;
        // Reasoning is already INCLUDED in output; never add it to spending twice.
        // Providers may omit this breakdown: the reported count is a lower bound,
        // not evidence that an unreported zero means reasoning was disabled.
        if (
          Number.isSafeInteger(last.usage.reasoning) &&
          last.usage.reasoning >= 0 &&
          last.usage.reasoning <= last.usage.output
        )
          l.reportedReasoningTokens += last.usage.reasoning;
        const actual = last.usage.cost?.total;
        l.costMicros +=
          Number.isFinite(actual) && actual > 0
            ? Math.ceil(actual * 1e6) - cost
            : Math.ceil(
                (last.usage.input || 0) * m.cost.input +
                  (last.usage.output || 0) * m.cost.output +
                  (last.usage.cacheRead || 0) * m.cost.cacheRead +
                  (last.usage.cacheWrite || 0) * m.cost.cacheWrite,
              ) - cost;
      }
      const calls = last.content.filter((c) => c.type === 'toolCall');
      const validCall = !block && calls.length === 1 && tools.some((t) => t.name === calls[0].name);
      if (validCall) this.onOperation(calls[0], { role, phase });
      delete l.inflight;
      await this.onSave();
      this.emit('model_finished', { ...details(), stopReason: last.stopReason });
      if (
        l.inputTokens > caps.inputTokens ||
        l.outputTokens > caps.outputTokens ||
        l.costMicros > caps.costMicros
      )
        throw new GenerationError('budget_exhausted');
      if (block) {
        if (last.stopReason === 'length') throw new GenerationError('output_truncated');
        const error = new GenerationError(providerFailure(last.errorMessage || ''));
        error.retryable =
          (error.code === 'provider_unavailable' || !received) &&
          !/quota|credit|billing/i.test(last.errorMessage || '');
        throw error;
      }
      if (!validCall) throw new GenerationError('tool_protocol');
      return calls[0];
    } finally {
      clearTimeout(timer);
      clearTimeout(firstTimer);
      clearTimeout(idleTimer);
      this.signal?.removeEventListener('abort', abort);
      session?.dispose();
    }
  }
}
