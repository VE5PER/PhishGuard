"""Render synthetic reference login cards for the vision brand gallery.

Brand cards use brand colours and wordmark text only (no logo files). The `_generic` folder holds
non-brand login cards that act as a negative class: a screenshot that resembles them as much as a brand
is not treated as a brand look-alike. Official screenshots can be added to the same folders.
"""

import random
from pathlib import Path
from typing import Optional, Tuple

from PIL import Image, ImageDraw, ImageFont

GALLERY_DIR = Path(__file__).resolve().parents[1] / "assets" / "brand_gallery"
CARDS_PER_BRAND = 3
GENERIC_CARDS = 6
SIZE = 224

Color = Tuple[int, int, int]

BRANDS = {
    "google": ("Google", (66, 133, 244), (234, 67, 53), 18),
    "microsoft": ("Microsoft", (0, 164, 239), (242, 80, 34), 44),
    "apple": ("Apple", (30, 30, 30), (120, 120, 120), 32),
    "paypal": ("PayPal", (0, 48, 135), (0, 121, 193), 60),
    "amazon": ("amazon", (255, 153, 0), (35, 47, 62), 26),
    "bankofamerica": ("Bank of America", (227, 24, 55), (0, 42, 102), 40),
}

GENERIC_TITLES = ["Sign in", "Log in", "Welcome back", "Member login", "Account access", "Secure login"]
GENERIC_BACKGROUNDS = [(255, 255, 255), (245, 247, 250), (232, 236, 244), (250, 244, 238), (236, 246, 240), (30, 32, 40)]
GENERIC_BUTTONS = [(0, 112, 186), (34, 139, 84), (20, 20, 20), (111, 66, 193), (0, 112, 186), (34, 139, 84)]


def render_card(
    rng: random.Random,
    background: Color,
    button: Color,
    title: str,
    wordmark: Optional[str] = None,
    wordmark_color: Optional[Color] = None,
    band_height: int = 34,
) -> Image.Image:
    image = Image.new("RGB", (SIZE, SIZE), background)
    draw = ImageDraw.Draw(image)

    width = rng.randint(120, 170)
    height = rng.randint(130, 180)
    x0 = rng.randint(8, SIZE - width - 8)
    y0 = rng.randint(8, SIZE - height - 8)
    x1, y1 = x0 + width, y0 + height
    dark = sum(background) < 200
    card_fill = (44, 46, 56) if dark else (255, 255, 255)
    text_fill = (240, 240, 240) if dark else (30, 30, 30)
    draw.rectangle([(x0, y0), (x1, y1)], fill=card_fill, outline=(120, 120, 130) if dark else (215, 220, 228))

    y = y0 + 10
    if wordmark:
        band_color = wordmark_color or button
        draw.rectangle([(x0, y0), (x1, y0 + band_height)], fill=band_color)
        font = ImageFont.load_default(size=16)
        draw.text((x0 + 12, y0 + max(2, band_height // 2 - 8)), wordmark, fill=(255, 255, 255), font=font)
        y = y0 + band_height + 10
    draw.text((x0 + 12, y), title, fill=text_fill)
    y += 20

    field_fill = (60, 62, 74) if dark else (250, 250, 252)
    field_outline = (110, 112, 124) if dark else (180, 185, 195)
    for _ in range(2):
        draw.rectangle([(x0 + 12, y), (x1 - 12, y + 16)], fill=field_fill, outline=field_outline)
        y += 24

    button_height = rng.randint(16, 24)
    draw.rectangle([(x0 + 12, y + 4), (x1 - 12, y + 4 + button_height)], fill=button)
    return image


def main() -> None:
    for folder, (wordmark, primary, secondary, band_height) in BRANDS.items():
        brand_dir = GALLERY_DIR / folder
        brand_dir.mkdir(parents=True, exist_ok=True)
        for n in range(1, CARDS_PER_BRAND + 1):
            rng = random.Random(sum(map(ord, folder)) * 31 + n)
            background = rng.choice([(255, 255, 255), (245, 247, 250), (236, 240, 247)])
            button = primary if n % 2 else secondary
            image = render_card(
                rng, background, button, "Sign in", wordmark=wordmark, wordmark_color=primary, band_height=band_height
            )
            path = brand_dir / f"synthetic_{n}.png"
            image.save(path, format="PNG", optimize=True)
            print(f"wrote {path.relative_to(GALLERY_DIR.parent)} ({path.stat().st_size} bytes)")

    generic_dir = GALLERY_DIR / "_generic"
    generic_dir.mkdir(parents=True, exist_ok=True)
    for n in range(1, GENERIC_CARDS + 1):
        rng = random.Random(7000 + n)
        image = render_card(
            rng,
            GENERIC_BACKGROUNDS[n - 1],
            GENERIC_BUTTONS[n - 1],
            GENERIC_TITLES[n - 1],
        )
        path = generic_dir / f"synthetic_{n}.png"
        image.save(path, format="PNG", optimize=True)
        print(f"wrote {path.relative_to(GALLERY_DIR.parent)} ({path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
