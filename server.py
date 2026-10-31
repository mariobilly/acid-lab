"""Acid Lab - local backend (Flask) for the psychedelic glitch studio.

The UI (web/) renders every effect with WebGL in a Chrome --app window. This server prepares media
(seek-friendly H.264 proxy + per-frame audio envelope), cuts the subject out on the GPU, pipes rendered
frames into ffmpeg for export, and shuts itself down when the window has been closed.
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from fractions import Fraction

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA", APP_DIR), "AcidLab")
WORK_DIR = os.path.join(DATA_DIR, "work")
UPLOAD_DIR = os.path.join(DATA_DIR, "uploads")
PRESET_FILE = os.path.join(DATA_DIR, "user_presets.json")
OUT_DIR = os.path.join(os.path.expanduser("~"), "Videos", "Acid Lab")
for d in (DATA_DIR, WORK_DIR, UPLOAD_DIR):
    os.makedirs(d, exist_ok=True)

# pythonw has no console: route all output to a log file before heavy imports print anything
if sys.stdout is None or not sys.stdout.isatty():
    _log = open(os.path.join(DATA_DIR, "app.log"), "a", buffering=1, encoding="utf-8", errors="replace")
    sys.stdout = sys.stderr = _log

import numpy as np  # noqa: E402
from flask import Flask, abort, jsonify, request, send_file, send_from_directory  # noqa: E402

PORT = 47833
APP_ID = "acid-lab"
VIDEO_EXT = (".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".wmv", ".mpg", ".mpeg", ".gif")
AUDIO_EXT = (".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".wma", ".aif", ".aiff")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")
MAX_SIDE = 1920          # proxies are capped to this long side (Instagram never needs more)
MAX_FPS = 60
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

app = Flask(__name__, static_folder=None)
LOCK = threading.Lock()
S = {"media": {}, "jobs": {}, "exports": {}, "pending_open": None,
     "last_ping": time.time(), "bye_at": None}

PICK_CODE = """
import sys, tkinter as tk
from tkinter import filedialog
r = tk.Tk(); r.withdraw(); r.attributes('-topmost', True)
p = filedialog.askopenfilename(parent=r, title=%r,
        filetypes=[(%r, %r), ('All files', '*.*')])
sys.stdout.write(p or '')
"""


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          creationflags=NO_WINDOW, **kw)


# --------------------------------------------------------------------------- media

def probe(path):
    r = run(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path])
    if r.returncode != 0:
        raise RuntimeError("ffprobe could not read this file")
    j = json.loads(r.stdout or "{}")
    v = next((s for s in j.get("streams", []) if s.get("codec_type") == "video"), None)
    a = next((s for s in j.get("streams", []) if s.get("codec_type") == "audio"), None)
    if not v:
        raise RuntimeError("No video stream found")

    def rate(s):
        try:
            f = Fraction(s)
            return float(f) if f > 0 else 0.0
        except (ValueError, ZeroDivisionError):
            return 0.0
    fps = rate(v.get("r_frame_rate", "0"))
    if not 1 <= fps <= 120:
        fps = rate(v.get("avg_frame_rate", "0")) or 30.0
    w, h = int(v.get("width", 0)), int(v.get("height", 0))
    rot = 0
    for sd in v.get("side_data_list", []) or []:
        if "rotation" in sd:
            rot = int(sd["rotation"])
    if abs(rot) in (90, 270):
        w, h = h, w
    dur = float(j.get("format", {}).get("duration") or v.get("duration") or 0)
    nb = int(v.get("nb_frames") or 0)
    return {"width": w, "height": h, "fps": fps, "duration": dur, "frames": nb,
            "codec": v.get("codec_name"), "audio": a is not None}


def media_key(path):
    st = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime}".encode()).hexdigest()[:16]


def even(x):
    return max(2, int(round(x / 2.0)) * 2)


def nvenc_ok():
    if "nvenc" not in S:
        try:
            r = run(["ffmpeg", "-hide_banner", "-encoders"])
            S["nvenc"] = "h264_nvenc" in r.stdout
        except Exception:
            S["nvenc"] = False
    return S["nvenc"]


def h264_args(quality="high", gop=None):
    q = {"high": ("17", "16"), "max": ("14", "12"), "proxy": ("19", "18")}[quality]
    g = ["-g", str(gop), "-bf", "0"] if gop else []
    if nvenc_ok():
        return ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", q[0], "-b:v", "0",
                "-profile:v", "high"] + g
    return ["-c:v", "libx264", "-preset", "medium", "-crf", q[1]] + g


def new_job(kind, media_id=None):
    jid = uuid.uuid4().hex[:10]
    S["jobs"][jid] = {"id": jid, "kind": kind, "media": media_id, "state": "running",
                      "progress": 0.0, "message": "", "cancel": False}
    return S["jobs"][jid]


def busy():
    return any(j["state"] == "running" for j in S["jobs"].values()) or bool(S["exports"])


def ffmpeg_progress(cmd, total_s, job, lo=0.0, hi=1.0):
    """Run ffmpeg with -progress on stdout, mapping out_time onto job progress lo..hi."""
    p = subprocess.Popen(cmd + ["-progress", "pipe:1", "-nostats"], stdout=subprocess.PIPE,
                         stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
                         creationflags=NO_WINDOW)
    err = []
    threading.Thread(target=lambda: err.extend(p.stderr), daemon=True).start()
    for line in p.stdout:
        if job.get("cancel"):
            p.kill()
            raise RuntimeError("cancelled")
        if line.startswith("out_time_us=") or line.startswith("out_time_ms="):
            try:
                t = int(line.split("=")[1]) / 1e6
                job["progress"] = lo + (hi - lo) * min(1.0, t / max(total_s, 0.01))
            except ValueError:
                pass
    p.wait()
    if p.returncode != 0:
        raise RuntimeError("ffmpeg failed: " + "".join(err[-6:]))


def audio_envelope(path, fps, frames):
    """Per-frame audio features (level, low, high, beat) in 0..1 so preview and export react identically."""
    sr = 22050
    r = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-vn", "-ac", "1", "-ar", str(sr), "-f", "s16le", "-"],
                       capture_output=True, creationflags=NO_WINDOW)
    pcm = np.frombuffer(r.stdout, dtype=np.int16).astype(np.float32) / 32768.0
    if pcm.size < sr // 10:
        return None
    hop = sr / fps
    win = 2048
    freqs = np.fft.rfftfreq(win, 1 / sr)
    lowb, highb = freqs < 160, freqs > 4000
    hann = np.hanning(win).astype(np.float32)
    lv, lo, hi = np.zeros(frames, np.float32), np.zeros(frames, np.float32), np.zeros(frames, np.float32)
    for i in range(frames):
        c = int((i + 0.5) * hop)
        seg = pcm[max(0, c - win // 2): c + win // 2]
        if seg.size < win:
            seg = np.pad(seg, (0, win - seg.size))
        mag = np.abs(np.fft.rfft(seg * hann))
        lv[i] = np.sqrt(np.mean(seg ** 2))
        lo[i] = mag[lowb].mean()
        hi[i] = mag[highb].mean()

    def norm(x):
        p = np.percentile(x, 97) or 1.0
        return np.clip(x / p, 0, 1)
    lv, lo, hi = norm(lv), norm(lo), norm(hi)
    # onsets: positive flux of the low band, peak-picked against a local mean, then a fast-decay envelope
    flux = np.maximum(0, np.diff(lo, prepend=lo[:1]))
    k = max(3, int(fps * 0.4))
    local = np.convolve(flux, np.ones(k) / k, mode="same")
    beat = np.zeros(frames, np.float32)
    last = -999
    gap = int(fps * 0.18)
    decay = np.exp(-1.0 / (fps * 0.12))
    env = 0.0
    for i in range(frames):
        if flux[i] > 0.08 and flux[i] > local[i] * 1.6 and i - last > gap:
            env, last = 1.0, i
        beat[i] = env
        env *= decay
    r3 = lambda a: [round(float(x), 3) for x in a]  # noqa: E731
    return {"level": r3(lv), "low": r3(lo), "high": r3(hi), "beat": r3(beat)}


def prepare_media(path, job=None):
    """Make (or reuse) the cached proxy + envelope for a file. Returns the media record."""
    path = os.path.abspath(path)
    ext = os.path.splitext(path)[1].lower()
    key = media_key(path)
    d = os.path.join(WORK_DIR, key)
    os.makedirs(d, exist_ok=True)
    meta_path = os.path.join(d, "meta.json")
    os.utime(d, None)
    if os.path.exists(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            m = json.load(f)
        m["has_mask"] = os.path.exists(os.path.join(d, "packed.mp4" if m["kind"] == "video" else "mask.png"))
        S["media"][key] = m
        return m

    name = os.path.splitext(os.path.basename(path))[0]
    if ext in IMAGE_EXT:
        from PIL import Image, ImageOps
        im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
        s = min(1.0, MAX_SIDE / max(im.size))
        if s < 1:
            im = im.resize((even(im.width * s), even(im.height * s)), Image.LANCZOS)
        im.save(os.path.join(d, "image.png"))
        m = {"id": key, "kind": "image", "name": name, "path": path, "width": im.width, "height": im.height,
             "fps": 30.0, "duration": 5.0, "frames": 150, "audio": False}
    else:
        info = probe(path)
        fps = min(MAX_FPS, round(info["fps"], 3))
        s = min(1.0, MAX_SIDE / max(info["width"], info["height"]))
        w, h = even(info["width"] * s), even(info["height"] * s)
        proxy = os.path.join(d, "proxy.mp4")
        if job:
            job["message"] = "Preparing video"
        # CFR + short GOP + no B-frames: every frame index maps to one exact, quickly seekable time.
        cmd = ["ffmpeg", "-y", "-v", "error", "-i", path, "-map", "0:v:0", "-map", "0:a:0?",
               "-vf", f"scale={w}:{h}:flags=lanczos,format=yuv420p", "-fps_mode", "cfr", "-r", str(fps),
               *h264_args("proxy", gop=10), "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", proxy]
        ffmpeg_progress(cmd, info["duration"], job or {}, 0.0, 0.85)
        pi = probe(proxy)
        frames = pi["frames"] or int(round(pi["duration"] * fps))
        m = {"id": key, "kind": "video", "name": name, "path": path, "width": w, "height": h, "fps": fps,
             "duration": frames / fps, "frames": frames, "audio": pi["audio"]}
        if pi["audio"]:
            if job:
                job["message"] = "Listening to the audio"
            try:
                env = audio_envelope(proxy, fps, frames)
                if env:
                    with open(os.path.join(d, "audio.json"), "w", encoding="utf-8") as f:
                        json.dump(env, f)
            except Exception:
                log("audio envelope failed", traceback.format_exc())
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(m, f)
    m["has_mask"] = False
    S["media"][key] = m
    return m


def analyze_beats(path):
    """Musical beat grid: tempo, beat times, kick onsets and which beat of the bar is the downbeat."""
    import librosa
    y, sr = librosa.load(path, sr=22050, mono=True)
    hop = 512
    oenv = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, aggregate=np.median)
    tempo, beat_frames = librosa.beat.beat_track(onset_envelope=oenv, sr=sr, hop_length=hop, tightness=100)
    # onset-strength peaks trail the actual hit by about one hop; measured on synthetic drums: 29 ms -> 6 ms error
    lag = hop / sr
    beats = np.maximum(0, librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop) - lag)
    # kicks: low-band onsets, keeping only the strong ones (bass notes also make low onsets)
    spec = np.abs(librosa.stft(y, n_fft=2048, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    low_env = librosa.onset.onset_strength(S=librosa.amplitude_to_db(spec[freqs < 150], ref=np.max), sr=sr, hop_length=hop)
    kf = librosa.onset.onset_detect(onset_envelope=low_env, sr=sr, hop_length=hop, units="frames", wait=int(0.1 * sr / hop))
    if len(kf):
        kf = kf[low_env[kf] >= 0.45 * np.percentile(low_env[kf], 95)]
    kicks = np.maximum(0, librosa.frames_to_time(kf, sr=sr, hop_length=hop) - lag)
    # downbeat: the beat phase (0-3) where the low end hits hardest is most likely "1"; kicks often land on 1 and 3,
    # so near-ties go to the earliest phase (songs usually start on a downbeat)
    phase = 0
    if len(beat_frames) >= 8:
        scores = np.array([float(np.mean(low_env[np.clip(beat_frames[p::4], 0, len(low_env) - 1)])) for p in range(4)])
        phase = int(np.flatnonzero(scores >= scores.max() * 0.88)[0])
    r3 = lambda a: [round(float(x), 4) for x in a]  # noqa: E731
    return {"tempo": round(float(np.atleast_1d(tempo)[0]), 2), "beats": r3(beats), "kicks": r3(kicks),
            "phase": phase, "duration": round(len(y) / sr, 3)}


def beats_for(m):
    """Cached beat grid of a music track, or of a video's own soundtrack."""
    d = os.path.join(WORK_DIR, m["id"])
    p = os.path.join(d, "beats.json")
    if not os.path.exists(p):
        src = os.path.join(d, "music.m4a" if m["kind"] == "audio" else "proxy.mp4")
        b = analyze_beats(src)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(b, f)
        return b
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def prepare_music(path, job):
    """A song (or any file with sound) to drive Beat Sync: AAC copy for playback/export + beat grid."""
    path = os.path.abspath(path)
    st = os.stat(path)
    key = hashlib.sha1(f"music|{path}|{st.st_size}|{st.st_mtime}".encode()).hexdigest()[:16]
    d = os.path.join(WORK_DIR, key)
    os.makedirs(d, exist_ok=True)
    os.utime(d, None)
    meta_path = os.path.join(d, "meta.json")
    if os.path.exists(meta_path) and os.path.exists(os.path.join(d, "beats.json")):
        with open(meta_path, encoding="utf-8") as f:
            m = json.load(f)
        S["media"][key] = m
        return m
    job["message"] = "Decoding the song"
    info = json.loads(run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index:format=duration",
                           "-of", "json", path]).stdout or "{}")
    dur = float(info.get("format", {}).get("duration") or 0)
    if dur <= 0 or not info.get("streams"):
        raise RuntimeError("That file has no sound for Beat Sync to follow — pick a song or a video with audio.")
    ffmpeg_progress(["ffmpeg", "-y", "-v", "error", "-i", path, "-vn", "-map", "0:a:0", "-ac", "2", "-ar", "44100",
                     "-c:a", "aac", "-b:a", "256k", "-movflags", "+faststart", os.path.join(d, "music.m4a")],
                    dur, job, 0.0, 0.3)
    job["message"] = "Finding the beat"
    job["progress"] = 0.35
    m = {"id": key, "kind": "audio", "name": os.path.splitext(os.path.basename(path))[0], "path": path,
         "duration": dur, "audio": True}
    S["media"][key] = m
    b = beats_for(m)
    m["tempo"], m["beats"] = b["tempo"], len(b["beats"])
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(m, f)
    return m


def start_open(path, music=False):
    job = new_job("music" if music else "prepare")

    def work():
        try:
            m = prepare_music(path, job) if music else prepare_media(path, job)
            job.update(state="done", progress=1.0, media=m["id"], result=public(m))
            log("opened", "music" if music else "media", path)
        except Exception as e:
            log("open failed", traceback.format_exc())
            job.update(state="error", message=str(e))
    threading.Thread(target=work, daemon=True).start()
    return job


def public(m):
    d = os.path.join(WORK_DIR, m["id"])
    out = {k: m.get(k) for k in ("id", "kind", "name", "width", "height", "fps", "duration", "frames", "audio",
                                 "tempo", "beats")}
    out["has_mask"] = m.get("has_mask", False)
    out["has_envelope"] = os.path.exists(os.path.join(d, "audio.json"))
    return out


def prune_cache(days=14):
    cutoff = time.time() - days * 86400
    for name in os.listdir(WORK_DIR):
        p = os.path.join(WORK_DIR, name)
        try:
            if os.path.isdir(p) and os.path.getmtime(p) < cutoff:
                shutil.rmtree(p, ignore_errors=True)
        except OSError:
            pass


# --------------------------------------------------------------------------- routes: app + lifecycle

@app.get("/")
def index():
    return send_from_directory(os.path.join(APP_DIR, "web"), "index.html")


@app.get("/web/<path:p>")
def web(p):
    return send_from_directory(os.path.join(APP_DIR, "web"), p)


@app.get("/favicon.png")
def favicon():
    return send_from_directory(os.path.join(APP_DIR, "assets"), "acidlab.png")


@app.after_request
def no_cache(r):
    if request.path == "/" or request.path.startswith("/web/"):
        r.headers["Cache-Control"] = "no-store"
    return r


@app.get("/api/ping")
def ping_get():
    return jsonify(ok=True, app=APP_ID, window_alive=time.time() - S["last_ping"] < 12)


@app.post("/api/ping")
def ping():
    S["last_ping"], S["bye_at"] = time.time(), None
    p, S["pending_open"] = S["pending_open"], None
    return jsonify(ok=True, open=p)


@app.post("/api/bye")
def bye():
    S["bye_at"] = time.time()
    return ("", 204)


@app.post("/api/request_open")
def request_open():
    """Launcher hands over a file dropped on the shortcut while the window is already open."""
    S["pending_open"] = request.json.get("path")
    return jsonify(ok=True)


# --------------------------------------------------------------------------- routes: media

def is_audio(path):
    return path.lower().endswith(AUDIO_EXT)


@app.post("/api/open")
def open_path():
    """Open a video/image, or a song for Beat Sync (audio files, or any file when music=true)."""
    b = request.json or {}
    path = b.get("path", "")
    music = bool(b.get("music")) or is_audio(path)
    ok = VIDEO_EXT + AUDIO_EXT if music else VIDEO_EXT + IMAGE_EXT
    if not os.path.isfile(path) or not path.lower().endswith(ok):
        return jsonify(error="That file isn't something I can open."), 400
    return jsonify(job=start_open(path, music)["id"], music=music)


@app.post("/api/browse")
def browse():
    music = bool((request.json or {}).get("music"))
    exts = " ".join("*" + e for e in (AUDIO_EXT + VIDEO_EXT if music else VIDEO_EXT + IMAGE_EXT))
    title, label = ("Load music for Beat Sync", "Music or video") if music else ("Open a video or image", "Video or image")
    r = run([sys.executable, "-c", PICK_CODE % (title, label, exts)])
    path = (r.stdout or "").strip()
    if not path:
        return jsonify(cancelled=True)
    return jsonify(job=start_open(path, music)["id"], music=music)


@app.post("/api/upload")
def upload():
    f = request.files.get("file")
    name = (f.filename if f else "").lower()
    music = request.args.get("music") == "1" or name.endswith(AUDIO_EXT)
    if not f or not name.endswith(VIDEO_EXT + IMAGE_EXT + AUDIO_EXT):
        return jsonify(error="Drop a video, an image, or a song (mp3, wav, m4a…)."), 400
    path = os.path.join(UPLOAD_DIR, os.path.basename(f.filename))
    f.save(path)
    return jsonify(job=start_open(path, music)["id"], music=music)


@app.get("/api/beats/<mid>")
def beats(mid):
    m = S["media"].get(mid)
    if not m or not m.get("audio"):
        return jsonify(error="no audio"), 404
    try:
        return jsonify(beats_for(m))
    except Exception as e:
        log("beat analysis failed", traceback.format_exc())
        return jsonify(error=str(e)), 500


@app.get("/api/media/<mid>/envelope")
def envelope(mid):
    """Per-frame audio features at any frame rate (a song is sampled at the video's fps)."""
    m = S["media"].get(mid)
    if not m or not m.get("audio"):
        abort(404)
    fps = round(float(request.args.get("fps", 30)), 3)
    d = os.path.join(WORK_DIR, mid)
    p = os.path.join(d, f"envelope_{fps}.json")
    if not os.path.exists(p):
        src = os.path.join(d, "music.m4a" if m["kind"] == "audio" else "proxy.mp4")
        env = audio_envelope(src, fps, max(1, int(m["duration"] * fps)))
        with open(p, "w", encoding="utf-8") as f:
            json.dump(env or {}, f)
    return send_file(p, max_age=0)


@app.get("/api/job/<jid>")
def job_status(jid):
    j = S["jobs"].get(jid)
    if not j:
        abort(404)
    return jsonify({k: v for k, v in j.items() if k != "cancel"})


@app.post("/api/job/<jid>/cancel")
def job_cancel(jid):
    j = S["jobs"].get(jid)
    if j:
        j["cancel"] = True
    return jsonify(ok=True)


@app.get("/api/media/<mid>")
def media_info(mid):
    m = S["media"].get(mid)
    if not m:
        abort(404)
    return jsonify(public(m))


@app.get("/api/media/<mid>/<what>")
def media_file(mid, what):
    m = S["media"].get(mid)
    if not m:
        abort(404)
    d = os.path.join(WORK_DIR, mid)
    files = {"video": "proxy.mp4", "packed": "packed.mp4", "image": "image.png", "mask": "mask.png",
             "audio": "audio.json", "music": "music.m4a"}
    if what not in files or not os.path.exists(os.path.join(d, files[what])):
        abort(404)
    return send_file(os.path.join(d, files[what]), conditional=True, max_age=0)


@app.post("/api/mask/<mid>")
def make_mask(mid):
    m = S["media"].get(mid)
    if not m:
        abort(404)
    running = next((j for j in S["jobs"].values()
                    if j["kind"] == "mask" and j["media"] == mid and j["state"] == "running"), None)
    if running:
        return jsonify(job=running["id"])
    job = new_job("mask", mid)

    def work():
        import segment
        try:
            d = os.path.join(WORK_DIR, mid)
            if m["kind"] == "image":
                segment.mask_image(os.path.join(d, "image.png"), os.path.join(d, "mask.png"), job)
            else:
                segment.mask_video(os.path.join(d, "proxy.mp4"), os.path.join(d, "packed.mp4"), m, job,
                                   h264_args("high", gop=10))
            m["has_mask"] = True
            job.update(state="done", progress=1.0, result=public(m))
        except Exception as e:
            if str(e) == "cancelled":
                job.update(state="cancelled")
            else:
                log("mask failed", traceback.format_exc())
                job.update(state="error", message=str(e))
    threading.Thread(target=work, daemon=True).start()
    return jsonify(job=job["id"])


# --------------------------------------------------------------------------- routes: export

def safe_name(s):
    import unicodedata
    s = unicodedata.normalize("NFC", s)  # macOS/Instagram names often arrive decomposed (e + combining accent)
    keep = "".join(c if c.isalnum() or c in " -_" else "_" for c in s).strip()
    return keep[:60] or "acid"


@app.post("/api/export/start")
def export_start():
    b = request.json
    m = S["media"].get(b.get("media"))
    w, h, fps = int(b["width"]), int(b["height"]), float(b["fps"])
    os.makedirs(OUT_DIR, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = os.path.join(OUT_DIR, f"{safe_name(b.get('name', 'acid'))}_{safe_name(b.get('preset', 'custom'))}_{stamp}.mp4")
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", str(fps),
           "-i", "-"]
    dur = int(b.get("frames") or 0) / fps
    cut = ["-t", f"{dur:.3f}"] if dur > 0 else []
    music = S["media"].get(b.get("music") or "")
    if music and b.get("audio", True):
        # the song from the chosen start point, cut to the video length
        cmd += ["-ss", str(float(b.get("music_start") or 0)), *cut,
                "-i", os.path.join(WORK_DIR, music["id"], "music.m4a"),
                "-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "256k"]
    elif m and m["kind"] == "video" and m.get("audio") and b.get("audio", True):
        # the clip's own sound, looped when the export runs longer than the clip
        cmd += ["-stream_loop", "-1", *cut, "-i", os.path.join(WORK_DIR, m["id"], "proxy.mp4"),
                "-map", "0:v", "-map", "1:a?", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-vf", "vflip,format=yuv420p", *h264_args(b.get("quality", "high")), "-pix_fmt", "yuv420p",
            "-movflags", "+faststart", out]
    log("export", " ".join(cmd))
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW)
    err = []
    threading.Thread(target=lambda: err.extend(p.stderr), daemon=True).start()
    eid = uuid.uuid4().hex[:10]
    S["exports"][eid] = {"proc": p, "out": out, "frame_bytes": w * h * 4, "err": err, "n": 0, "last": time.time()}
    return jsonify(id=eid, out=out)


@app.post("/api/export/<eid>/frame")
def export_frame(eid):
    e = S["exports"].get(eid)
    if not e:
        return jsonify(error="export not running"), 404
    data = request.get_data(cache=False)
    if len(data) != e["frame_bytes"]:
        return jsonify(error=f"bad frame size {len(data)}"), 400
    try:
        e["proc"].stdin.write(data)
        e["n"] += 1
        e["last"] = time.time()
    except (BrokenPipeError, OSError):
        return jsonify(error="ffmpeg stopped: " + b"".join(e["err"][-5:]).decode("utf-8", "replace")), 500
    return ("", 204)


@app.post("/api/export/<eid>/finish")
def export_finish(eid):
    e = S["exports"].pop(eid, None)
    if not e:
        abort(404)
    try:
        e["proc"].stdin.close()
    except OSError:
        pass
    rc = e["proc"].wait()
    if rc != 0 or not os.path.exists(e["out"]):
        return jsonify(error="ffmpeg failed: " + b"".join(e["err"][-5:]).decode("utf-8", "replace")), 500
    log("exported", e["out"], e["n"], "frames")
    return jsonify(ok=True, out=e["out"], frames=e["n"])


@app.post("/api/export/<eid>/cancel")
def export_cancel(eid):
    e = S["exports"].pop(eid, None)
    if e:
        e["proc"].kill()
        e["proc"].wait()
        try:
            os.remove(e["out"])
        except OSError:
            pass
    return jsonify(ok=True)


@app.post("/api/still")
def still():
    os.makedirs(OUT_DIR, exist_ok=True)
    name = safe_name(request.args.get("name", "acid"))
    out = os.path.join(OUT_DIR, f"{name}_{time.strftime('%Y%m%d-%H%M%S')}.png")
    with open(out, "wb") as f:
        f.write(request.get_data())
    return jsonify(ok=True, out=out)


@app.post("/api/reveal")
def reveal():
    p = (request.json or {}).get("path")
    if p and os.path.exists(p):
        subprocess.Popen(["explorer", "/select,", os.path.normpath(p)])
    else:
        os.makedirs(OUT_DIR, exist_ok=True)
        os.startfile(OUT_DIR)
    return jsonify(ok=True)


@app.post("/api/open_file")
def open_file():
    p = (request.json or {}).get("path")
    if p and os.path.exists(p) and os.path.normcase(os.path.abspath(p)).startswith(os.path.normcase(OUT_DIR)):
        os.startfile(p)
    return jsonify(ok=True)


# --------------------------------------------------------------------------- routes: user presets

@app.get("/api/presets")
def presets_get():
    try:
        with open(PRESET_FILE, encoding="utf-8") as f:
            return jsonify(json.load(f))
    except (OSError, ValueError):
        return jsonify([])


@app.post("/api/presets")
def presets_put():
    with LOCK, open(PRESET_FILE, "w", encoding="utf-8") as f:
        json.dump(request.json, f, indent=1)
    return jsonify(ok=True)


# --------------------------------------------------------------------------- lifecycle

def watchdog():
    """Quit when the app window is gone (no heartbeat) and nothing is preparing, masking or exporting."""
    while True:
        time.sleep(3)
        now = time.time()
        # an export whose window vanished mid-render would otherwise keep ffmpeg (and this server) alive forever
        for eid, e in list(S["exports"].items()):
            if now - e["last"] > 120:
                log("dropping stalled export", eid)
                S["exports"].pop(eid, None)
                e["proc"].kill()
                try:
                    os.remove(e["out"])
                except OSError:
                    pass
        gone = (S["bye_at"] and now - S["bye_at"] > 8) or now - S["last_ping"] > 180
        if gone and not busy():
            log("window closed, exiting")
            os._exit(0)


def serve():
    threading.Thread(target=prune_cache, daemon=True).start()
    threading.Thread(target=watchdog, daemon=True).start()
    log("serving on", PORT)
    app.run(host="127.0.0.1", port=PORT, threaded=True, use_reloader=False)


if __name__ == "__main__":
    serve()
