import { CONFIG } from './config.js';
import * as store from './store.js';

// Drains the local IndexedDB queue to Cloudflare R2 (via our Worker).
// - A photo is deleted locally only after the server confirms it (or says it
//   already has it), so retries never lose or duplicate photos.
// - Wakes up on: new photo, back online, page visible again, and a slow timer.
// - Network failures back off (2s → 60s); nothing is ever dropped.

const BACKOFF = [2000, 5000, 10000, 20000, 40000, 60000];

function send(path, blob, signal) {
  return fetch(`${CONFIG.uploadUrl}/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
    signal,
  });
}

const listeners = new Set();
const status = {
  pending: 0,                 // photos still on the phone
  sending: false,             // an upload is in flight
  offline: false,             // last attempt failed on the network
  sent: readSent(),           // photos this phone has delivered, ever
};

let running = false;
let failures = 0;
let retryTimer = null;

export function onStatus(fn) { listeners.add(fn); fn({ ...status }); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn({ ...status }); }

export async function refresh() {
  try { status.pending = await store.countPhotos(); } catch { /* ignore */ }
  emit();
}

function kick() {
  clearTimeout(retryTimer);
  retryTimer = null;
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  try {
    let ids = await store.listIds();
    status.pending = ids.length;
    emit();
    ids.sort(); // ids start with the capture time → oldest first

    while (ids.length) {
      const batch = ids.splice(0, CONFIG.upload.concurrency);
      status.sending = true;
      emit();
      const results = await Promise.all(batch.map(uploadOne));
      const okCount = results.filter((r) => r === 'ok').length;
      if (okCount) {
        status.sent += okCount;
        writeSent(status.sent);
        failures = 0;
        status.offline = false;
      }
      status.pending = Math.max(0, status.pending - okCount);
      emit();
      if (results.includes('network')) { scheduleRetry(true); return; }
      if (results.includes('rejected')) { scheduleRetry(false); return; }
      // Pick up photos taken while we were uploading.
      if (!ids.length) {
        ids = (await store.listIds()).sort();
        status.pending = ids.length;
      }
    }
    failures = 0;
    status.offline = false;
  } catch (err) {
    console.error('upload loop', err);
    scheduleRetry(true);
  } finally {
    status.sending = false;
    running = false;
    emit();
  }
}

function scheduleRetry(isNetwork) {
  status.offline = isNetwork;
  const delay = BACKOFF[Math.min(failures, BACKOFF.length - 1)];
  failures += 1;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { retryTimer = null; pump(); }, delay);
}

// Full photo first (so it reaches the album as early as possible), then its small
// preview for the album grid. The record leaves the phone only when both are stored.
// → 'ok' | 'network' (try again soon) | 'rejected' (server refused; keep it, retry slowly)
async function uploadOne(id) {
  const rec = await store.getPhoto(id);
  if (!rec) return 'ok';
  const path = objectPath(rec);
  try {
    if (!rec.mainDone) {
      const r = await put(path, rec.blob);
      if (r !== 'ok') return r;
      if (rec.thumb) { rec.mainDone = true; await store.savePhoto(rec); } // don't resend the big one
    }
    if (rec.thumb) {
      const r = await put(`_thumbs/${path}`, rec.thumb);
      if (r === 'network') return 'network'; // photo is safe; preview retried later
      // 'rejected' preview: skip it — the album falls back to the full photo
    }
    await store.deletePhoto(id);
    return 'ok';
  } catch {
    return 'network';
  }
}

async function put(path, blob) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.upload.timeoutMs);
  try {
    const res = await send(path, blob, ctrl.signal);
    if (res.ok || isDuplicate(res)) return 'ok';
    console.warn('upload refused', res.status, path);
    return res.status >= 500 || res.status === 429 ? 'network' : 'rejected';
  } catch {
    return 'network'; // offline, timeout, DNS, captive Wi-Fi…
  } finally {
    clearTimeout(timer);
  }
}

// The Worker answers 409 when it already has this photo — a retry that already succeeded.
const isDuplicate = (res) => res.status === 409;

// guest-name-ab12cd/20261127-213045_1764279045123-x7k2p9.jpg
function objectPath(rec) {
  const name = slug(rec.guest) || 'guest';
  const folder = `${name}-${String(rec.deviceId || 'device').replace(/-/g, '').slice(0, 6)}`;
  const d = new Date(rec.createdAt);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${folder}/${stamp}_${rec.id}.jpg`;
}

// Storage keys must be Latin, so Arabic names are spelled out (e.g. أحمد → ahmd, سارة → sara).
const AR = {
  'ا': 'a', 'أ': 'a', 'إ': 'e', 'آ': 'a', 'ب': 'b', 'ت': 't', 'ث': 'th', 'ج': 'g', 'ح': 'h', 'خ': 'kh',
  'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'd', 'ط': 't', 'ظ': 'z',
  'ع': 'a', 'غ': 'gh', 'ف': 'f', 'ق': 'k', 'ك': 'k', 'ل': 'l', 'م': 'm', 'ن': 'n', 'ه': 'h', 'ة': 'a',
  'ى': 'a', 'ء': '', 'ئ': 'e', 'ؤ': 'o', 'گ': 'g', 'پ': 'p', 'چ': 'ch', 'ڤ': 'v',
};
function arabicToLatin(input) {
  const chars = [...String(input || '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')                       // harakat, tatweel
    .replace(/[\u0660-\u0669]/g, (d) => d.charCodeAt(0) - 0x0660)      // ٠-٩
    .replace(/[\u06F0-\u06F9]/g, (d) => d.charCodeAt(0) - 0x06F0)];    // ۰-۹
  return chars.map((ch, i) => {
    const wordStart = i === 0 || /\s/.test(chars[i - 1]);
    if (ch === 'و') return wordStart ? 'w' : 'ou';
    if (ch === 'ي') return wordStart ? 'y' : 'i';
    return AR[ch] ?? ch;
  }).join('');
}

function slug(s) {
  return arabicToLatin(s)
    .normalize('NFKD').replace(/[\u0300-\u036F]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
}

function readSent() { try { return parseInt(localStorage.getItem('nm.sent') || '0', 10) || 0; } catch { return 0; } }
function writeSent(n) { try { localStorage.setItem('nm.sent', String(n)); } catch { /* ignore */ } }

// ───────── Triggers ─────────
window.addEventListener('online', kick);
document.addEventListener('photo-saved', () => { status.pending += 1; emit(); kick(); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
setInterval(() => { if (status.pending > 0 && !running && !retryTimer) pump(); }, 30000);
kick();
