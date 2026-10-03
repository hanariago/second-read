// Sign in with ChatGPT for an open-source local app (dynamic agent registration,
// Authorization Code + PKCE, loopback callback on 127.0.0.1).
// Tokens never leave the main process.

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRemoteJWKSet, jwtVerify, decodeJwt } from 'jose';
import { readJson, writeJsonAtomic, removeFile } from './files.mjs';

const DISCOVERY = 'https://auth.openai.com/.well-known/openid-configuration';
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const PREFERRED_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const UNUSABLE_REFRESH = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
]);

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const rand = () => b64url(crypto.randomBytes(32));

export class AuthError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

export function createAuth({ dir, appName, openExternal, log = () => {} }) {
  const hostFile = path.join(dir, 'host.json');
  const accountsFile = path.join(dir, 'accounts.json');
  const credFile = (clientId) => path.join(dir, `cred-${clientId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  let discovery = null;
  let jwks = null;
  let pending = null; // in-flight sign-in
  let refreshing = null; // serialized refresh promise

  async function getDiscovery() {
    if (discovery) return discovery;
    const res = await fetch(DISCOVERY);
    if (!res.ok) throw new AuthError('discovery_failed', `discovery ${res.status}`);
    discovery = await res.json();
    jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    return discovery;
  }

  // Stable per-installation host id, created before the first sign-in.
  async function hostId() {
    const h = await readJson(hostFile);
    if (h?.ext_agent_host_id) return h.ext_agent_host_id;
    const id = `urn:uuid:${crypto.randomUUID()}`;
    await writeJsonAtomic(hostFile, { ext_agent_host_id: id });
    return id;
  }

  async function accounts() {
    return (await readJson(accountsFile)) || { active: null, registrations: [], planWelcomeShown: [] };
  }

  async function activeCred() {
    const a = await accounts();
    if (!a.active) return null;
    return readJson(credFile(a.active));
  }

  function listen() {
    return new Promise((resolve, reject) => {
      let resolveCb;
      const result = new Promise((r) => (resolveCb = r));
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== CALLBACK_PATH) {
          res.writeHead(404).end();
          return;
        }
        const ok = !url.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<!doctype html><meta charset="utf-8"><title>Second Read</title><body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${ok ? '로그인 완료' : '로그인이 취소되었습니다'}</h2><p>이 창을 닫고 Second Read로 돌아가세요.</p></div>`,
        );
        resolveCb(url.searchParams);
      });
      const tryPort = (port) => {
        server.once('error', (err) => {
          if (port !== 0 && err.code === 'EADDRINUSE') tryPort(0);
          else reject(err);
        });
        server.listen(port, '127.0.0.1', () => {
          const { port: actual } = server.address();
          resolve({ server, redirectUri: `http://127.0.0.1:${actual}${CALLBACK_PATH}`, result });
        });
      };
      tryPort(PREFERRED_PORT);
    });
  }

  async function tokenRequest(params) {
    const d = await getDiscovery();
    const res = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new AuthError(body.error || `http_${res.status}`, body.error_description);
    return body;
  }

  // mode: 'continue' reuses the active registration; 'new' registers another account.
  async function signIn({ mode = 'continue', reconsent = false } = {}) {
    if (pending) pending.cancel();
    const d = await getDiscovery();
    const host = await hostId();
    const a = await accounts();
    const reg = mode === 'continue' && a.active ? a.registrations.find((r) => r.client_id === a.active) : null;
    const oldCred = reg ? await readJson(credFile(reg.client_id)) : null;

    const state = rand();
    const nonce = rand();
    const verifier = rand();
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const { server, redirectUri, result } = await listen();

    const q = new URLSearchParams({
      client_id: reg ? reg.client_id : 'dynamic_agent_client',
      ext_agent_host_id: host,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES,
      resource: RESOURCE,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    if (!reg) q.set('agent_name_hint', appName);
    if (reg && oldCred?.id_token) q.set('id_token_hint', oldCred.id_token);
    // Re-asking for plan permission after an earlier decline (OAuth param, not the Responses field).
    if (reg && reconsent) q.set('prompt', 'consent');
    const authUrl = `${d.authorization_endpoint}?${q}`;
    log('sign-in started', { redirectUri, registration: reg ? 'returning' : 'new' }); // URL omitted: may hold id_token_hint

    let timer;
    const cancelled = new Promise((_, reject) => {
      pending = { cancel: () => reject(new AuthError('cancelled')) };
      timer = setTimeout(() => reject(new AuthError('timeout')), SIGN_IN_TIMEOUT_MS);
    });
    try {
      await openExternal(authUrl);
      const params = await Promise.race([result, cancelled]);
      if (params.get('state') !== state) throw new AuthError('state_mismatch');
      const err = params.get('error');
      if (err) throw new AuthError(err === 'access_denied' ? 'access_denied' : err, params.get('error_description'));
      const code = params.get('code');
      const cbClient = params.get('client_id');
      let clientId;
      if (reg) {
        if (cbClient && cbClient !== reg.client_id) throw new AuthError('client_mismatch');
        clientId = reg.client_id;
      } else {
        if (!cbClient || cbClient === 'dynamic_agent_client') throw new AuthError('registration_incomplete');
        clientId = cbClient;
      }
      const tok = await tokenRequest({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource: RESOURCE,
      });
      const { payload } = await jwtVerify(tok.id_token, jwks, {
        issuer: d.issuer,
        audience: clientId,
        requiredClaims: ['sub', 'exp', 'iat'],
        clockTolerance: 5,
      });
      if (payload.nonce !== nonce) throw new AuthError('nonce_mismatch');
      if (reg && reg.subject !== payload.sub) throw new AuthError('account_mismatch');
      const scopes = String(tok.scope || '').split(/\s+/).filter(Boolean).sort();
      await writeJsonAtomic(
        credFile(clientId),
        {
          issuer: d.issuer,
          subject: payload.sub,
          client_id: clientId,
          ext_agent_host_id: host,
          id_token: tok.id_token,
          access_token: tok.access_token,
          refresh_token: tok.refresh_token,
          token_type: tok.token_type,
          expires_in: tok.expires_in,
          scopes,
          saved_at: new Date().toISOString(),
        },
        { secret: true },
      );
      const next = await accounts();
      if (!next.registrations.some((r) => r.client_id === clientId)) {
        next.registrations.push({
          client_id: clientId,
          subject: payload.sub,
          issuer: d.issuer,
          label: `ChatGPT 계정 ${next.registrations.length + 1}`,
        });
      }
      next.active = clientId;
      await writeJsonAtomic(accountsFile, next);
      return status();
    } finally {
      clearTimeout(timer);
      pending = null;
      server.close();
    }
  }

  function cancelSignIn() {
    if (pending) pending.cancel();
  }

  async function refresh(cred) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const tok = await tokenRequest({
          grant_type: 'refresh_token',
          client_id: cred.client_id,
          refresh_token: cred.refresh_token,
          resource: RESOURCE,
        });
        const next = {
          ...cred,
          access_token: tok.access_token,
          refresh_token: tok.refresh_token || cred.refresh_token,
          expires_in: tok.expires_in,
          scopes: tok.scope ? String(tok.scope).split(/\s+/).filter(Boolean).sort() : cred.scopes,
          id_token: tok.id_token || cred.id_token,
          saved_at: new Date().toISOString(),
        };
        await writeJsonAtomic(credFile(cred.client_id), next, { secret: true });
        return next;
      } catch (err) {
        if (UNUSABLE_REFRESH.has(err.code)) {
          await clearTokens(cred);
          throw new AuthError('reauth_required', err.code);
        }
        throw err;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  async function clearTokens(cred) {
    const keep = { issuer: cred.issuer, subject: cred.subject, client_id: cred.client_id, ext_agent_host_id: cred.ext_agent_host_id };
    await writeJsonAtomic(credFile(cred.client_id), keep, { secret: true });
  }

  // Returns a usable access token, refreshing shortly before expiry.
  async function accessToken({ force = false } = {}) {
    let cred = await activeCred();
    if (!cred?.access_token) throw new AuthError('signed_out');
    if (!cred.scopes?.includes(PLAN_SCOPE)) throw new AuthError('plan_not_enabled');
    const expiresAt = Date.parse(cred.saved_at) + (cred.expires_in || 3600) * 1000;
    if (force || Date.now() > expiresAt - 5 * 60 * 1000) cred = await refresh(cred);
    return cred.access_token;
  }

  async function signOut() {
    const cred = await activeCred();
    let revoked = true;
    if (cred?.refresh_token) {
      revoked = false;
      const d = await getDiscovery().catch(() => null);
      for (let i = 0; i < 3 && d?.revocation_endpoint && !revoked; i++) {
        try {
          const res = await fetch(d.revocation_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: cred.refresh_token, token_type_hint: 'refresh_token', client_id: cred.client_id }),
          });
          if (res.ok) revoked = true;
          else if (res.status < 500) break;
        } catch {
          /* network: retry */
        }
        if (!revoked) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
    if (cred) await clearTokens(cred);
    return { ...(await status()), revocationConfirmed: revoked };
  }

  async function status() {
    const a = await accounts();
    const cred = await activeCred();
    const signedIn = !!cred?.access_token;
    let email = null;
    try {
      email = cred?.id_token ? decodeJwt(cred.id_token).email ?? null : null;
    } catch {
      /* display only */
    }
    const reg = a.registrations.find((r) => r.client_id === a.active);
    return {
      signedIn,
      planEnabled: signedIn && !!cred.scopes?.includes(PLAN_SCOPE),
      hasRegistration: !!reg,
      account: reg ? { label: reg.label, email } : null,
      showPlanWelcome: signedIn && !a.planWelcomeShown?.includes(a.active),
    };
  }

  async function markPlanWelcomeShown() {
    const a = await accounts();
    a.planWelcomeShown = [...new Set([...(a.planWelcomeShown || []), a.active])];
    await writeJsonAtomic(accountsFile, a);
  }

  return { signIn, cancelSignIn, signOut, status, accessToken, markPlanWelcomeShown };
}
