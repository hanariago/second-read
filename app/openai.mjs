// Responses API over ChatGPT plan usage: store:false, stream:true, full input
// every call. Only fields documented as supported are sent.

const API = 'https://api.openai.com/v1';

export class ApiError extends Error {
  constructor(code, { status, param, requestId, fatal = false, message } = {}) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.param = param;
    this.requestId = requestId;
    this.fatal = fatal;
  }
}

// Codes after which the game must stop calling the model and tell the player.
const FATAL = {
  subscription_sharing_usage_limit_exceeded: 'usage_limit',
  subscription_sharing_user_not_eligible: 'not_eligible',
  subscription_sharing_invalid_user: 'reauth',
  chatpass_v2_scope_not_authorized: 'not_authorized',
  chatpass_v2_invalid_authorization_context: 'not_authorized',
};

export async function listModels(token) {
  const res = await fetch(`${API}/models`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await toError(res);
  const body = await res.json();
  const list = body.models ?? body.data ?? [];
  return list
    .filter((m) => (m.visibility ?? 'list') === 'list')
    .map((m) => ({ slug: m.slug ?? m.id, display_name: m.display_name ?? m.slug ?? m.id }));
}

// A fast, small model keeps a game short; the player can override in settings.
export function defaultModel(models) {
  const lower = (m) => `${m.slug} ${m.display_name}`.toLowerCase();
  return (
    models.find((m) => /mini/.test(lower(m)) && !/nano/.test(lower(m))) ??
    models.find((m) => /(fast|instant|nano)/.test(lower(m))) ??
    models[0] ??
    null
  );
}

async function toError(res) {
  const requestId = res.headers.get('x-request-id');
  let body = {};
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  const e = body.error;
  if (e?.code) {
    const fatal = FATAL[e.code];
    return new ApiError(fatal || e.code, { status: res.status, param: e.param, requestId, fatal: !!fatal, message: e.message });
  }
  // Direct-route admission failures use {detail}; treat as diagnostic text.
  const code = e?.type || (res.status === 401 ? 'unauthorized' : res.status === 403 ? 'forbidden' : res.status === 503 ? 'unavailable' : `http_${res.status}`);
  return new ApiError(code, { status: res.status, param: e?.param ?? null, requestId, message: body.detail || e?.message });
}

// Streams one response. Returns { text, usage, ttftMs, totalMs, model }.
export async function streamResponse({ token, model, instructions, input, schema, extra = {}, signal }) {
  const body = { model, instructions, input, store: false, stream: true, ...extra };
  if (schema) body.text = { format: schema };
  const t0 = performance.now();
  const res = await fetch(`${API}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await toError(res);

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  let ttftMs = null;
  let done = null;
  const handle = (data) => {
    if (!data || data === '[DONE]') return;
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (ev.type === 'response.output_text.delta') {
      if (ttftMs === null) ttftMs = performance.now() - t0;
      text += ev.delta;
    } else if (ev.type === 'response.completed') {
      done = { usage: ev.response?.usage ?? null, model: ev.response?.model ?? model };
    } else if (ev.type === 'response.failed') {
      const code = ev.response?.error?.code || 'response_failed';
      const fatal = FATAL[code];
      throw new ApiError(fatal || code, { fatal: !!fatal, message: ev.response?.error?.message });
    } else if (ev.type === 'response.incomplete') {
      throw new ApiError('incomplete', { message: ev.response?.incomplete_details?.reason });
    } else if (ev.type === 'error') {
      const code = ev.error?.code || ev.code || 'stream_error';
      const fatal = FATAL[code];
      throw new ApiError(fatal || code, { fatal: !!fatal, param: ev.error?.param ?? ev.param, message: ev.error?.message ?? ev.message });
    }
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      handle(data);
    }
  }
  if (!done) throw new ApiError('stream_interrupted');
  return { text, usage: done.usage, model: done.model, ttftMs: Math.round(ttftMs ?? 0), totalMs: Math.round(performance.now() - t0) };
}
