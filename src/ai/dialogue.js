// Dialogue service: turns decided intents into lines.
// Transport-agnostic so the same code can later run in a browser build:
//   transport.complete({ instructions, input, schema, signal })
//     -> { text, usage, ttftMs, totalMs, model }

import { buildLinesRequest } from './prompts.js';
import { checkLine } from './validate.js';
import { templateLine } from './templates.js';

export function createDialogue({ transport = null, timeoutMs = 10000, onMetric = () => {} } = {}) {
  async function callModel(req, label) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const t0 = Date.now();
    try {
      const res = await transport.complete({ ...req, signal: ctrl.signal });
      onMetric({ label, ok: true, ...pickMetric(res), wallMs: Date.now() - t0 });
      return JSON.parse(res.text);
    } catch (err) {
      onMetric({ label, ok: false, error: err?.code || err?.name || String(err), wallMs: Date.now() - t0 });
      if (err?.fatal) throw err; // usage limit, revoked session: surface to UI
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // specs: [{speaker, intent, target, result?, evidence[], day}]
  // ctx: { mode, nameOf, chat, style, allowNumbers } (see prompts.js / validate.js)
  async function render(scene, specs, label = 'lines', ctx = {}) {
    if (!specs.length) return [];
    const casual = ctx.mode === 'multi';
    const allowNumbers = [...(ctx.allowNumbers || []), ...(ctx.chat || []).flatMap((c) => (c.says.match(/\d+/g) || []).map(Number))];
    // ctx.useModel(spec) limits model calls to lines worth the plan usage;
    // everything else is a template, and a batch with nothing worth it costs nothing.
    const worth = specs.map((s) => !ctx.useModel || ctx.useModel(s));
    const modelSpecs = specs.filter((_, i) => worth[i]);
    let parsed = null;
    if (transport && modelSpecs.length) parsed = await callModel(buildLinesRequest(scene, modelSpecs, ctx), label);
    const got = Array.isArray(parsed?.lines) ? parsed.lines : [];
    let rejected = 0;
    const out = specs.map((spec, i) => {
      if (!worth[i]) return { speaker: spec.speaker, text: templateLine(spec, i, { nameOf: ctx.nameOf, casual }), source: 'template', reason: 'not-worth-model' };
      const line = got.find((l) => l?.speaker_id === spec.speaker);
      const why = parsed ? checkLine(spec, line, { nameOf: ctx.nameOf, allowNumbers }) : 'no-model';
      if (why) {
        if (parsed) rejected++;
        return { speaker: spec.speaker, text: templateLine(spec, i, { nameOf: ctx.nameOf, casual }), source: 'template', reason: why };
      }
      return { speaker: spec.speaker, text: line.text.trim(), source: 'ai', evidenceIds: line.evidence_ids };
    });
    if (parsed) onMetric({ label: `${label}:validation`, ok: true, rejected, total: modelSpecs.length });
    return out;
  }

  return { render, hasModel: () => !!transport };
}

function pickMetric(res) {
  return {
    model: res.model,
    inputTokens: res.usage?.input_tokens ?? null,
    outputTokens: res.usage?.output_tokens ?? null,
    reasoningTokens: res.usage?.output_tokens_details?.reasoning_tokens ?? null,
    ttftMs: res.ttftMs ?? null,
    totalMs: res.totalMs ?? null,
  };
}
