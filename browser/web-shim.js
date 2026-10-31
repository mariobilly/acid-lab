// Browser edition: stands in for the local Acid Lab server (server.py), inside the browser.
// Loaded before app.js. It answers the app's fetch('/api/…') calls, so app.js runs almost unchanged:
//   · opening media: the file is used as it is (no ffmpeg proxy); its sound gives the per-frame envelope
//   · Beat Sync: a song's beat grid is found here (a lighter take on the desktop app's librosa analysis)
//   · looks you save stay in this browser; stills download
//   · the AI cut-out needs the desktop app's GPU, so the auto key is used instead
// Export is done in the browser (export.js). window.acidSrc() maps /api/media/… URLs to the files in memory.
(() => {
  const realFetch = window.fetch.bind(window);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const MAX_SIDE = 1920, MAX_FPS = 60;
  const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|wmv|mpg|mpeg|gif)$/i;
  const AUDIO_EXT = /\.(mp3|wav|m4a|aac|flac|ogg|opus|wma|aif|aiff)$/i;
  const IMAGE_EXT = /\.(png|jpe?g|webp|bmp|tiff?)$/i;

  const jobs = new Map();     // id → { state, progress, message, result }
  const media = new Map();    // id → { meta, blob, url, env, envByFps, beats }
  const uid = () => Math.random().toString(36).slice(2, 12);
  const LOOKS = 'acidlab-web.looks';

  // ---------- audio analysis ----------
  function fft(re, im) {   // in-place radix-2
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const p = i + k, q = p + len / 2;
          const tr = re[q] * cr - im[q] * ci, ti = re[q] * ci + im[q] * cr;
          re[q] = re[p] - tr; im[q] = im[p] - ti; re[p] += tr; im[p] += ti;
          [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
        }
      }
    }
  }
  async function monoPcm(blob, sr = 22050) {
    const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(await blob.arrayBuffer());
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * sr)), sr);
    const s = off.createBufferSource(); s.buffer = decoded; s.connect(off.destination); s.start();
    return { pcm: (await off.startRendering()).getChannelData(0), sr, duration: decoded.duration };
  }
  const pct = (arr, p) => { const s = Float32Array.from(arr).sort(); return s[Math.min(s.length - 1, Math.floor((p / 100) * (s.length - 1)))]; };
  const r3 = (a) => Array.from(a, (x) => Math.round(x * 1000) / 1000);

  /** Per-frame level, low, high and beat in 0..1: the same maths as server.py's audio_envelope. */
  function envelope({ pcm, sr }, fps, frames) {
    if (pcm.length < sr / 10) return null;
    const hop = sr / fps, win = 2048, half = win / 2;
    const hann = Float32Array.from({ length: win }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (win - 1)));
    const lowEnd = Math.floor((160 * win) / sr), highStart = Math.ceil((4000 * win) / sr) + 1;
    const lv = new Float32Array(frames), lo = new Float32Array(frames), hi = new Float32Array(frames);
    const re = new Float64Array(win), im = new Float64Array(win);
    for (let i = 0; i < frames; i++) {
      const c = Math.floor((i + 0.5) * hop), a = Math.max(0, c - half);
      let sq = 0;
      for (let k = 0; k < win; k++) {
        const s = a + k < c + half && a + k < pcm.length ? pcm[a + k] : 0;
        sq += s * s; re[k] = s * hann[k]; im[k] = 0;
      }
      fft(re, im);
      let l = 0, h = 0;
      for (let k = 0; k < lowEnd; k++) l += Math.hypot(re[k], im[k]);
      for (let k = highStart; k <= half; k++) h += Math.hypot(re[k], im[k]);
      lv[i] = Math.sqrt(sq / win); lo[i] = l / Math.max(1, lowEnd); hi[i] = h / Math.max(1, half - highStart + 1);
    }
    for (const x of [lv, lo, hi]) { const p = pct(x, 97) || 1; for (let i = 0; i < frames; i++) x[i] = Math.min(1, Math.max(0, x[i] / p)); }
    const flux = lo.map((v, i) => Math.max(0, v - (i ? lo[i - 1] : lo[0])));
    const k = Math.max(3, Math.floor(fps * 0.4)), beat = new Float32Array(frames);
    const decay = Math.exp(-1 / (fps * 0.12)), gap = Math.floor(fps * 0.18);
    let env = 0, last = -999;
    for (let i = 0; i < frames; i++) {
      let sum = 0, n = 0;
      for (let j = i - Math.floor(k / 2); j < i - Math.floor(k / 2) + k; j++) if (j >= 0 && j < frames) { sum += flux[j]; n++; }
      const local = sum / k;
      if (flux[i] > 0.08 && flux[i] > local * 1.6 && i - last > gap) { env = 1; last = i; }
      beat[i] = env; env *= decay;
    }
    return { level: r3(lv), low: r3(lo), high: r3(hi), beat: r3(beat) };
  }

  /** Tempo, beat times, kicks and downbeat phase (a lighter take on librosa's beat tracker). */
  function beatGrid({ pcm, sr, duration }) {
    const hop = 512, nfft = 2048, nf = Math.max(1, Math.floor((pcm.length - nfft) / hop));
    const lowBins = Math.floor((150 * nfft) / sr);
    const onset = new Float32Array(nf), lowEnv = new Float32Array(nf);
    let prev = null, prevLow = null;
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    const hann = Float32Array.from({ length: nfft }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (nfft - 1)));
    for (let f = 0; f < nf; f++) {
      for (let k = 0; k < nfft; k++) { re[k] = pcm[f * hop + k] * hann[k]; im[k] = 0; }
      fft(re, im);
      const db = new Float32Array(nfft / 2);
      for (let k = 0; k < nfft / 2; k++) db[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) + 1e-6);
      if (prev) {
        let s = 0, sl = 0;
        for (let k = 0; k < nfft / 2; k++) s += Math.max(0, db[k] - prev[k]);
        for (let k = 0; k < lowBins; k++) sl += Math.max(0, db[k] - prevLow[k]);
        onset[f] = s / (nfft / 2); lowEnv[f] = sl / Math.max(1, lowBins);
      }
      prev = db; prevLow = db;
    }
    const fpsO = sr / hop, lag = hop / sr;
    // tempo: autocorrelation of the onset envelope over 70–180 BPM, weighted towards 120
    let best = 0, period = fpsO / 2;
    for (let bpm = 70; bpm <= 180; bpm += 0.5) {
      const L = (60 * fpsO) / bpm, Li = Math.round(L);
      let ac = 0;
      for (let i = Li; i < nf; i++) ac += onset[i] * onset[i - Li];
      ac *= Math.exp(-0.5 * Math.log2(bpm / 120) ** 2 / 0.6 ** 2);
      if (ac > best) { best = ac; period = L; }
    }
    // phase: the grid offset that catches the most onset energy, then each beat snapped to a nearby peak
    let bestOff = 0, bestScore = -1;
    for (let off = 0; off < period; off++) {
      let s = 0;
      for (let t = off; t < nf; t += period) s += onset[Math.round(t)] || 0;
      if (s > bestScore) { bestScore = s; bestOff = off; }
    }
    const beatsF = [], w = Math.max(1, Math.round(period * 0.1));
    for (let t = bestOff; t < nf; t += period) {
      let bi = Math.round(t);
      for (let j = Math.max(0, bi - w); j <= Math.min(nf - 1, bi + w); j++) if (onset[j] > onset[bi]) bi = j;
      beatsF.push(bi);
    }
    // kicks: strong low-band onset peaks, at least 0.1 s apart
    const peaks = [], waitF = Math.round(0.1 * fpsO);
    for (let i = 1; i < nf - 1; i++) if (lowEnv[i] > lowEnv[i - 1] && lowEnv[i] >= lowEnv[i + 1] && (!peaks.length || i - peaks[peaks.length - 1] > waitF)) peaks.push(i);
    const thr = peaks.length ? 0.45 * pct(peaks.map((i) => lowEnv[i]), 95) : 0;
    const kicks = peaks.filter((i) => lowEnv[i] >= thr);
    let phase = 0;
    if (beatsF.length >= 8) {
      const scores = [0, 1, 2, 3].map((p) => { const b = beatsF.filter((_, i) => i % 4 === p); return b.reduce((s, i) => s + lowEnv[i], 0) / Math.max(1, b.length); });
      const mx = Math.max(...scores); phase = scores.findIndex((s) => s >= mx * 0.88);
    }
    const t = (f) => Math.round(Math.max(0, f / fpsO - lag) * 10000) / 10000;
    return { tempo: Math.round(6000 * fpsO / period) / 100, beats: beatsF.map(t), kicks: kicks.map(t), phase, duration: Math.round(duration * 1000) / 1000 };
  }

  // ---------- media ----------
  const once = (el, ev) => new Promise((res, rej) => { el.addEventListener(ev, res, { once: true }); el.addEventListener('error', () => rej(new Error('this browser cannot open that file')), { once: true }); });
  async function videoFps(url) {
    const v = document.createElement('video'); v.muted = true; v.src = url;
    await once(v, 'loadeddata');
    if (!v.requestVideoFrameCallback) return 30;
    const times = [];
    await new Promise((res) => {
      const cb = (_, m) => { times.push(m.mediaTime); if (times.length < 8) v.requestVideoFrameCallback(cb); else res(); };
      v.requestVideoFrameCallback(cb); v.play().catch(res); setTimeout(res, 2500);
    });
    v.pause(); v.removeAttribute('src'); v.load();
    const d = times.slice(1).map((t, i) => t - times[i]).filter((x) => x > 0.001).sort((a, b) => a - b);
    const fps = d.length ? 1 / d[Math.floor(d.length / 2)] : 30;
    return Math.min(MAX_FPS, Math.round(fps * 1000) / 1000) || 30;
  }

  async function prepareMedia(file, job) {
    const id = uid(), name = file.name.replace(/\.[^.]+$/, '');
    if (IMAGE_EXT.test(file.name) || file.type.startsWith('image/')) {
      let bmp = await createImageBitmap(file), blob = file;
      const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
      if (s < 1) {
        const c = new OffscreenCanvas(Math.round(bmp.width * s / 2) * 2, Math.round(bmp.height * s / 2) * 2);
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        blob = await c.convertToBlob({ type: 'image/png' }); bmp = await createImageBitmap(blob);
      }
      const meta = { id, kind: 'image', name, width: bmp.width, height: bmp.height, fps: 30, duration: 5, frames: 150, audio: false };
      media.set(id, { meta, blob });
      return meta;
    }
    const url = URL.createObjectURL(file);
    const v = document.createElement('video'); v.preload = 'auto'; v.src = url;
    job.message = 'Opening the video'; await once(v, 'loadedmetadata');
    job.progress = 0.2; job.message = 'Measuring the frame rate';
    const fps = await videoFps(url);
    const frames = Math.max(1, Math.round(v.duration * fps));
    const meta = { id, kind: 'video', name, width: v.videoWidth, height: v.videoHeight, fps, duration: frames / fps, frames, audio: false };
    const rec = { meta, blob: file, url };
    media.set(id, rec);
    job.progress = 0.5; job.message = 'Listening to the audio';
    try { rec.pcm = await monoPcm(file); rec.env = envelope(rec.pcm, fps, frames); meta.audio = !!rec.env; } catch { /* no sound */ }
    return meta;
  }

  async function prepareMusic(file, job) {
    job.message = 'Decoding the song';
    let pcm;
    try { pcm = await monoPcm(file); } catch { throw new Error("That file has no sound for Beat Sync to follow — pick a song or a video with audio."); }
    job.progress = 0.4; job.message = 'Finding the beat';
    await new Promise((r) => setTimeout(r, 30));
    const id = uid(), beats = beatGrid(pcm);
    const meta = { id, kind: 'audio', name: file.name.replace(/\.[^.]+$/, ''), duration: pcm.duration, audio: true, tempo: beats.tempo, beats: beats.beats.length };
    media.set(id, { meta, blob: file, pcm, beats });
    return meta;
  }

  const pub = (m) => ({ ...m, has_mask: false, has_envelope: !!media.get(m.id)?.env });

  function startJob(file, music) {
    const id = uid(), job = { id, state: 'running', progress: 0, message: 'Preparing…' };
    jobs.set(id, job);
    (music ? prepareMusic(file, job) : prepareMedia(file, job))
      .then((m) => Object.assign(job, { state: 'done', progress: 1, media: m.id, result: pub(m) }))
      .catch((e) => Object.assign(job, { state: 'error', message: e.message }));
    return id;
  }

  function pickFile(music) {
    return new Promise((res) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = music ? 'audio/*,video/*' : 'video/*,image/*';
      inp.onchange = () => res(inp.files[0] || null);
      inp.oncancel = () => res(null);
      inp.click();
    });
  }

  /** <video>, <img> and <audio> load /api/media/… URLs directly, so app.js maps them through this. */
  window.acidSrc = (u) => {
    const m = /\/api\/media\/([^/]+)\/(video|image|music)/.exec(u);
    const rec = m && media.get(m[1]);
    if (!rec) return u;
    rec.url ??= URL.createObjectURL(rec.blob);
    return rec.url;
  };
  window.acidMedia = media;   // for export.js (soundtrack)

  async function handle(url, init) {
    const p = url.pathname, q = url.searchParams;
    const body = () => JSON.parse(typeof init?.body === 'string' ? init.body || '{}' : '{}');
    let m;
    if (p === '/api/ping') return json({ ok: true });
    if (p === '/api/bye' || p === '/api/reveal' || p === '/api/open_file' || p === '/api/request_open') return json({ ok: true });
    if (p === '/api/browse') {
      const music = body().music === true;   // the Open button passes its click event here, so only a literal true means music
      const file = await pickFile(music);
      if (!file) return json({ cancelled: true });
      return json({ job: startJob(file, music || AUDIO_EXT.test(file.name)), music });
    }
    if (p === '/api/upload') {
      const file = init.body.get('file');
      const name = (file?.name || '').toLowerCase();
      const music = q.get('music') === '1' || AUDIO_EXT.test(name);
      if (!file || !(VIDEO_EXT.test(name) || IMAGE_EXT.test(name) || AUDIO_EXT.test(name))) return json({ error: 'Drop a video, an image, or a song (mp3, wav, m4a…).' }, 400);
      return json({ job: startJob(file, music), music });
    }
    if (p === '/api/open') return json({ error: 'Open a file with the Open button, or drop it on the window.' }, 400);
    if ((m = /^\/api\/job\/([^/]+)(\/cancel)?$/.exec(p))) {
      const j = jobs.get(m[1]);
      return j ? json(j) : json({ error: 'unknown job' }, 404);
    }
    if ((m = /^\/api\/beats\/([^/]+)$/.exec(p))) {
      const rec = media.get(m[1]);
      if (!rec?.pcm) return json({ error: 'no audio' }, 404);
      rec.beats ??= beatGrid(rec.pcm);
      return json(rec.beats);
    }
    if ((m = /^\/api\/media\/([^/]+)\/envelope$/.exec(p))) {
      const rec = media.get(m[1]), fps = Number(q.get('fps') || 30);
      if (!rec?.pcm) return json({}, 404);
      rec.envByFps ??= {};
      rec.envByFps[fps] ??= envelope(rec.pcm, fps, Math.max(1, Math.floor(rec.meta.duration * fps))) || {};
      return json(rec.envByFps[fps]);
    }
    if ((m = /^\/api\/media\/([^/]+)\/(\w+)$/.exec(p))) {
      const rec = media.get(m[1]);
      if (!rec) return json({ error: 'not found' }, 404);
      if (m[2] === 'audio') return rec.env ? json(rec.env) : json({}, 404);
      if (['video', 'image', 'music'].includes(m[2])) return new Response(rec.blob);
      return json({ error: 'not found' }, 404);
    }
    if ((m = /^\/api\/media\/([^/]+)$/.exec(p))) { const rec = media.get(m[1]); return rec ? json(pub(rec.meta)) : json({}, 404); }
    if (p.startsWith('/api/mask/')) return json({ error: 'The AI cut-out runs on a GPU in the desktop app. Here, the auto key separates the subject.' }, 400);
    if (p === '/api/presets') {
      if ((init?.method || 'GET').toUpperCase() === 'POST') { try { localStorage.setItem(LOOKS, init.body); } catch { /* full */ } return json({ ok: true }); }
      try { return json(JSON.parse(localStorage.getItem(LOOKS) || '[]')); } catch { return json([]); }
    }
    if (p === '/api/still') {
      const name = `${(q.get('name') || 'acid').replace(/[^\w\- ]+/g, '_')}_${Date.now()}.png`;
      window.acidDownload(name, init.body);
      return json({ ok: true, out: name });
    }
    return json({ error: 'not available in the web version' }, 404);
  }

  window.acidDownload = (name, blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  };

  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) return handle(url, init);
    return realFetch(input, init);
  };
})();
