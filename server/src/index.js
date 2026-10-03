// Relay for multiplayer rooms. Players connect with a room code; each room is
// one Durable Object that runs the shared game engine. No ChatGPT tokens or
// player data are stored here: tell records arrive per game and live in memory.

export { Room } from './room.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode() {
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  for (const b of bytes) s += CODE_CHARS[b % CODE_CHARS.length];
  return s;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok');
    if (url.pathname === '/room' && request.method === 'POST') {
      return Response.json({ code: newCode() });
    }
    const m = url.pathname.match(/^\/room\/([A-Z0-9]{5})\/ws$/);
    if (m) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
      return stub.fetch(request);
    }
    return new Response('not found', { status: 404 });
  },
};
