"""Draws the Acid Lab icon: a neon eyeball on a warped checker tile, RGB-split, glitch-sliced and melting.

Writes assets/acidlab.ico (16-256 px) and assets/acidlab.png (512 px). Run: python tools/make_icon.py
"""
import os

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

S = 1024
HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(os.path.dirname(HERE), "assets")


def rounded_mask(size, r):
    m = Image.new("L", (size, size), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=255)
    return m


def background():
    y, x = np.mgrid[0:S, 0:S].astype(np.float32) / S
    # warped checker, magenta on deep violet (the "Neon Specimen" backdrop)
    wx = x + 0.035 * np.sin(y * 18 + 1.3) + 0.02 * np.sin(x * 31)
    wy = y + 0.035 * np.sin(x * 16 + 0.4)
    chk = ((np.floor(wx * 9) + np.floor(wy * 9)) % 2).astype(np.float32)
    base = np.stack([0.07 + 0.05 * y, 0.02 + 0.0 * y, 0.13 + 0.05 * (1 - y)], -1)
    pink = np.array([0.55, 0.05, 0.48], np.float32)
    img = base * (1 - chk[..., None] * 0.55) + pink * chk[..., None] * 0.55
    # vignette
    d = np.sqrt((x - 0.5) ** 2 + (y - 0.48) ** 2)
    img *= np.clip(1.25 - d * 1.5, 0.25, 1)[..., None]
    return Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8), "RGB")


def eye_layer():
    """RGBA eyeball with neon halo and drips."""
    cx, cy, R = S * 0.5, S * 0.45, S * 0.255
    y, x = np.mgrid[0:S, 0:S].astype(np.float32)
    dx, dy = x - cx, y - cy
    r = np.sqrt(dx * dx + dy * dy)
    ang = np.arctan2(dy, dx)

    rgba = np.zeros((S, S, 4), np.float32)

    # drips: rounded columns hanging off the bottom of the eye
    drip = Image.new("L", (S, S), 0)
    dd = ImageDraw.Draw(drip)
    for ox, length, w in ((-0.15, 0.30, 0.055), (-0.035, 0.40, 0.07), (0.09, 0.24, 0.05), (0.175, 0.15, 0.04)):
        x0 = cx + ox * S
        top = cy + R * 0.55
        bot = cy + R * 0.6 + length * S
        dd.rounded_rectangle([x0 - w * S / 2, top, x0 + w * S / 2, bot], radius=int(w * S / 2), fill=255)
        dd.ellipse([x0 - w * S * 0.62, bot - w * S * 1.1, x0 + w * S * 0.62, bot + w * S * 0.15], fill=255)
    drip_a = np.asarray(drip, np.float32) / 255

    sclera = np.clip((R - r) / 2.5, 0, 1)
    body = np.maximum(sclera, drip_a)

    # neon halo around the eye + drips: red glow fill, yellow outer line
    body_img = Image.fromarray((body * 255).astype(np.uint8))
    near = np.asarray(body_img.filter(ImageFilter.MaxFilter(61)).filter(ImageFilter.GaussianBlur(8)), np.float32) / 255
    far = np.asarray(body_img.filter(ImageFilter.MaxFilter(89)).filter(ImageFilter.GaussianBlur(3)), np.float32) / 255
    line = np.clip(far * 1.6, 0, 1) * (1 - np.clip(near * 1.8, 0, 1))
    glow = np.asarray(body_img.filter(ImageFilter.GaussianBlur(60)), np.float32) / 255

    red = np.array([1.0, 0.06, 0.18])
    yellow = np.array([0.96, 1.0, 0.0])
    rgba[..., :3] += red * np.clip(near, 0, 1)[..., None]
    rgba[..., 3] = np.maximum(rgba[..., 3], np.clip(near, 0, 1))
    rgba[..., :3] = rgba[..., :3] * (1 - line[..., None]) + yellow * line[..., None]
    rgba[..., 3] = np.maximum(rgba[..., 3], line)
    rgba[..., :3] += np.array([1.0, 0.1, 0.6]) * glow[..., None] * 0.35
    rgba[..., 3] = np.maximum(rgba[..., 3], glow * 0.5)

    # sclera + drips: white with a slight pink shade toward the edge, drips tinted
    shade = np.clip(r / R, 0, 1) ** 3
    white = np.stack([1 - 0.05 * shade, 0.95 - 0.25 * shade, 0.97 - 0.12 * shade], -1)
    drip_col = np.stack([0.98 + 0 * y, 0.88 + 0.1 * np.sin(y / S * 20), 0.95 + 0 * y], -1)
    col = np.where(sclera[..., None] > 0, white, drip_col)
    rgba[..., :3] = rgba[..., :3] * (1 - body[..., None]) + col * body[..., None]
    rgba[..., 3] = np.maximum(rgba[..., 3], body)

    # rainbow iris with radial striations, black pupil, highlight
    Ri = R * 0.62
    iris = np.clip((Ri - r) / 2.0, 0, 1)
    hue = (ang / (2 * np.pi) + 0.5 + r / Ri * 0.25) % 1
    stri = 0.75 + 0.25 * np.sin(ang * 46 + r * 0.08)
    rainbow = 0.5 + 0.5 * np.cos(2 * np.pi * (hue[..., None] + np.array([0.0, 0.33, 0.67])))
    rainbow = np.clip(rainbow * 1.15, 0, 1) * stri[..., None]
    ring = np.clip(1 - np.abs(r - Ri * 0.97) / (Ri * 0.06), 0, 1)
    rainbow *= (1 - 0.7 * ring)[..., None]
    rgba[..., :3] = rgba[..., :3] * (1 - iris[..., None]) + rainbow * iris[..., None]
    pupil = np.clip((Ri * 0.42 - r) / 2.0, 0, 1)
    rgba[..., :3] *= (1 - pupil[..., None])
    hl = np.clip((S * 0.033 - np.sqrt((x - cx + Ri * 0.38) ** 2 + (y - cy + Ri * 0.38) ** 2)) / 2.0, 0, 1)
    rgba[..., :3] = rgba[..., :3] * (1 - hl[..., None]) + hl[..., None]
    return Image.fromarray((np.clip(rgba, 0, 1) * 255).astype(np.uint8), "RGBA")


def glitch(img):
    """RGB split + displaced horizontal slices."""
    r, g, b, a = img.split()
    off = int(S * 0.018)
    r = ImageChops.offset(r, -off, 0)
    b = ImageChops.offset(b, off, int(off * 0.3))
    a = ImageChops.lighter(a, ImageChops.lighter(ImageChops.offset(a, -off, 0), ImageChops.offset(a, off, int(off * 0.3))))
    out = Image.merge("RGBA", (r, g, b, a))
    for y0, hgt, dx in ((0.30, 0.035, 0.05), (0.47, 0.022, -0.07), (0.555, 0.05, 0.035), (0.71, 0.018, -0.04)):
        box = (0, int(y0 * S), S, int((y0 + hgt) * S))
        band = out.crop(box)
        out.paste((0, 0, 0, 0), box)
        out.paste(band, (int(dx * S), box[1]), band)
    return out


def scanlines(img):
    arr = np.asarray(img).astype(np.float32)
    arr[::8, :, :3] *= 0.8
    return Image.fromarray(arr.astype(np.uint8), img.mode)


def main():
    os.makedirs(ASSETS, exist_ok=True)
    bg = background().convert("RGBA")
    eye = glitch(eye_layer())
    tile = Image.alpha_composite(bg, eye)
    tile = scanlines(tile)
    # thin neon rim
    rim = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(rim).rounded_rectangle([6, 6, S - 7, S - 7], radius=int(S * 0.2), outline=(198, 255, 0, 200), width=10)
    tile = Image.alpha_composite(tile, rim)
    tile.putalpha(ImageChops.multiply(tile.getchannel("A"), rounded_mask(S, int(S * 0.21))))

    png = tile.resize((512, 512), Image.LANCZOS)
    png.save(os.path.join(ASSETS, "acidlab.png"))
    sizes = [256, 128, 64, 48, 32, 24, 16]
    frames = []
    for s in sizes:
        im = tile.resize((s, s), Image.LANCZOS)
        if s <= 32:  # small sizes: sharpen so the eye still reads
            im = im.filter(ImageFilter.UnsharpMask(radius=1, percent=120, threshold=0))
        frames.append(im)
    frames[0].save(os.path.join(ASSETS, "acidlab.ico"), format="ICO", sizes=[(s, s) for s in sizes], append_images=frames[1:])
    print("wrote", os.path.join(ASSETS, "acidlab.ico"))


if __name__ == "__main__":
    main()
