"""Subject cutout on the GPU (transparent-background / InSPyReNet, rembg isnet fallback).

Videos get a *packed* file: [color | mask] side by side in one H.264 stream, so the browser plays a single
<video> and the mask can never drift out of sync with the picture, in preview or in a frame-exact export.
"""
import os
import subprocess
import threading
import time

import numpy as np

NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
_MODEL = {"remover": None, "rembg": None, "lock": threading.Lock(), "norm": None}
# InSPyReNet input size. 768 + TF32 runs ~2.4x faster than the stock 1024 path on an RTX 4070 SUPER with a
# visually identical matte (fp16 overflows to NaN in this model, so it stays fp32).
NET_SIZE = 768


def log(*a):
    print(time.strftime("%H:%M:%S"), "[segment]", *a, flush=True)


def _remover():
    with _MODEL["lock"]:
        if _MODEL["remover"] is None and _MODEL["rembg"] is None:
            try:
                import torch
                from transparent_background import Remover
                torch.backends.cuda.matmul.allow_tf32 = True
                torch.backends.cudnn.allow_tf32 = True
                torch.backends.cudnn.benchmark = True
                dev = "cuda:0" if torch.cuda.is_available() else "cpu"
                _MODEL["remover"] = Remover(mode="base", device=dev)
                _MODEL["norm"] = (torch.tensor([0.485, 0.456, 0.406], device=dev).view(1, 3, 1, 1),
                                  torch.tensor([0.229, 0.224, 0.225], device=dev).view(1, 3, 1, 1), dev)
                log("transparent-background ready on", dev)
            except Exception as e:  # missing ckpt / no torch: fall back to rembg
                log("transparent-background unavailable:", e)
                from rembg import new_session
                _MODEL["rembg"] = new_session("isnet-general-use")
                log("rembg isnet ready")
    return _MODEL


def predict(rgb):
    """rgb: HxWx3 uint8 -> HxW float32 mask 0..1."""
    m = _remover()
    if m["remover"] is not None:
        import torch
        import torch.nn.functional as F
        mean, std, dev = m["norm"]
        h, w = rgb.shape[:2]
        with torch.no_grad():
            x = torch.from_numpy(np.ascontiguousarray(rgb)).to(dev).permute(2, 0, 1)[None].float() / 255
            x = (F.interpolate(x, (NET_SIZE, NET_SIZE), mode="bilinear", align_corners=False) - mean) / std
            p = m["remover"].model(x)
            p = F.interpolate(p, (h, w), mode="bilinear", align_corners=True)
            return p.squeeze().clamp(0, 1).cpu().numpy().astype(np.float32)
    from rembg import remove
    out = remove(rgb, session=m["rembg"], only_mask=True)
    return np.asarray(out, dtype=np.float32) / 255.0


def mask_image(src, dst, job):
    from PIL import Image
    job["message"] = "Loading cutout model"
    rgb = np.asarray(Image.open(src).convert("RGB"))
    job["message"] = "Cutting out the subject"
    m = predict(rgb)
    Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8)).save(dst)


def mask_video(proxy, dst, media, job, venc_args):
    w, h, fps, frames = media["width"], media["height"], media["fps"], media["frames"]
    job["message"] = "Loading cutout model"
    _remover()
    job["message"] = "Cutting out the subject"
    tmp = dst + ".part.mp4"
    dec = subprocess.Popen(["ffmpeg", "-v", "error", "-i", proxy, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                           stdout=subprocess.PIPE, creationflags=NO_WINDOW)
    enc = subprocess.Popen(["ffmpeg", "-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                            "-s", f"{w * 2}x{h}", "-r", str(fps), "-i", "-", "-i", proxy,
                            "-map", "0:v", "-map", "1:a?", "-c:a", "copy", *venc_args, "-pix_fmt", "yuv420p",
                            "-movflags", "+faststart", tmp],
                           stdin=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=NO_WINDOW)
    err = []
    threading.Thread(target=lambda: err.extend(enc.stderr), daemon=True).start()
    size = w * h * 3
    prev = None
    i = 0
    t0 = time.time()
    try:
        while True:
            if job.get("cancel"):
                raise RuntimeError("cancelled")
            buf = dec.stdout.read(size)
            if len(buf) < size:
                break
            rgb = np.frombuffer(buf, np.uint8).reshape(h, w, 3)
            m = predict(rgb)
            # light temporal smoothing: kills edge shimmer without visible ghosting
            if prev is not None:
                m = m * 0.75 + prev * 0.25
            prev = m
            m8 = (np.clip(m, 0, 1) * 255).astype(np.uint8)
            packed = np.concatenate([rgb, np.repeat(m8[..., None], 3, axis=2)], axis=1)
            enc.stdin.write(packed.tobytes())
            i += 1
            job["progress"] = min(0.99, i / max(frames, 1))
            el = time.time() - t0
            job["message"] = f"Cutting out the subject · {i}/{frames} · {i / max(el, 1e-3):.1f} fps"
        enc.stdin.close()
        if enc.wait() != 0:
            raise RuntimeError("ffmpeg failed: " + b"".join(err[-5:]).decode("utf-8", "replace"))
        os.replace(tmp, dst)
        log("mask done", dst, i, "frames in", round(time.time() - t0, 1), "s")
    finally:
        for p in (dec, enc):
            if p.poll() is None:
                p.kill()
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
