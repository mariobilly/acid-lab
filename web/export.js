// Frame-exact offline export: seek -> render -> readPixels -> stream raw RGBA into the server's ffmpeg pipe.

/** Seek a <video> and resolve once the new frame is decoded. */
export function seekVideo(video, t) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, 3000);
    video.addEventListener('seeked', () => {
      if (video.readyState >= 2) finish();
      else video.addEventListener('canplay', finish, { once: true });
    }, { once: true });
    video.currentTime = t;
  });
}

/**
 * opts: { engine, renderFrame(i, t), video|null, sourceTime(i) (where to seek the video for output frame i),
 *         media, music|null, musicStart, fps, frames, name, preset, quality, audio, onProgress(i, total, rate), isCancelled() }
 * Returns { out } or { cancelled: true }.
 */
export async function exportVideo(opts) {
  const { engine, video, fps, frames } = opts;
  const start = await fetch('/api/export/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media: opts.media?.id, width: engine.w, height: engine.h, fps, frames, name: opts.name, preset: opts.preset,
      quality: opts.quality, audio: opts.audio, music: opts.music?.id, music_start: opts.musicStart || 0,
    }),
  }).then((r) => r.json());
  if (!start.id) throw new Error(start.error || 'could not start export');
  const base = `/api/export/${start.id}`;

  engine.reset();
  const buf = new Uint8Array(engine.w * engine.h * 4);
  const inflight = [];
  let failed = null;
  const t0 = performance.now();

  // A Blob body snapshots the pixels (so `buf` can be reused at once) and uploads ~8x faster than a typed array.
  const send = (blob) =>
    fetch(base + '/frame', { method: 'POST', body: blob }).then(async (r) => {
      if (!r.ok) failed = (await r.json().catch(() => ({}))).error || `frame upload failed (${r.status})`;
    });

  try {
    for (let i = 0; i < frames; i++) {
      if (opts.isCancelled()) {
        await Promise.allSettled(inflight);
        await fetch(base + '/cancel', { method: 'POST' });
        return { cancelled: true };
      }
      if (failed) throw new Error(failed);
      if (video) await seekVideo(video, Math.min(opts.sourceTime(i), video.duration - 0.001));
      opts.renderFrame(i, i / fps);
      const blob = new Blob([engine.readPixels(buf)]);
      // keep a few uploads in flight (bounded memory); they must arrive in order, so chain each on the last
      if (inflight.length >= 4) await inflight.shift();
      const prev = inflight[inflight.length - 1] || Promise.resolve();
      inflight.push(prev.then(() => send(blob)));
      const el = (performance.now() - t0) / 1000;
      opts.onProgress(i + 1, frames, (i + 1) / el);
    }
    await Promise.all(inflight);
    if (failed) throw new Error(failed);
  } catch (e) {
    await fetch(base + '/cancel', { method: 'POST' }).catch(() => {});
    throw e;
  }
  const fin = await fetch(base + '/finish', { method: 'POST' }).then((r) => r.json());
  if (!fin.ok) throw new Error(fin.error || 'ffmpeg failed');
  return { out: fin.out };
}
