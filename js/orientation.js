// Orientation handling — two jobs:
//
// 1. Portrait lock. Browsers can't lock orientation outside fullscreen, so when a
//    phone with rotation unlocked turns sideways, we turn the whole app back by the
//    same angle: the layout always stays portrait to the phone. The camera feed
//    turns with the world, so the video gets the opposite turn — the viewfinder
//    stays a true window.
//
// 2. Upright photos. With rotation lock ON the browser never learns the phone was
//    turned, so a wide group shot would be saved sideways. The motion sensor tells
//    us how the phone is really held, and each photo is turned upright on capture.

const app = document.getElementById('app');
const video = document.getElementById('video');
const isPhone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
const norm = (d) => ((d % 360) + 360) % 360;

// ───────── 1. Portrait lock ─────────
let screenAngle = 0; // how far the browser turned the page (0 / 90 / 270)

function browserAngle() {
  const a = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
  return norm(a);
}

export function isRotated() { return app.classList.contains('rotated'); }

function apply() {
  const W = window.innerWidth, H = window.innerHeight;
  const rotate = isPhone && W > H;
  const a = browserAngle() === 270 ? 270 : 90;
  screenAngle = rotate ? a : 0;
  app.classList.toggle('rotated', rotate);
  app.classList.toggle('rot-90', rotate && a === 90);
  app.classList.toggle('rot-270', rotate && a === 270);
  if (rotate) {
    app.style.cssText = `width:${H}px;height:${W}px;left:${(W - H) / 2}px;top:${(H - W) / 2}px;transform:rotate(${-a}deg);--vrot:${a}deg`;
  } else {
    app.style.cssText = '';
  }
  syncVideo();
}

// Only un-turn the feed if the phone actually delivered it sideways.
function syncVideo() {
  video.classList.toggle('counter-rot', isRotated() && video.videoWidth > video.videoHeight);
}

window.addEventListener('resize', apply);
window.addEventListener('orientationchange', () => setTimeout(apply, 50));
if (screen.orientation) screen.orientation.addEventListener('change', apply);
video.addEventListener('resize', syncVideo);
video.addEventListener('loadedmetadata', syncVideo);
apply();

// ───────── 2. How the phone is physically held (motion sensor) ─────────
// deviceAngle: 0 portrait · 90 turned left (top to the left) · 180 upside down · 270 turned right
let deviceAngle = 0;
let sensorLive = false;

// Must be called from a tap (iPhone shows its permission popup here; Android needs none).
// Resolves either way — without the sensor, photos are simply saved as before.
export async function enableMotionSensor() {
  try {
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) return false;
    if (typeof DOE.requestPermission === 'function') {
      if ((await DOE.requestPermission()) !== 'granted') return false;
    }
    window.addEventListener('deviceorientation', onOrientation);
    return true;
  } catch {
    return false;
  }
}

function onOrientation(e) {
  if (e.beta == null || e.gamma == null) return;
  sensorLive = true;
  // Direction of "up" in the phone's own screen plane (W3C device orientation).
  const b = (e.beta * Math.PI) / 180, g = (e.gamma * Math.PI) / 180;
  const ux = -Math.sin(g) * Math.cos(b);
  const uy = Math.sin(b);
  if (Math.hypot(ux, uy) < 0.5) return; // phone nearly flat (shooting the table): keep last
  const ang = norm((Math.atan2(ux, uy) * 180) / Math.PI);
  const nearest = norm(Math.round(ang / 90) * 90);
  const off = Math.min(Math.abs(ang - nearest), 360 - Math.abs(ang - nearest));
  if (nearest !== deviceAngle && off < 30) { // hysteresis: no flicker near 45°
    deviceAngle = nearest;
    // Turn round icons + thumbnail to face the guest (shortest way round).
    const r = { 0: 0, 90: 90, 180: 180, 270: -90 }[deviceAngle];
    document.documentElement.style.setProperty('--icon-rot', `${r}deg`);
  }
}

// Degrees (clockwise) to turn a captured frame so the photo comes out upright.
export function photoRotation() {
  const streamAngle = video.classList.contains('counter-rot') ? screenAngle : 0;
  const held = sensorLive ? deviceAngle : streamAngle; // no sensor → trust the browser
  return norm(streamAngle - held);
}
