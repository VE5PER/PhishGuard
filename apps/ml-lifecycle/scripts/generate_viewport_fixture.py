"""Generate apps/extension/tests/fixtures/viewport_8x8.json.

The fixture pairs a deterministic 8x8 RGBA pixel array with the CHW float32 tensor produced by the
canonical Python conversion, so the extension's `rgbaToChwTensor` can be checked for parity.
"""

import json
from pathlib import Path

import numpy as np

from phishguard_ml_lifecycle.dataset import rgba_to_chw_tensor

SIZE = 8
OUTPUT = Path(__file__).resolve().parents[2] / "extension" / "tests" / "fixtures" / "viewport_8x8.json"


def main() -> None:
    ys, xs = np.mgrid[0:SIZE, 0:SIZE]
    pixels = np.stack(
        [
            (xs * 36 + ys * 3) % 256,
            (ys * 36 + xs * 5) % 256,
            ((xs + ys) * 17 + 40) % 256,
            np.where((xs + ys) % 2 == 0, 255, 128),
        ],
        axis=-1,
    ).astype(np.uint8)

    tensor = rgba_to_chw_tensor(pixels)
    payload = {
        "width": SIZE,
        "height": SIZE,
        "rgba": pixels.reshape(-1).tolist(),
        "expected": tensor.reshape(-1).tolist(),
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(payload), encoding="utf-8")
    print(f"wrote {OUTPUT} ({SIZE}x{SIZE}, expected length {len(payload['expected'])})")


if __name__ == "__main__":
    main()
