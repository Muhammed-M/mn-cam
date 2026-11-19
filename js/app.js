import { CONFIG } from './config.js';
import { COUPLE } from './couple.js';
import { Camera, fileToCanvas, canvasToJpeg, makeThumb, releaseCanvas } from './camera.js';
import * as store from './store.js';
import * as uploader from './uploader.js';
import { isRotated, enableMotionSensor, photoRotation } from './orientation.js';

const $ = (id) => document.getElementById(id);
const el = {
  welcome: $('welcome'), camera: $('camera'),
  form: $('start-form'), name: $('guest-name'), startLabel: $('btn-start-label'),
  video: $('video'), blink: $('blink'),
  msg: $('cam-message'), msgTitle: $('cam-msg-title'), msgBody: $('cam-msg-body'), spinner: $('cam-spinner'),
  retry: $('btn-retry'), nativeFallback: $('btn-native-fallback'),
  back: $('btn-back'), flash: $('btn-flash'), switchBtn: $('btn-switch'),
  shutter: $('shutter'), count: $('shot-count'), thumb: $('thumb'), thumbCanvas: $('thumb-canvas'),
  nativeInput: $('native-input'), screenFlash: $('screen-flash'), toast: $('toast'),
  preview: $('preview'), previewImg: $('preview-img'),
};

// ───────── Small persisted state (localStorage can throw in private mode) ─────────
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};
const randomId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

const state = {
  screen: 'welcome',
  shots: parseInt(ls.get('nm.shots', '0'), 10) || 0,
  guest: ls.get('nm.guest', ''),
  deviceId: ls.get('nm.device', '') || (() => { const id = randomId(); ls.set('nm.device', id); return id; })(),
  flash: false,
  starting: null,       // in-flight camera start (single-flight)
  nativeOpen: false,    // phone's own camera is open
  wakeLock: null,
  paused: false,        // battery saver paused the camera
  lastPhoto: null,      // Promise<Blob> of the latest shot this session
  wrapped: false,       // "That's a wrap" is on
  updateReady: false,   // a new version is waiting; applied on the welcome screen
};

const cam = new Camera(el.video);
if (ls.get('nm.facing', '') === 'user') cam.facing = 'user'; // returning guests keep their lens

// ───────── Welcome ─────────
document.querySelectorAll('[data-couple]').forEach((n) => { n.textContent = COUPLE[n.dataset.couple]; });
document.title = `${COUPLE.groom} & ${COUPLE.bride} · Engagement`;
document.documentElement.classList.add('couple-ready');
el.name.value = state.guest;
if (state.shots > 0) el.startLabel.textContent = 'Continue shooting';
renderCount(false);
restoreThumb();

el.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  state.guest = el.name.value.trim().slice(0, 40);
  ls.set('nm.guest', state.guest);
  el.name.blur();
  // Motion sensor first (iPhone asks once, inside this tap), so sideways shots save upright.
  await enableMotionSensor();
  openCamera();
});

function openCamera() {
  if (state.wrapped) return;
  state.screen = 'camera';
  el.welcome.hidden = true;
  el.camera.hidden = false;
  store.requestPersistence();
  acquireWakeLock();
  startCamera();
}

el.back.addEventListener('click', goWelcome);
function goWelcome() {
  state.screen = 'welcome';
  state.paused = false;
  clearTimeout(idleTimer);
  closePreview();
  cam.stop();
  releaseWakeLock();
  el.camera.hidden = true;
  el.welcome.hidden = false;
  if (state.shots > 0) el.startLabel.textContent = 'Continue shooting';
  if (state.updateReady) location.reload(); // pick up the new version between shoots
}

// ───────── Camera lifecycle ─────────
function startCamera(facing = cam.facing) {
  if (state.starting) return state.starting;
  if (!Camera.supported) { showUnsupported(); return Promise.resolve(); }
  showMessage({ spinner: true });
  el.shutter.disabled = true;
  state.paused = false;
  state.starting = cam.start(facing)
    .then(async () => {
      hideMessage();
      bumpIdle();
      ls.set('nm.facing', cam.facing);
      el.switchBtn.hidden = !(await cam.hasMultipleCameras());
      await syncFlash();
    })
    .catch(showCameraError)
    .finally(() => { state.starting = null; el.shutter.disabled = false; });
  return state.starting;
}

function resumeCamera() {
  if (state.screen !== 'camera' || document.hidden || state.nativeOpen || state.paused) return;
  if (!cam.live) startCamera();
}

// ───────── Battery saver: pause the camera after 2 idle minutes ─────────
let idleTimer;
function bumpIdle() {
  clearTimeout(idleTimer);
  if (state.screen === 'camera') idleTimer = setTimeout(pauseForBattery, CONFIG.idlePauseMs);
}
function pauseForBattery() {
  if (state.screen !== 'camera' || !cam.live || !el.preview.hidden) { bumpIdle(); return; }
  state.paused = true;
  cam.stop();
  releaseWakeLock(); // let the phone sleep normally
  showMessage({ title: 'Camera paused', body: 'To save your battery.', retry: true, retryLabel: 'Continue shooting' });
}
function wake() {
  state.paused = false;
  acquireWakeLock();
  startCamera();
}
document.addEventListener('pointerdown', bumpIdle, { capture: true, passive: true });

document.addEventListener('visibilitychange', () => {
  if (state.screen !== 'camera') return;
  if (document.hidden) {
    if (!state.nativeOpen) cam.stop(); // release camera + battery when phone is locked/switched
  } else {
    acquireWakeLock();
    resumeCamera();
  }
});
window.addEventListener('focus', resumeCamera);
window.addEventListener('pageshow', resumeCamera);

function showMessage({ title = '', body = '', spinner = false, retry = false, retryLabel = 'Try again', native = false }) {
  el.msgTitle.textContent = title;
  el.msgBody.textContent = body;
  el.spinner.hidden = !spinner;
  el.retry.hidden = !retry;
  el.retry.textContent = retryLabel;
  el.nativeFallback.hidden = !native;
  el.msg.hidden = false;
}
function hideMessage() { el.msg.hidden = true; }

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|Snapchat|TikTok|; wv\)/i.test(navigator.userAgent);

function showUnsupported() {
  showMessage({
    title: 'Live camera isn’t available here',
    body: inAppBrowser
      ? `Open this page in ${isIOS ? 'Safari' : 'Chrome'} for the full camera — or use your phone camera below.`
      : 'You can still take photos with your phone camera.',
    native: true,
  });
  el.shutter.disabled = true;
}

function showCameraError(err) {
  const name = err && err.name;
  el.flash.hidden = true;
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    showMessage({
      title: 'Camera access is off',
      body: isIOS
        ? 'Tap “aA” in the address bar → Website Settings → Camera → Allow, then try again.'
        : 'Tap the icon left of the address → Permissions → Camera → Allow, then try again.',
      retry: true, native: true,
    });
  } else if (name === 'NotReadableError' || name === 'AbortError') {
    showMessage({ title: 'Camera is busy', body: 'Close other apps using the camera, then try again.', retry: true, native: true });
  } else {
    showMessage({ title: 'Couldn’t start the camera', body: 'You can still take photos with your phone camera.', retry: true, native: true });
  }
}

el.retry.addEventListener('click', (e) => { e.stopPropagation(); wake(); });
$('viewfinder').addEventListener('click', () => {
  if (state.starting) return;
  if (state.paused) wake();
  else if (!cam.live && el.msg.hidden) startCamera();
});

// ───────── Shutter ─────────
// pointerdown fires the instant a finger lands — no waiting for release.
el.shutter.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  el.shutter.classList.add('press');
  takeShot();
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) {
  el.shutter.addEventListener(ev, () => el.shutter.classList.remove('press'));
}
el.shutter.addEventListener('click', (e) => { if (e.detail === 0) takeShot(); }); // keyboard
el.shutter.addEventListener('contextmenu', (e) => e.preventDefault());

async function takeShot() {
  if (el.shutter.disabled) return;
  if (!cam.live) { if (state.paused) wake(); else startCamera(); return; }

  const useScreenFlash = state.flash && cam.facing === 'user';
  if (useScreenFlash) {
    el.screenFlash.classList.add('on');
    await wait(260); // let the camera's exposure adapt to the white screen
  }

  const canvas = cam.captureFrame(photoRotation());
  if (useScreenFlash) el.screenFlash.classList.remove('on');
  if (!canvas) return;

  shotFeedback();
  drawThumb(canvas);
  state.lastPhoto = persist(canvas);
}

function shotFeedback() {
  el.blink.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 200, easing: 'ease-out' });
  if (navigator.vibrate) navigator.vibrate(12);
  state.shots += 1;
  ls.set('nm.shots', String(state.shots));
  renderCount(true);
}

function renderCount(animate) {
  el.count.textContent = String(state.shots).padStart(3, '0');
  if (animate) {
    el.count.animate(
      [{ transform: 'translateY(-40%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }],
      { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
    );
  }
}

function drawThumb(src) {
  const c = el.thumbCanvas, ctx = c.getContext('2d');
  const s = Math.min(src.width, src.height);
  ctx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, c.width, c.height);
  c.classList.toggle('counter-rot', isRotated() && src.width > src.height);
  el.thumb.classList.add('has', 'ready');
  el.thumb.animate( // `scale` (not transform) so it composes with the sideways turn
    [{ scale: '.55', opacity: 0.3 }, { scale: '1', opacity: 1 }],
    { duration: 240, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
  // Remember the latest thumbnail across visits (tiny, off the hot path).
  setTimeout(() => { try { ls.set('nm.thumb', c.toDataURL('image/jpeg', 0.7)); } catch { /* ignore */ } }, 400);
}

function restoreThumb() {
  const data = ls.get('nm.thumb', '');
  if (!data) return;
  const img = new Image();
  img.onload = () => {
    el.thumbCanvas.getContext('2d').drawImage(img, 0, 0, el.thumbCanvas.width, el.thumbCanvas.height);
    el.thumb.classList.add('has');
  };
  img.src = data;
}

// Encode + store. Runs in the background; the shutter is free immediately.
// Resolves to the JPEG blob (or null) so the preview can show it.
async function persist(canvas) {
  try {
    const thumbP = makeThumb(canvas).catch(() => null); // album preview
    const blob = await canvasToJpeg(canvas);
    releaseCanvas(canvas);
    const thumb = await thumbP;
    const createdAt = Date.now();
    await store.savePhoto({
      id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
      blob, thumb: thumb || undefined, createdAt,
      guest: state.guest, deviceId: state.deviceId,
    });
    document.dispatchEvent(new CustomEvent('photo-saved'));
    return blob;
  } catch (err) {
    releaseCanvas(canvas);
    console.error('save failed', err);
    toast('Couldn’t save that photo — your phone may be out of space');
    return null;
  }
}

// ───────── Last-photo preview ─────────
let previewUrl = null;
el.thumb.addEventListener('click', async () => {
  if (!state.lastPhoto) return;
  const blob = await state.lastPhoto;
  if (!blob) return;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(blob);
  const img = el.previewImg;
  img.src = previewUrl;
  try { await img.decode(); } catch { /* show anyway */ }
  img.classList.toggle('counter-rot', isRotated() && img.naturalWidth > img.naturalHeight);
  el.preview.hidden = false;
  el.preview.animate(
    [{ opacity: 0, transform: 'scale(.97)' }, { opacity: 1, transform: 'scale(1)' }],
    { duration: 200, easing: 'cubic-bezier(.2,.8,.2,1)' },
  );
});
function closePreview() {
  if (el.preview.hidden) return;
  el.preview.hidden = true;
  el.previewImg.removeAttribute('src');
  if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
}
el.preview.addEventListener('click', closePreview); // tap anywhere to go back

// ───────── Switch camera ─────────
el.switchBtn.addEventListener('click', async () => {
  if (state.starting) return;
  el.switchBtn.classList.remove('spin'); void el.switchBtn.offsetWidth; el.switchBtn.classList.add('spin');
  await startCamera(cam.facing === 'user' ? 'environment' : 'user');
});

// ───────── Flash: screen flash (front) / torch (rear, Android) ─────────
async function syncFlash() {
  const front = cam.facing === 'user';
  const torch = !front && cam.torchSupported;
  el.flash.hidden = !(front || torch);
  if (el.flash.hidden) return;
  el.flash.setAttribute('aria-pressed', String(state.flash));
  if (torch) await cam.setTorch(state.flash);
}
el.flash.addEventListener('click', async () => {
  state.flash = !state.flash;
  await syncFlash();
  toast(state.flash ? (cam.facing === 'user' ? 'Selfie light on' : 'Light on') : 'Light off');
});

// ───────── Fallback: phone's own camera (only when the live camera can't start) ─────────
function openNative() {
  el.nativeInput.value = '';
  el.nativeInput.setAttribute('capture', cam.facing === 'user' ? 'user' : 'environment');
  state.nativeOpen = true;
  cam.stop(); // free the camera so the native app can open it (Android)
  el.nativeInput.click();
}
el.nativeFallback.addEventListener('click', openNative);

function nativeClosed() {
  state.nativeOpen = false;
  if (Camera.supported) resumeCamera();
}
el.nativeInput.addEventListener('cancel', nativeClosed);
el.nativeInput.addEventListener('change', async () => {
  const file = el.nativeInput.files && el.nativeInput.files[0];
  nativeClosed();
  if (!file) return;
  try {
    const canvas = await fileToCanvas(file);
    shotFeedback();
    drawThumb(canvas);
    state.lastPhoto = persist(canvas);
  } catch (err) {
    console.error(err);
    toast('Couldn’t read that photo — please try again');
  }
});
// If the native picker closes without 'cancel' support, focus brings us back.
window.addEventListener('focus', () => { if (state.nativeOpen) setTimeout(() => { if (state.nativeOpen) nativeClosed(); }, 600); });

// ───────── Keep screen awake while shooting ─────────
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && !state.wakeLock) {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    }
  } catch { /* not allowed / unsupported */ }
}
function releaseWakeLock() { try { state.wakeLock?.release(); } catch { /* ignore */ } state.wakeLock = null; }

// ───────── Misc ─────────
let toastTimer;
function toast(text) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ───────── Send status (camera pill + welcome line) ─────────
const ICON = {
  done: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  offline: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18.5h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.2 9.6 4.5 4.5 0 0 0 7 18.5z"/><path d="M4 4l16 16"/></svg>',
  waiting: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V6m0 0l-4 4m4-4l4 4"/><path d="M5 19h14"/></svg>',
  sending: '<span class="mini-spin" aria-hidden="true"></span>',
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

let lastStatus = null;
uploader.onStatus((s) => { lastStatus = s; renderStatus(); });

function renderStatus() {
  if (!lastStatus) return;
  const { pending, sending, offline, sent } = lastStatus;
  let st, pill, line;
  if (state.wrapped) {
    pill = '';
    if (pending === 0) {
      st = 'done';
      line = sent ? `All ${plural(sent, 'photo')} reached us. Thank you! 💛` : '';
    } else if (offline) {
      st = 'offline';
      line = `${plural(pending, 'photo')} still on your phone. Connect to the internet and keep this page open to send them.`;
    } else {
      st = 'sending';
      line = `Sending your last ${plural(pending, 'photo')}… please keep this page open.`;
    }
  } else if (pending === 0) {
    st = 'done';
    pill = sent ? 'All sent' : '';
    line = sent ? `All ${plural(sent, 'photo')} sent — thank you!` : '';
  } else if (offline) {
    st = 'offline';
    pill = `${pending} on phone`;
    line = `${plural(pending, 'photo')} saved on your phone. Open this page again when you have internet to send them.`;
  } else if (sending) {
    st = 'sending';
    pill = `Sending ${pending}`;
    line = `Sending your photos… ${pending} left`;
  } else {
    st = 'waiting';
    pill = `${pending} waiting`;
    line = `${plural(pending, 'photo')} waiting to send`;
  }
  const pillEl = $('send-status'), lineEl = $('welcome-status');
  pillEl.hidden = !pill;
  pillEl.dataset.state = st;
  pillEl.innerHTML = `${ICON[st]}<span>${pill}</span>`;
  lineEl.hidden = !line;
  lineEl.dataset.state = st;
  lineEl.innerHTML = `${ICON[st]}<span>${line}</span>`;
}
uploader.refresh();

// ───────── "That's a wrap" switch (event.json) ─────────
// When on: no camera, just a thank-you and the remaining uploads finishing.
function applyWrap(on, remember = true) {
  state.wrapped = on;
  if (remember) ls.set('nm.wrapped', on ? '1' : '0'); // works offline next time
  $('live-copy').hidden = on;
  $('wrap-copy').hidden = !on;
  el.form.hidden = on;
  if (on && state.screen === 'camera') goWelcome();
  renderStatus();
}
async function checkEvent() {
  const forced = new URLSearchParams(location.search).get('wrap'); // ?wrap=1 previews it
  if (forced === '1' || forced === '0') { applyWrap(forced === '1', false); return; }
  try {
    const res = await fetch(`${CONFIG.eventUrl}?t=${Date.now()}`, { cache: 'no-store' });
    if (res.ok) applyWrap(!!(await res.json()).wrapped);
  } catch { /* offline: keep the last known state */ }
}
applyWrap(ls.get('nm.wrapped', '0') === '1', false);
checkEvent();
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkEvent(); });

// iOS: block pinch-zoom gestures on the camera.
document.addEventListener('gesturestart', (e) => e.preventDefault());

// Offline shell — registered after load so it never competes with first paint.
// When a new version arrives, switch to it right away — but only by refreshing on
// the welcome screen (never mid-shoot, never while typing a name).
if ('serviceWorker' in navigator && window.isSecureContext) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return; // first visit: already running the newest code
    state.updateReady = true;
    if (state.screen === 'welcome' && document.activeElement !== el.name) location.reload();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW', err));
  });
}
