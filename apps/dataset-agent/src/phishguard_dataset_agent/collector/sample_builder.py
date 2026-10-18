"""Multimodal dataset sample builder adhering to PhishGuard data contracts."""

from datetime import datetime, timezone
import random
from typing import Any, Dict, List, Optional
from uuid import uuid4
import numpy as np

from phishguard_types import (
    MultimodalDatasetSample,
    TargetBrandClass,
    VisualElementType,
    LogoGroundingSpec,
    ImageDetectionAnnotation,
    ElementBoundingBox,
    PointerEventPoint,
    PointerEventType,
    KeystrokeDynamics,
    KeystrokeCategory,
    DOMInteractionEvent,
    DOMInteractionType,
    ViewportCaptureSpec,
)
from phishguard_ml_engine.data.feature_extractor import (
    extract_url_features,
    extract_hid_features,
    extract_logo_features,
    extract_image_detection_features,
    is_official_domain_for_brand,
    BRAND_LIST,
)
from phishguard_ml_engine.data.bezier_synthesizer import generate_synthetic_trajectory
from .models import FetchedPageMetadata
from phishguard_types.dataset import DatasetProvenance


BRAND_MAP: Dict[str, TargetBrandClass] = {
    "microsoft": TargetBrandClass.MICROSOFT,
    "google": TargetBrandClass.GOOGLE,
    "apple": TargetBrandClass.APPLE,
    "paypal": TargetBrandClass.PAYPAL,
    "bank of america": TargetBrandClass.BANK_OF_AMERICA,
    "amazon": TargetBrandClass.AMAZON,
    "facebook": TargetBrandClass.FACEBOOK,
    "netflix": TargetBrandClass.NETFLIX,
    "chase": TargetBrandClass.CHASE,
    "wells fargo": TargetBrandClass.WELLS_FARGO,
    "adobe": TargetBrandClass.ADOBE,
    "yahoo": TargetBrandClass.YAHOO,
    "ebay": TargetBrandClass.EBAY,
    "steam": TargetBrandClass.STEAM,
    "linkedin": TargetBrandClass.LINKEDIN,
    "dhl": TargetBrandClass.DHL,
    "dropbox": TargetBrandClass.DROPBOX,
    "docusign": TargetBrandClass.DOCUSIGN,
    "coinbase": TargetBrandClass.COINBASE,
    "whatsapp": TargetBrandClass.WHATSAPP,
}


class DatasetSampleBuilder:
    """Builds valid MultimodalDatasetSample instances from web search findings."""

    def __init__(self, seed: Optional[int] = None):
        self._rng = random.Random(seed)

    def _resolve_brand_enum(self, brand_name: Optional[str]) -> TargetBrandClass:
        if not brand_name:
            return TargetBrandClass.GENERIC_BENIGN
        clean = brand_name.strip().lower()
        return BRAND_MAP.get(clean, TargetBrandClass.GENERIC_BENIGN)

    def _synthesize_keystrokes(self, label: float) -> List[KeystrokeDynamics]:
        """Synthesize privacy-preserving keystroke timings.

        STRICT GDPR / PCI-DSS CONSTRAINT: Zero raw character logging.
        Only flight and dwell times with generalized categories.
        """
        keystrokes: List[KeystrokeDynamics] = []
        n_keys = self._rng.randint(8, 20)
        # Phishing victims often exhibit slight hesitation (longer flight times)
        base_flight = 135.0
        base_dwell = 85.0

        current_time = 50.0
        for idx in range(n_keys):
            category = KeystrokeCategory.ALPHANUMERIC
            if idx > 3 and self._rng.random() < 0.15:
                category = KeystrokeCategory.BACKSPACE

            flight = max(10.0, self._rng.gauss(base_flight, 35.0))
            dwell = max(15.0, self._rng.gauss(base_dwell, 20.0))
            current_time += flight + dwell

            keystrokes.append(
                KeystrokeDynamics(
                    flightTimeMs=flight,
                    dwellTimeMs=dwell,
                    category=category,
                    timestamp=round(current_time, 2),
                )
            )
        return keystrokes

    def _synthesize_dom_events(self, has_login: bool) -> List[DOMInteractionEvent]:
        """Synthesize DOM interaction events (form inputs, clicks, focus)."""
        events: List[DOMInteractionEvent] = [
            DOMInteractionEvent(
                eventType=DOMInteractionType.FOCUS,
                targetBoundingBox=ElementBoundingBox(x=0.0, y=0.0, width=1280.0, height=720.0),
                isZeroOpacity=False,
                isCrossOriginIframe=False,
                isPasswordInput=False,
                isPasteIntoPassword=False,
                elementSelector="body",
                timestamp=100.0,
            )
        ]
        if has_login:
            events.append(
                DOMInteractionEvent(
                    eventType=DOMInteractionType.FOCUS,
                    targetBoundingBox=ElementBoundingBox(x=100.0, y=200.0, width=300.0, height=40.0),
                    isZeroOpacity=False,
                    isCrossOriginIframe=False,
                    isPasswordInput=True,
                    isPasteIntoPassword=False,
                    elementSelector="form#login > input[type='password']",
                    timestamp=350.0,
                )
            )
            events.append(
                DOMInteractionEvent(
                    eventType=DOMInteractionType.CLICK,
                    targetBoundingBox=ElementBoundingBox(x=100.0, y=260.0, width=120.0, height=45.0),
                    isZeroOpacity=False,
                    isCrossOriginIframe=False,
                    isPasswordInput=False,
                    isPasteIntoPassword=False,
                    elementSelector="form#login > button[type='submit']",
                    timestamp=1200.0,
                )
            )
        return events

    def _build_logo_detections(
        self,
        target_brand_enum: TargetBrandClass,
        domain: str,
        label: float,
    ) -> List[LogoGroundingSpec]:
        """Build logo detection grounding annotations."""
        if target_brand_enum == TargetBrandClass.GENERIC_BENIGN or target_brand_enum == TargetBrandClass.NONE:
            return []

        brand_name_str = target_brand_enum.value
        try:
            brand_id = BRAND_LIST.index(brand_name_str)
        except ValueError:
            brand_id = 0

        matches_brand = is_official_domain_for_brand(domain, brand_name_str)
        # If label is phishing, the logo often does NOT match the domain
        if label >= 0.5:
            matches_brand = False

        return [
            LogoGroundingSpec(
                brandName=target_brand_enum,
                brandId=brand_id,
                boundingBox=ElementBoundingBox(x=40.0, y=30.0, width=150.0, height=50.0),
                confidence=0.96,
                domainMatchesBrand=matches_brand,
            )
        ]

    def _build_image_detections(self, has_login: bool) -> List[ImageDetectionAnnotation]:
        """Build visual UI bounding box detections."""
        detections: List[ImageDetectionAnnotation] = [
            ImageDetectionAnnotation(
                category=VisualElementType.LOGO,
                boundingBox=ElementBoundingBox(x=40.0, y=30.0, width=150.0, height=50.0),
                confidence=0.95,
            )
        ]
        if has_login:
            detections.append(
                ImageDetectionAnnotation(
                    category=VisualElementType.INPUT_CREDENTIAL,
                    boundingBox=ElementBoundingBox(x=100.0, y=200.0, width=300.0, height=40.0),
                    confidence=0.92,
                )
            )
            detections.append(
                ImageDetectionAnnotation(
                    category=VisualElementType.BUTTON_SUBMIT,
                    boundingBox=ElementBoundingBox(x=100.0, y=260.0, width=120.0, height=45.0),
                    confidence=0.94,
                )
            )
        return detections

    def build_sample(
        self,
        meta: FetchedPageMetadata,
        label: float,
        target_brand_name: Optional[str] = None,
        seq_length: int = 64,
        provenance: Optional[DatasetProvenance] = None,
        target_brand_enum: Optional[TargetBrandClass] = None,
    ) -> MultimodalDatasetSample:
        if target_brand_enum is None:
            target_brand_enum = self._resolve_brand_enum(target_brand_name)
        raw_points = generate_synthetic_trajectory(is_phishing=False, num_steps=seq_length)
        event_type_map = {
            "move": PointerEventType.MOVE,
            "down": PointerEventType.DOWN,
            "up": PointerEventType.UP,
        }
        pointer_series: List[PointerEventPoint] = [
            PointerEventPoint(
                x=float(p["x"]),
                y=float(p["y"]),
                dx=float(p["dx"]),
                dy=float(p["dy"]),
                velocity=max(0.0, float(p["velocity"])),
                acceleration=float(p["acceleration"]),
                angle=float(p["angle"]),
                timestamp=max(0.0, float(p["timestamp"])),
                eventType=event_type_map.get(str(p.get("eventType", "move")), PointerEventType.MOVE),
            )
            for p in raw_points
        ]
        keystrokes = self._synthesize_keystrokes(label=label)
        dom_events = self._synthesize_dom_events(has_login=meta.has_login_form)
        logo_detections: List[LogoGroundingSpec] = []
        image_detections: List[ImageDetectionAnnotation] = []

        # Feature extractions for fast vector indexing
        pointer_dicts = [p.model_dump() for p in pointer_series]
        keystroke_dicts = [k.model_dump() for k in keystrokes]
        dom_dicts = [d.model_dump() for d in dom_events]
        logo_dicts = [l.model_dump() for l in logo_detections]
        image_dicts = [i.model_dump() for i in image_detections]

        url_feats = extract_url_features(meta.final_url, meta.domain).tolist()
        hid_feats = extract_hid_features(pointer_dicts, keystroke_dicts, dom_dicts).tolist()
        logo_feats = extract_logo_features(logo_dicts, meta.domain).tolist()
        detection_feats = extract_image_detection_features(image_dicts, dom_dicts).tolist()

        sample_id = uuid4()

        return MultimodalDatasetSample(
            sampleId=sample_id,
            label=float(label),
            url=meta.final_url,
            domain=meta.domain,
            targetBrand=target_brand_enum,
            pointerSeries=pointer_series,
            keystrokes=keystrokes,
            domEvents=dom_events,
            viewportCapture=None,
            logoDetections=logo_detections,
            imageDetections=image_detections,
            extractedFeatures={
                "url": url_feats,
                "hid": hid_feats,
                "logo": logo_feats,
                "detection": detection_feats,
            },
            createdAt=datetime.now(timezone.utc),
            provenance=provenance or DatasetProvenance(
                sourceType="synthetic", labelSource="unknown", labelConfidence=0,
                labelReason="Synthetic behavior; no independent training label",
                groupId=meta.domain,
                modalities={"url": "observed", "hid": "synthetic", "dom": "synthetic",
                            "visual": "missing", "logo": "missing"},
            ),
        )

    def to_storage_dict(
        self,
        sample: MultimodalDatasetSample,
    ) -> Dict[str, Any]:
        """Convert sample to format consumable by store_multimodal_dataset."""
        return {
            "sampleId": str(sample.sampleId),
            "label": sample.label,
            "url": sample.url,
            "domain": sample.domain,
            "targetBrand": sample.targetBrand.value if sample.targetBrand else None,
            "pointerSeries": [p.model_dump() for p in sample.pointerSeries],
            "keystrokes": [k.model_dump() for k in sample.keystrokes],
            "domEvents": [d.model_dump() for d in sample.domEvents],
            "logoDetections": [l.model_dump() for l in sample.logoDetections],
            "imageDetections": [i.model_dump() for i in sample.imageDetections],
            "extractedFeatures": sample.extractedFeatures or {},
            "createdAt": sample.createdAt.isoformat(),
            "provenance": sample.provenance.model_dump(mode="json") if sample.provenance else None,
        }
