// All tunables in one place.
export const CONFIG = {
  // Saved photo size. 2560px long edge @ q0.85 ≈ 0.4–0.9 MB per photo.
  photo: { maxEdge: 2560, quality: 0.85 },

  // Live viewfinder resolution we *ask* for; the phone gives the closest it can.
  stream: { width: 3840, height: 2160 },

  // Photos go to Cloudflare R2 through our Worker (cloudflare/worker.js), which
  // only accepts new photos: no listing, reading, overwriting or deleting.
  uploadUrl: 'https://mn-cam-upload.mohamed-mahmoud9935.workers.dev/upload',
  upload: { concurrency: 2, timeoutMs: 60000 },

  // "That's a wrap" switch (set "wrapped": true in event.json after the party).
  eventUrl: 'event.json',

  // Battery saver: pause the camera after this long without a tap.
  idlePauseMs: 2 * 60 * 1000,
};
