"""Generate PhishGuard extension PNG icons in multiple resolutions using Python stdlib."""
import struct
import zlib
from pathlib import Path

def create_png(width: int, height: int, rgba_bytes: bytes) -> bytes:
    """Builds a valid PNG byte stream without third-party dependencies."""
    def chunk(tag: bytes, data: bytes) -> bytes:
        length = struct.pack('>I', len(data))
        crc = struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)
        return length + tag + data + crc

    # Scanlines with filter byte 0 (None)
    raw = b''.join(b'\x00' + rgba_bytes[y * width * 4 : (y + 1) * width * 4] for y in range(height))
    return (
        b'\x89PNG\r\n\x1a\n'
        + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))
        + chunk(b'IDAT', zlib.compress(raw))
        + chunk(b'IEND', b'')
    )

def render_shield_icon(size: int) -> bytes:
    """Renders a high-tech emerald cyber shield icon onto an RGBA pixel buffer."""
    buf = bytearray(size * size * 4)
    cx, cy = size / 2.0, size / 2.0
    r = size * 0.45

    for y in range(size):
        for x in range(size):
            idx = (y * size + x) * 4
            # Normalized coordinates [-1, 1]
            nx = (x - cx) / (size * 0.48)
            ny = (y - cy) / (size * 0.48)

            # Shield geometry formula: top flat with rounded corners, tapering down to a point
            # ny from -0.8 to 0.9. Width profile narrows as ny goes from 0 to 0.9.
            in_shield = False
            if -0.85 <= ny <= 0.85:
                if ny < 0:
                    max_w = 0.85
                else:
                    max_w = 0.85 * (1.0 - (ny / 0.9) ** 1.3)
                if abs(nx) <= max_w:
                    in_shield = True

            if in_shield:
                # Shield border vs inner
                border_dist = min(
                    abs(nx) - (0.85 if ny < 0 else 0.85 * (1.0 - (ny / 0.9) ** 1.3)),
                    ny - 0.85,
                    -0.85 - ny
                )
                is_border = abs(border_dist) < 0.18

                # Inner emblem: Lightning bolt / checkmark
                # Coordinates for lightning slash
                is_emblem = False
                if (-0.4 <= ny <= 0.4) and (abs(nx + ny * 0.4) < 0.16):
                    is_emblem = True
                elif (0.0 <= ny <= 0.45) and (abs(nx - ny * 0.5 + 0.1) < 0.14):
                    is_emblem = True

                if is_emblem:
                    # Luminescent Mint White
                    buf[idx] = 236
                    buf[idx + 1] = 253
                    buf[idx + 2] = 245
                    buf[idx + 3] = 255
                elif is_border:
                    # Cyber Emerald Border
                    buf[idx] = 16
                    buf[idx + 1] = 185
                    buf[idx + 2] = 129
                    buf[idx + 3] = 255
                else:
                    # Deep Obsidian Emerald fill
                    buf[idx] = 6
                    buf[idx + 1] = 78
                    buf[idx + 2] = 59
                    buf[idx + 3] = 240
            else:
                # Transparent outside shield
                buf[idx] = 0
                buf[idx + 1] = 0
                buf[idx + 2] = 0
                buf[idx + 3] = 0

    return create_png(size, size, bytes(buf))

def main():
    icons_dir = Path("apps/extension/public/icons")
    icons_dir.mkdir(parents=True, exist_ok=True)

    for size in (16, 48, 128):
        png_data = render_shield_icon(size)
        out_file = icons_dir / f"icon{size}.png"
        out_file.write_bytes(png_data)
        print(f"Generated {out_file} ({len(png_data)} bytes)")

if __name__ == "__main__":
    main()
