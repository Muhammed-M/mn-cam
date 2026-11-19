// Engagement photos — Worker (Cloudflare Workers + R2)        v2: live album
//
// Paste this whole file into the Worker editor in the Cloudflare dashboard.
// Needs:
//   • R2 bucket binding named  PHOTOS
//   • Secret named             ADMIN_KEY
//
// Guests:  PUT /upload/<folder>/<file>.jpg            → 200 stored · 409 already stored (safe retry)
//          PUT /upload/_thumbs/<folder>/<file>.jpg    → small preview of the same photo
//          Write-once: nobody can overwrite, list, read or delete through the public route.
// Album:   GET /admin/list[?since=<ms>]   (Authorization: Bearer <ADMIN_KEY>)
//          → { items: [{ k, s, u, t }], total, token }   k=key s=bytes u=uploaded(ms) t=has thumbnail
//          GET /img/<key>?t=<token>       image for <img src> (token from /admin/list, valid ~2 days)
//          GET /admin/file/<key>          (Authorization) original file — used by the download script

const ALLOWED_ORIGINS = [
  'https://muhammed-m.github.io',   // guest app + album
  'http://localhost:8765',           // local testing
  'http://localhost:8766',
];
const THUMBS = '_thumbs/';
// guest-name-ab12cd/20261127-213045_1764279045123-x7k2p9.jpg  (optionally under _thumbs/)
const KEY_RE = /^(_thumbs\/)?[a-z0-9-]{1,48}\/\d{8}-\d{6}_\d{13}-[a-z0-9]{1,8}\.jpg$/;
const MAX_BYTES = 10 * 1024 * 1024;
const DAY = 86400000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname.startsWith('/upload/')) return await upload(request, env, url, origin, cors);
      if (url.pathname.startsWith('/img/')) return await image(env, url, cors);
      if (url.pathname.startsWith('/admin/')) {
        if (!authorized(request, env)) return json({ error: 'Unauthorized' }, 401, cors);
        if (url.pathname === '/admin/list') return await list(env, url, cors);
        if (url.pathname.startsWith('/admin/file/')) return await file(env, url.pathname.slice('/admin/file/'.length), cors);
      }
      if (url.pathname === '/health') return json({ ok: true }, 200, cors);
      return json({ error: 'Not found' }, 404, cors);
    } catch (err) {
      return json({ error: 'Server error', detail: String((err && err.message) || err) }, 500, cors);
    }
  },
};

// ───────── Guests ─────────
async function upload(request, env, url, origin, cors) {
  if (request.method !== 'PUT') return json({ error: 'Use PUT' }, 405, cors);
  if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: 'Origin not allowed' }, 403, cors);

  const key = decodeURIComponent(url.pathname.slice('/upload/'.length));
  if (!KEY_RE.test(key)) return json({ error: 'Bad file name' }, 400, cors);
  if ((request.headers.get('Content-Type') || '').split(';')[0] !== 'image/jpeg') {
    return json({ error: 'JPEG only' }, 415, cors);
  }
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_BYTES) return json({ error: 'Too large' }, 413, cors);

  const body = await request.arrayBuffer();
  const bytes = new Uint8Array(body, 0, Math.min(3, body.byteLength));
  if (body.byteLength === 0 || body.byteLength > MAX_BYTES) return json({ error: 'Bad size' }, 413, cors);
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return json({ error: 'Not a JPEG' }, 415, cors);

  // Write-once: a retry of a photo we already have is a success, never an overwrite.
  if (await env.PHOTOS.head(key)) return json({ error: 'Duplicate' }, 409, cors);
  await env.PHOTOS.put(key, body, { httpMetadata: { contentType: 'image/jpeg' } });
  return json({ ok: true, key }, 200, cors);
}

// ───────── Album ─────────
function authorized(request, env) {
  return !!env.ADMIN_KEY && request.headers.get('Authorization') === `Bearer ${env.ADMIN_KEY}`;
}

async function list(env, url, cors) {
  const since = Number(url.searchParams.get('since') || 0);
  const photos = [];
  const thumbs = new Set();
  let cursor;
  do {
    const page = await env.PHOTOS.list({ cursor, limit: 1000 });
    for (const o of page.objects) {
      if (o.key.startsWith(THUMBS)) thumbs.add(o.key.slice(THUMBS.length));
      else photos.push(o);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const items = photos
    .filter((o) => o.uploaded.getTime() > since)
    .map((o) => ({ k: o.key, s: o.size, u: o.uploaded.getTime(), t: thumbs.has(o.key) }))
    .sort((a, b) => b.u - a.u);
  return json({ items, total: photos.length, token: await imageToken(env) }, 200, { ...cors, 'Cache-Control': 'no-store' });
}

async function file(env, key, cors) {
  const obj = await env.PHOTOS.get(decodeURIComponent(key));
  if (!obj) return json({ error: 'Not found' }, 404, cors);
  return new Response(obj.body, {
    headers: { ...cors, 'Content-Type': 'image/jpeg', 'Content-Length': String(obj.size), ETag: obj.httpEtag },
  });
}

// One token unlocks images for ~2 days, so plain <img src> works and the browser
// can cache. It changes once a day (stable URLs within a day = cache hits).
async function imageToken(env) {
  const exp = (Math.floor(Date.now() / DAY) + 2) * DAY;
  return `${exp}.${await hmac(env.ADMIN_KEY, `img:${exp}`)}`;
}

async function image(env, url, cors) {
  const [exp, sig] = (url.searchParams.get('t') || '').split('.');
  if (!exp || !sig || Number(exp) < Date.now() || sig !== (await hmac(env.ADMIN_KEY, `img:${exp}`))) {
    return json({ error: 'Link expired' }, 403, cors);
  }
  const key = decodeURIComponent(url.pathname.slice('/img/'.length));
  const obj = await env.PHOTOS.get(key);
  if (!obj) return json({ error: 'Not found' }, 404, cors);
  return new Response(obj.body, {
    headers: {
      ...cors,
      'Content-Type': 'image/jpeg',
      'Content-Length': String(obj.size),
      'Cache-Control': 'private, max-age=172800, immutable', // photos never change
      ETag: obj.httpEtag,
    },
  });
}

let hmacKeyCache = null;
async function hmac(secret, message) {
  if (!hmacKeyCache || hmacKeyCache.secret !== secret) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    hmacKeyCache = { secret, key };
  }
  const sig = await crypto.subtle.sign('HMAC', hmacKeyCache.key, new TextEncoder().encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ───────── Helpers ─────────
function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
