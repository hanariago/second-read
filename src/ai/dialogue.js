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
  async function render(scene, specs, label = 'lines') {
    if (!specs.length) return [];
    let parsed = null;
    if (transport) parsed = await callModel(buildLinesRequest(scene, specs), label);
    const got = Array.isArray(parsed?.lines) ? parsed.lines : [];
    let rejected = 0;
    const out = specs.map((spec, i) => {
      const line = got.find((l) => l?.speaker_id === spec.speaker) ?? got[i];
      const why = parsed ? checkLine(spec, line) : 'no-model';
      if (why) {
        if (parsed) rejected++;
        return { speaker: spec.speaker, text: templateLine(spec, i), source: 'template', reason: why };
      }
      return { speaker: spec.speaker, text: line.text.trim(), source: 'ai', evidenceIds: line.evidence_ids };
    });
    if (parsed) onMetric({ label: `${label}:validation`, ok: true, rejected, total: specs.length });
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
