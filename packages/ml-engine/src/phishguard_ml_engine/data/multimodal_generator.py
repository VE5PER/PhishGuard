"""Multimodal Dataset Generator & Synthesizer for PhishGuard.

Generates industry-grade synthetic benchmark datasets combining:
1. URL: Authentic domains vs typosquatted, subdomain-spoofed, IP-based phishing URLs
2. HID: Human Bézier mouse kinematics, bot linearity, GDPR-safe keystroke dynamics
3. Logo: Brand grounding, bounding boxes, and brand-domain mismatch flags
4. Screen: Viewport screenshots rendered via Pillow with login cards and content
5. Image Detection: UI element annotations for credential inputs, submit buttons, badges
"""

from __future__ import annotations

from datetime import datetime, timezone
import math
import random
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4
import numpy as np
try:
    from PIL import Image, ImageDraw
except ImportError:
    Image = None  # type: ignore[assignment]
    ImageDraw = None  # type: ignore[assignment]

from .bezier_synthesizer import synthesize_human_trajectory_curve
from .feature_extractor import (
    extract_url_features,
    extract_hid_features,
    extract_logo_features,
    extract_image_detection_features,
    is_official_domain_for_brand,
    BRAND_LIST,
    BRAND_LEGITIMATE_DOMAINS,
    SUSPICIOUS_TLDS,
)

# Legitimate websites and sample paths
BENIGN_DOMAINS_AND_PATHS = [
    ("en.wikipedia.org", "/wiki/Computer_security"),
    ("en.wikipedia.org", "/wiki/Machine_learning"),
    ("github.com", "/torvalds/linux"),
    ("github.com", "/features/actions"),
    ("stackoverflow.com", "/questions/12345/how-to-train-neural-network"),
    ("developer.mozilla.org", "/en-US/docs/Web/API/Element"),
    ("nytimes.com", "/section/technology"),
    ("bbc.com", "/news/world"),
    ("reddit.com", "/r/programming"),
    ("arxiv.org", "/abs/2105.12345"),
    ("docs.python.org", "/3/library/math.html"),
    ("cloudflare.com", "/learning/security/what-is-phishing"),
]

# Brand color palettes for realistic synthetic rendering
BRAND_COLORS = {
    "microsoft": ((0, 164, 239), (255, 185, 0), (242, 80, 34), (127, 186, 0)),
    "google": ((66, 133, 244), (234, 67, 53), (251, 188, 5), (52, 168, 83)),
    "apple": ((30, 30, 30), (120, 120, 120)),
    "paypal": ((0, 48, 135), (0, 121, 193)),
    "bank of america": ((227, 24, 55), (0, 42, 102)),
    "amazon": ((255, 153, 0), (35, 47, 62)),
    "facebook": ((24, 119, 242), (255, 255, 255)),
    "netflix": ((229, 9, 20), (20, 20, 20)),
    "chase": ((17, 126, 219), (0, 51, 160)),
    "wells fargo": ((215, 25, 32), (255, 210, 0)),
}


def _render_synthetic_viewport(
    is_phishing: bool,
    brand_name: Optional[str] = None,
    image_detections: Optional[List[Dict[str, Any]]] = None,
    logo_detections: Optional[List[Dict[str, Any]]] = None,
    target_size: Tuple[int, int] = (224, 224),
) -> Image.Image:
    """Render a realistic 224x224 RGB synthetic viewport image using Pillow."""
    if Image is None or ImageDraw is None:
        raise RuntimeError("Pillow is required for rendering synthetic viewports. Install with: pip install pillow")
    width, height = target_size
    img = Image.new("RGB", (width, height), color=(245, 247, 250))
    draw = ImageDraw.Draw(img)

    if not is_phishing:
        # Render a clean, realistic benign content/article page
        # Header bar
        header_color = (random.randint(40, 70), random.randint(70, 100), random.randint(120, 180))
        draw.rectangle([(0, 0), (width, 28)], fill=header_color)

        # Header nav links (small rectangles)
        for x in [30, 60, 90, 120]:
            draw.rectangle([(x, 10), (x + 20, 18)], fill=(255, 255, 255))

        # Main content area
        draw.rectangle([(16, 40), (160, 55)], fill=(50, 50, 60))  # Article title

        # Paragraph text lines
        y = 65
        for _ in range(6):
            line_w = random.randint(120, 190)
            draw.rectangle([(16, y), (16 + line_w, y + 6)], fill=(180, 185, 195))
            y += 12

        # Content image or side card
        draw.rectangle([(16, y + 8), (140, y + 65)], fill=(210, 220, 235))
        draw.rectangle([(150, y + 8), (208, y + 65)], fill=(230, 235, 242))

        # Optional benign brand logo if this is an authentic corporate portal
        if brand_name and logo_detections:
            logo_spec = logo_detections[0]
            bbox = logo_spec.get("boundingBox", {})
            lx = int(bbox.get("x", 0.05) * width)
            ly = int(bbox.get("y", 0.02) * height)
            lw = int(bbox.get("width", 0.15) * width)
            lh = int(bbox.get("height", 0.08) * height)
            draw.rectangle([(lx, ly), (lx + lw, ly + lh)], fill=(255, 255, 255), outline=(200, 200, 200))
            b_colors = BRAND_COLORS.get(brand_name.lower(), ((100, 100, 100),))
            draw.rectangle([(lx + 2, ly + 2), (lx + lw - 2, ly + lh - 2)], fill=b_colors[0])

    else:
        # Render a realistic credential harvesting login card
        # Background: subtle gradient or corporate tint
        bg_color = (random.randint(235, 245), random.randint(238, 248), random.randint(242, 252))
        draw.rectangle([(0, 0), (width, height)], fill=bg_color)

        # Centered white login card
        card_x0, card_y0 = 30, 25
        card_x1, card_y1 = 194, 195
        draw.rectangle([(card_x0, card_y0), (card_x1, card_y1)], fill=(255, 255, 255), outline=(220, 225, 230), width=1)

        # Brand logo inside card
        b_key = (brand_name or "microsoft").lower()
        palette = BRAND_COLORS.get(b_key, ((0, 120, 215), (255, 150, 0)))
        logo_y = card_y0 + 10
        draw.rectangle([(card_x0 + 15, logo_y), (card_x0 + 65, logo_y + 18)], fill=palette[0])

        # Login title text
        draw.rectangle([(card_x0 + 15, logo_y + 26), (card_x0 + 100, logo_y + 36)], fill=(30, 30, 30))

        # Username / Email input field
        in1_y = logo_y + 44
        draw.rectangle([(card_x0 + 15, in1_y), (card_x1 - 15, in1_y + 20)], fill=(250, 250, 252), outline=(180, 185, 195))
        # Placeholder line
        draw.rectangle([(card_x0 + 22, in1_y + 7), (card_x0 + 80, in1_y + 13)], fill=(190, 195, 205))

        # Password input field
        in2_y = in1_y + 28
        draw.rectangle([(card_x0 + 15, in2_y), (card_x1 - 15, in2_y + 20)], fill=(250, 250, 252), outline=(180, 185, 195))
        # Masked password dots
        for dot_x in range(card_x0 + 22, card_x0 + 70, 8):
            draw.ellipse([(dot_x, in2_y + 7), (dot_x + 4, in2_y + 11)], fill=(120, 120, 130))

        # Primary Submit / Sign In button
        btn_y = in2_y + 28
        btn_color = palette[0] if len(palette) > 0 else (0, 102, 204)
        draw.rectangle([(card_x0 + 15, btn_y), (card_x1 - 15, btn_y + 22)], fill=btn_color)
        draw.rectangle([(card_x0 + 40, btn_y + 7), (card_x1 - 40, btn_y + 15)], fill=(255, 255, 255))

        # Optional fake trust badge / security seal
        if image_detections and any(d.get("category") == "security_badge" for d in image_detections):
            badge_y = btn_y + 28
            draw.rectangle([(card_x0 + 35, badge_y), (card_x1 - 35, badge_y + 12)], fill=(230, 245, 230), outline=(100, 180, 100))

    return img


def generate_multimodal_sample(
    is_phishing: bool,
    brand_override: Optional[str] = None,
    seq_length: int = 64,
) -> Dict[str, Any]:
    """Generate a single synchronized multimodal sample spanning all 5 modalities."""
    sample_id = str(uuid4())

    # 1. Select Brand & URL
    if is_phishing:
        brand = brand_override or random.choice(BRAND_LIST)
        brand_key = brand.lower()

        # Generate phishing URL pattern
        attack_style = random.choice(["subdomain_spoof", "typosquat", "path_credential", "ip_host", "suspicious_tld"])
        tld = random.choice(list(SUSPICIOUS_TLDS))

        if attack_style == "subdomain_spoof":
            domain = f"{brand_key}.com.verify-account-update.{tld}"
            url = f"https://{domain}/signin/v2?session={uuid4().hex[:12]}"
        elif attack_style == "typosquat":
            # Typosquatting modification (e.g. micr0soft, go0gle, apple-id)
            typo_map = {"o": "0", "l": "1", "i": "1", "e": "3", "m": "rn"}
            typo_brand = "".join(typo_map.get(c, c) if random.random() < 0.4 else c for c in brand_key)
            if typo_brand == brand_key:
                typo_brand = f"{brand_key}-security"
            domain = f"{typo_brand}-support.{tld}"
            url = f"https://{domain}/login/auth?client_id=prompt"
        elif attack_style == "path_credential":
            domain = f"security-auth-checkpoint.{tld}"
            url = f"https://{domain}/{brand_key}/account/verify/password"
        elif attack_style == "ip_host":
            ip_octets = f"{random.randint(100, 200)}.{random.randint(10, 250)}.{random.randint(10, 250)}.{random.randint(1, 250)}"
            domain = ip_octets
            url = f"http://{domain}:8080/portal/{brand_key}/login.php"
        else:
            domain = f"login-{brand_key}.{tld}"
            url = f"https://{domain}/action/confirm"

        label = 1.0
        target_brand_name = brand.title()

    else:
        # Benign sample
        if brand_override:
            brand = brand_override
            target_brand_name = brand.title()
            official_doms = BRAND_LEGITIMATE_DOMAINS.get(brand.lower(), ["microsoft.com"])
            domain = random.choice(official_doms)
            url = f"https://{domain}/login/authenticate"
        else:
            # Random authentic benign site or authentic corporate portal
            if random.random() < 0.4:
                brand = random.choice(BRAND_LIST)
                target_brand_name = brand.title()
                official_doms = BRAND_LEGITIMATE_DOMAINS.get(brand.lower(), ["google.com"])
                domain = random.choice(official_doms)
                url = f"https://{domain}/services/account"
            else:
                brand = "None"
                target_brand_name = "None"
                dom_tuple = random.choice(BENIGN_DOMAINS_AND_PATHS)
                domain = dom_tuple[0]
                url = f"https://{domain}{dom_tuple[1]}"

        label = 0.0

    # 2. Logo Grounding Spec
    logo_detections = []
    if is_phishing:
        # In phishing, the victim page displays the spoofed brand logo
        brand_id = BRAND_LIST.index(brand.lower()) if brand.lower() in BRAND_LIST else 0
        logo_detections.append({
            "brandName": target_brand_name,
            "brandId": brand_id,
            "boundingBox": {
                "x": round(random.uniform(0.18, 0.25), 3),
                "y": round(random.uniform(0.12, 0.18), 3),
                "width": round(random.uniform(0.20, 0.35), 3),
                "height": round(random.uniform(0.06, 0.10), 3),
            },
            "confidence": round(random.uniform(0.92, 0.99), 3),
            "domainMatchesBrand": False,  # Core phishing mismatch!
        })
    elif target_brand_name != "None":
        # Benign brand portal displays authentic brand logo
        brand_id = BRAND_LIST.index(brand.lower()) if brand.lower() in BRAND_LIST else 0
        logo_detections.append({
            "brandName": target_brand_name,
            "brandId": brand_id,
            "boundingBox": {
                "x": round(random.uniform(0.04, 0.10), 3),
                "y": round(random.uniform(0.02, 0.06), 3),
                "width": round(random.uniform(0.15, 0.25), 3),
                "height": round(random.uniform(0.05, 0.08), 3),
            },
            "confidence": round(random.uniform(0.94, 0.99), 3),
            "domainMatchesBrand": True,  # Authentic domain match
        })

    # 3. Visual Element Image Detections
    image_detections = []
    if is_phishing:
        # Login container annotations
        image_detections.append({
            "category": "input_credential",
            "boundingBox": {"x": 0.20, "y": 0.35, "width": 0.60, "height": 0.08},
            "confidence": round(random.uniform(0.93, 0.98), 3),
        })
        image_detections.append({
            "category": "input_credential",
            "boundingBox": {"x": 0.20, "y": 0.46, "width": 0.60, "height": 0.08},
            "confidence": round(random.uniform(0.94, 0.99), 3),
        })
        image_detections.append({
            "category": "button_submit",
            "boundingBox": {"x": 0.20, "y": 0.58, "width": 0.60, "height": 0.09},
            "confidence": round(random.uniform(0.95, 0.99), 3),
        })
        if random.random() < 0.6:
            image_detections.append({
                "category": "security_badge",
                "boundingBox": {"x": 0.30, "y": 0.72, "width": 0.40, "height": 0.05},
                "confidence": round(random.uniform(0.85, 0.94), 3),
            })
    else:
        if random.random() < 0.35:
            # Occasional benign form (e.g. search bar or comment form)
            image_detections.append({
                "category": "input_generic",
                "boundingBox": {"x": 0.10, "y": 0.15, "width": 0.40, "height": 0.06},
                "confidence": round(random.uniform(0.88, 0.95), 3),
            })
            image_detections.append({
                "category": "button_submit",
                "boundingBox": {"x": 0.52, "y": 0.15, "width": 0.15, "height": 0.06},
                "confidence": round(random.uniform(0.89, 0.95), 3),
            })

    # 4. HID Pointer & Keystroke Dynamics
    # Kinematic mouse trajectory
    is_bot = is_phishing and (random.random() < 0.25)
    if is_bot:
        # Perfectly linear robotic mouse path
        x0, y0 = random.uniform(0.1, 0.3), random.uniform(0.1, 0.3)
        x1, y1 = random.uniform(0.7, 0.9), random.uniform(0.7, 0.9)
        pointer_series = []
        for s_idx in range(seq_length):
            t_frac = s_idx / float(seq_length - 1)
            cx = x0 + t_frac * (x1 - x0)
            cy = y0 + t_frac * (y1 - y0)
            pointer_series.append({
                "x": round(cx, 5),
                "y": round(cy, 5),
                "dx": round((x1 - x0) / seq_length, 5),
                "dy": round((y1 - y0) / seq_length, 5),
                "velocity": 1.2,
                "acceleration": 0.0,
                "angle": round(math.atan2(y1 - y0, x1 - x0), 4),
                "timestamp": round(s_idx * 16.6, 2),
                "eventType": "move" if s_idx < seq_length - 1 else "down",
            })
    else:
        # Realistic human Bézier movement
        jitter = 0.005 if is_phishing else 0.002
        tremor = 0.006 if is_phishing else 0.002
        duration = random.uniform(1100.0, 2200.0) if is_phishing else random.uniform(500.0, 950.0)
        pointer_series = synthesize_human_trajectory_curve(
            start=(random.uniform(0.1, 0.9), random.uniform(0.1, 0.9)),
            end=(random.uniform(0.1, 0.9), random.uniform(0.1, 0.9)),
            num_steps=seq_length,
            jitter_std=jitter,
            tremor_amp=tremor,
            total_time_ms=duration,
        )

    # Privacy-preserving Keystroke Dynamics
    keystrokes = []
    num_keys = random.randint(8, 25) if is_phishing else random.randint(5, 18)
    cur_time = random.uniform(200.0, 400.0)
    for k_idx in range(num_keys):
        # Hesitation on phishing credential fields
        dwell = random.uniform(90.0, 180.0) if is_phishing else random.uniform(60.0, 100.0)
        flight = random.uniform(140.0, 320.0) if is_phishing else random.uniform(90.0, 160.0)
        cat = "ALPHANUMERIC"
        if is_phishing and random.random() < 0.20:
            cat = "BACKSPACE"  # Typos & corrections due to suspicion/hesitation

        keystrokes.append({
            "category": cat,
            "dwellTimeMs": round(dwell, 1),
            "flightTimeMs": round(flight, 1),
            "timestamp": round(cur_time, 1),
        })
        cur_time += dwell + flight

    # DOM Events
    dom_events = []
    if is_phishing:
        if random.random() < 0.5:
            dom_events.append({
                "eventType": "click",
                "targetBoundingBox": {"x": 40.0, "y": 80.0, "width": 120.0, "height": 30.0},
                "isZeroOpacity": random.random() < 0.4,
                "isCrossOriginIframe": random.random() < 0.5,
                "isPasswordInput": True,
                "isPasteIntoPassword": random.random() < 0.35,
                "elementSelector": "form > input[type='password']",
                "timestamp": round(cur_time + 100.0, 1),
            })
    else:
        dom_events.append({
            "eventType": "click",
            "targetBoundingBox": {"x": 20.0, "y": 40.0, "width": 80.0, "height": 25.0},
            "isZeroOpacity": False,
            "isCrossOriginIframe": False,
            "isPasswordInput": False,
            "isPasteIntoPassword": False,
            "elementSelector": "div.content > a.nav-link",
            "timestamp": round(cur_time + 50.0, 1),
        })

    # 5. Render Synthetic Viewport
    viewport_img = _render_synthetic_viewport(
        is_phishing=is_phishing,
        brand_name=brand if brand != "None" else None,
        image_detections=image_detections,
        logo_detections=logo_detections,
        target_size=(224, 224),
    )
    viewport_np = np.array(viewport_img, dtype=np.float32)

    # 6. Extract Pre-Computed Features
    url_feat = extract_url_features(url, domain=domain)
    hid_feat = extract_hid_features(pointer_series, keystrokes, dom_events)
    logo_feat = extract_logo_features(logo_detections, domain=domain)
    det_feat = extract_image_detection_features(image_detections, dom_events)

    return {
        "sampleId": sample_id,
        "label": label,
        "url": url,
        "domain": domain,
        "targetBrand": target_brand_name if target_brand_name != "None" else None,
        "pointerSeries": pointer_series,
        "keystrokes": keystrokes,
        "domEvents": dom_events,
        "logoDetections": logo_detections,
        "imageDetections": image_detections,
        "viewport": viewport_np,  # (224, 224, 3) float32
        "viewport_pil": viewport_img,
        "extractedFeatures": {
            "url": url_feat.tolist(),
            "hid": hid_feat.tolist(),
            "logo": logo_feat.tolist(),
            "detection": det_feat.tolist(),
        },
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }


def generate_multimodal_dataset_batch(
    num_samples: int = 100,
    phishing_ratio: float = 0.5,
    seq_length: int = 64,
    seed: Optional[int] = 42,
) -> List[Dict[str, Any]]:
    """Generate a balanced batch of multimodal samples."""
    if seed is not None:
        random.seed(seed)
        np.random.seed(seed)

    samples = []
    num_phish = int(num_samples * phishing_ratio)
    num_benign = num_samples - num_phish

    # Distribute brands across phishing and benign samples
    for i in range(num_phish):
        brand_target = BRAND_LIST[i % len(BRAND_LIST)]
        sample = generate_multimodal_sample(is_phishing=True, brand_override=brand_target, seq_length=seq_length)
        samples.append(sample)

    for i in range(num_benign):
        sample = generate_multimodal_sample(is_phishing=False, brand_override=None, seq_length=seq_length)
        samples.append(sample)

    # Shuffle dataset
    random.shuffle(samples)
    return samples
