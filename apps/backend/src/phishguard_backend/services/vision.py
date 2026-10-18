"""Visual brand matching for consented screenshots (MobileNetV3-Small embeddings + brand gallery)."""

import base64
import binascii
import io
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np
from PIL import Image

MAX_DATA_URL_CHARS = 2_100_000
MAX_IMAGE_DIMENSION = 2048
INPUT_SIZE = 224
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32).reshape(3, 1, 1)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32).reshape(3, 1, 1)
GENERIC_FOLDER = "_generic"
GALLERY_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
DEFAULT_GALLERY_DIR = Path(__file__).resolve().parents[3] / "assets" / "brand_gallery"

_DATA_URL = re.compile(r"^data:image/(webp|jpeg);base64,([A-Za-z0-9+/=]+)$")

Embedder = Callable[[np.ndarray], np.ndarray]


class InvalidScreenshotError(ValueError):
    """Raised when a screenshot data URL is malformed or exceeds the accepted limits."""


@dataclass(frozen=True)
class VisionMatch:
    brand: str
    similarity: float
    runner_up_similarity: float = 0.0
    generic_similarity: float = 0.0


def _l2_normalize(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=-1, keepdims=True)
    return vectors / np.maximum(norms, 1e-12)


def preprocess_image(image: Image.Image) -> np.ndarray:
    """RGB, resize to 224x224, scale to [0, 1] and normalize with ImageNet statistics; returns (3, 224, 224)."""
    rgb = image.convert("RGB").resize((INPUT_SIZE, INPUT_SIZE), Image.BILINEAR)
    arr = np.asarray(rgb, dtype=np.float32) / 255.0
    chw = np.transpose(arr, (2, 0, 1))
    return ((chw - IMAGENET_MEAN) / IMAGENET_STD).astype(np.float32)


def decode_data_url(data_url: str) -> Image.Image:
    """Decode a screenshot data URL into a PIL image, enforcing the size limits the schema advertises."""
    if len(data_url) > MAX_DATA_URL_CHARS:
        raise InvalidScreenshotError("Screenshot exceeds the maximum accepted size")
    match = _DATA_URL.match(data_url)
    if not match:
        raise InvalidScreenshotError("Screenshot must be a base64 webp or jpeg data URL")
    try:
        raw = base64.b64decode(match.group(2), validate=True)
        image = Image.open(io.BytesIO(raw))
        width, height = image.size
        if width > MAX_IMAGE_DIMENSION or height > MAX_IMAGE_DIMENSION:
            raise InvalidScreenshotError("Screenshot dimensions exceed the accepted limit")
        image.load()
    except InvalidScreenshotError:
        raise
    except (binascii.Error, OSError, ValueError) as exc:
        raise InvalidScreenshotError("Screenshot could not be decoded") from exc
    return image


class MobileNetV3Embedder:
    """MobileNetV3-Small (ImageNet weights) feature extractor producing 576-d embeddings."""

    def __init__(self) -> None:
        self._model = None
        self._lock = threading.Lock()

    def _load(self):
        import torch
        from torchvision.models import MobileNet_V3_Small_Weights, mobilenet_v3_small

        model = mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.IMAGENET1K_V1)
        model.classifier = torch.nn.Identity()
        model.eval()
        return model

    def __call__(self, batch: np.ndarray) -> np.ndarray:
        import torch

        with self._lock:
            if self._model is None:
                self._model = self._load()
        with torch.no_grad():
            torch.set_num_threads(1)
            return self._model(torch.from_numpy(batch)).numpy()


class VisionAnalyzer:
    """Embeds screenshots and matches them against a gallery of reference brand login pages."""

    def __init__(self, gallery_dir: Optional[Path] = None, embedder: Optional[Embedder] = None) -> None:
        self.gallery_dir = Path(gallery_dir) if gallery_dir is not None else DEFAULT_GALLERY_DIR
        self._embedder: Embedder = embedder or MobileNetV3Embedder()
        self._gallery: Optional[Dict[str, np.ndarray]] = None
        self._lock = threading.Lock()

    def embed_image(self, image: Image.Image) -> np.ndarray:
        return _l2_normalize(self._embedder(preprocess_image(image)[None, ...]))[0]

    def embed(self, data_url: str) -> np.ndarray:
        return self.embed_image(decode_data_url(data_url))

    def _load_gallery(self) -> Dict[str, np.ndarray]:
        gallery: Dict[str, np.ndarray] = {}
        if not self.gallery_dir.is_dir():
            return gallery
        for brand_dir in sorted(p for p in self.gallery_dir.iterdir() if p.is_dir()):
            embeddings: List[np.ndarray] = []
            for path in sorted(brand_dir.iterdir()):
                if path.suffix.lower() not in GALLERY_EXTENSIONS:
                    continue
                with Image.open(path) as image:
                    embeddings.append(self.embed_image(image))
            if embeddings:
                gallery[brand_dir.name.lower()] = np.stack(embeddings)
        return gallery

    @property
    def gallery(self) -> Dict[str, np.ndarray]:
        with self._lock:
            if self._gallery is None:
                self._gallery = self._load_gallery()
            return self._gallery

    def match(self, data_url: str) -> Optional[VisionMatch]:
        """Return the closest brand (top-1 by cosine similarity) with the runner-up and generic-login similarities.

        The `_generic` folder is a negative class: it is excluded from the brand ranking and reported as
        `generic_similarity` (0.0 when absent). Returns None when the gallery has no brands.
        """
        gallery = self.gallery
        brands = {brand: vectors for brand, vectors in gallery.items() if brand != GENERIC_FOLDER}
        if not brands:
            return None
        query = self.embed(data_url)
        ranked = sorted(((float(np.max(vectors @ query)), brand) for brand, vectors in brands.items()), reverse=True)
        generic_vectors = gallery.get(GENERIC_FOLDER)
        generic_similarity = float(np.max(generic_vectors @ query)) if generic_vectors is not None else 0.0
        return VisionMatch(
            brand=ranked[0][1],
            similarity=ranked[0][0],
            runner_up_similarity=ranked[1][0] if len(ranked) > 1 else 0.0,
            generic_similarity=generic_similarity,
        )


vision_analyzer = VisionAnalyzer()
