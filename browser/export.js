// Frame-exact offline export: seek -> render -> readPixels -> encode in the browser (web edition).

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
 *
 * Web edition: encoded in the browser (WebCodecs H.264 + mp4-muxer) and downloaded, instead of being piped
 * into the desktop app's ffmpeg. The soundtrack is the song from its start point, or the clip's own sound looped.
 */
export async function exportVideo(opts) {
  const { engine, video, fps, frames } = opts;
  const W = engine.w, H = engine.h;
  const vcfg = await pickVideoConfig(W, H, fps, opts.quality);
  const src = opts.audio === false ? null
    : opts.music ? { rec: window.acidMedia.get(opts.music.id), start: opts.musicStart || 0, loop: false }
    : opts.media?.kind === 'video' && opts.media.audio ? { rec: window.acidMedia.get(opts.media.id), start: 0, loop: true } : null;
  const acfg = src ? await pickAudioConfig() : null;
  const target = new Mp4Muxer.ArrayBufferTarget();
  const muxer = new Mp4Muxer.Muxer({
    target, video: { codec: 'avc', width: W, height: H, frameRate: fps },
    audio: acfg ? { codec: acfg.mux, numberOfChannels: 2, sampleRate: 48000 } : undefined,
    fastStart: 'in-memory', firstTimestampBehavior: 'offset',
  });
  if (acfg) await encodeAudio(muxer, await soundtrack(src, frames / fps), acfg.config);

  let encErr = null;
  const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
  enc.configure(vcfg);
  engine.reset();
  const buf = new Uint8Array(W * H * 4), flipped = new Uint8Array(W * H * 4), row = W * 4;
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    if (opts.isCancelled()) { enc.close(); return { cancelled: true }; }
    if (encErr) throw encErr;
    if (video) await seekVideo(video, Math.min(opts.sourceTime(i), video.duration - 0.001));
    opts.renderFrame(i, i / fps);
    engine.readPixels(buf);
    for (let y = 0; y < H; y++) flipped.set(buf.subarray((H - 1 - y) * row, (H - y) * row), y * row);   // GL reads bottom-up
    const vf = new VideoFrame(flipped, { format: 'RGBA', codedWidth: W, codedHeight: H, timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
    enc.encode(vf, { keyFrame: i % Math.round(fps * 2) === 0 });
    vf.close();
    while (enc.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 1));
    opts.onProgress(i + 1, frames, (i + 1) / ((performance.now() - t0) / 1000));
  }
  await enc.flush(); enc.close();
  if (encErr) throw encErr;
  muxer.finalize();
  const clean = (x) => String(x).replace(/[^\w\- ]+/g, '_');
  const name = `${clean(opts.name || 'acid')}_${clean(opts.preset || 'custom')}_${Date.now()}.mp4`;
  window.acidDownload(name, new Blob([target.buffer], { type: 'video/mp4' }));
  return { out: name };
}

async function pickVideoConfig(W, H, fps, quality) {
  const bitrate = Math.min(80e6, Math.round(W * H * fps * (quality === 'max' ? 0.4 : quality === 'small' ? 0.12 : 0.25)));
  for (const codec of ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4d0034', 'avc1.42e034']) {
    const c = { codec, width: W, height: H, bitrate, framerate: fps, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(c)).supported) return c; } catch { /* next */ }
  }
  throw new Error(`this browser cannot encode H.264 at ${W} x ${H}`);
}

async function pickAudioConfig() {
  if (!('AudioEncoder' in window)) return null;
  for (const [codec, mux] of [['mp4a.40.2', 'aac'], ['opus', 'opus']]) {
    const config = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate: 256000 };
    try { if ((await AudioEncoder.isConfigSupported(config)).supported) return { config, mux }; } catch { /* next */ }
  }
  return null;
}

/** The export's sound as a 48 kHz stereo buffer, `seconds` long. */
async function soundtrack({ rec, start, loop }, seconds) {
  const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await rec.blob.arrayBuffer());
  const off = new OfflineAudioContext(2, Math.max(1, Math.round(seconds * 48000)), 48000);
  const s = off.createBufferSource();
  s.buffer = decoded; s.loop = loop;
  s.connect(off.destination);
  s.start(0, start);
  return off.startRendering();
}

async function encodeAudio(muxer, buf, config) {
  let err = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { err = e; } });
  enc.configure(config);
  const n = buf.length, F = 1024, L = buf.getChannelData(0), R = buf.getChannelData(1);
  for (let i = 0; i < n; i += F) {
    if (err) throw err;
    const m = Math.min(F, n - i), data = new Float32Array(m * 2);
    data.set(L.subarray(i, i + m), 0); data.set(R.subarray(i, i + m), m);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: m, numberOfChannels: 2, timestamp: Math.round((i / 48000) * 1e6), data });
    enc.encode(ad); ad.close();
    if (enc.encodeQueueSize > 64) await new Promise((r) => setTimeout(r, 0));
  }
  await enc.flush(); enc.close();
  if (err) throw err;
}
