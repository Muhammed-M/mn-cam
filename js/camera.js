import { CONFIG } from './config.js';

// Live viewfinder (getUserMedia) + instant frame capture.
export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.facing = 'environment';
  }

  static get supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  }

  get live() {
    return !!this.track && this.track.readyState === 'live' && this.video.videoWidth > 0;
  }
  get mirrored() { return this.facing === 'user'; }

  async start(facing = this.facing) {
    this.stop();
    this.facing = facing;
    const base = { facingMode: { ideal: facing } };
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, width: { ideal: CONFIG.stream.width }, height: { ideal: CONFIG.stream.height } },
      });
    } catch (err) {
      if (err.name === 'NotAllowedError' || err.name === 'SecurityError') throw err;
      // Some devices reject big resolutions — retry with defaults.
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: base });
    }
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    const v = this.video;
    v.srcObject = stream;
    v.classList.toggle('mirror', this.mirrored);
    if (!v.videoWidth) {
      await new Promise((res) => {
        const done = () => { v.removeEventListener('loadedmetadata', done); res(); };
        v.addEventListener('loadedmetadata', done);
        setTimeout(done, 3000);
      });
    }
    try { await v.play(); } catch { /* autoplay with muted is allowed; ignore */ }
    v.classList.add('live');
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
    this.video.classList.remove('live');
    this.video.srcObject = null;
  }

  async hasMultipleCameras() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      return devices.filter((d) => d.kind === 'videoinput').length > 1;
    } catch { return true; }
  }

  get torchSupported() {
    try { return !!this.track?.getCapabilities?.().torch; } catch { return false; }
  }
  async setTorch(on) {
    if (!this.torchSupported) return false;
    try { await this.track.applyConstraints({ advanced: [{ torch: on }] }); return true; } catch { return false; }
  }

  // Grabs the current frame into a canvas (synchronous, so the shot is exactly
  // the moment of the tap), centre-cropped to 3:4 (4:3 sideways) to match the
  // viewfinder tile, then turned by `rotation` (0/90/180/270, clockwise) so it
  // comes out upright. Returns null if the stream isn't ready.
  captureFrame(rotation = 0) {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return null;
    const target = vw < vh ? 3 / 4 : 4 / 3; // width / height
    let sw = vw, sh = vh;
    if (vw / vh > target) sw = Math.round(vh * target); else sh = Math.round(vw / target);
    const sx = Math.round((vw - sw) / 2), sy = Math.round((vh - sh) / 2);
    const scale = Math.min(1, CONFIG.photo.maxEdge / Math.max(sw, sh));
    const w = Math.round(sw * scale), h = Math.round(sh * scale);
    const quarter = rotation === 90 || rotation === 270;
    const c = document.createElement('canvas');
    c.width = quarter ? h : w; c.height = quarter ? w : h;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    if (rotation) ctx.rotate((rotation * Math.PI) / 180);
    if (this.mirrored) ctx.scale(-1, 1); // save selfies as seen
    ctx.drawImage(v, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
    return c;
  }
}

// Phone's own camera photo (HD mode) → downscaled canvas, EXIF rotation applied by the browser.
export async function fileToCanvas(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const iw = img.naturalWidth, ih = img.naturalHeight;
    const scale = Math.min(1, CONFIG.photo.maxEdge / Math.max(iw, ih));
    const w = Math.round(iw * scale), h = Math.round(ih * scale);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, w, h);
    return c;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function canvasToJpeg(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', CONFIG.photo.quality);
  });
}

// Small preview (~30 KB) for the album grid. Draws synchronously, so the source
// canvas can be released right after this is called.
export function makeThumb(canvas, maxEdge = 480) {
  const s = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const t = document.createElement('canvas');
  t.width = Math.round(canvas.width * s); t.height = Math.round(canvas.height * s);
  const ctx = t.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, t.width, t.height);
  return new Promise((resolve) => t.toBlob((b) => { releaseCanvas(t); resolve(b); }, 'image/jpeg', 0.72));
}

// iOS caps total canvas memory; zeroing a finished canvas frees it immediately.
export function releaseCanvas(c) { c.width = 0; c.height = 0; }
