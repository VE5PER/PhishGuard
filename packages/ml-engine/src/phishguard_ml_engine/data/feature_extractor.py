"""Multimodal Feature Extractor for PhishGuard.

Extracts normalized feature vectors across 5 modalities:
1. URL: Lexical, syntactic, entropy, typosquatting, brand impersonation (32-dim)
2. HID: Pointer kinematics, keystroke flight/dwell, bot linearity, paste flags (16-dim)
3. Logo: Brand grounding, bounding boxes, brand-domain mismatch consistency (16-dim)
4. Screen: DOM structural hierarchy, zero-opacity, iframe depth (16-dim)
5. Image Detection: Visual UI element layout, credential inputs, buttons, badges (16-dim)
"""

import math
import re
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse
import numpy as np

# Official legitimate domains for top target brands
BRAND_LEGITIMATE_DOMAINS: Dict[str, List[str]] = {
    "microsoft": ["microsoft.com", "live.com", "login.microsoftonline.com", "office.com", "outlook.com", "msn.com"],
    "google": ["google.com", "accounts.google.com", "gmail.com", "youtube.com"],
    "apple": ["apple.com", "appleid.apple.com", "icloud.com"],
    "paypal": ["paypal.com"],
    "bank of america": ["bankofamerica.com", "bofa.com"],
    "amazon": ["amazon.com", "aws.amazon.com"],
    "facebook": ["facebook.com", "fb.com", "meta.com", "instagram.com"],
    "netflix": ["netflix.com"],
    "chase": ["chase.com", "jpmorganchase.com"],
    "wells fargo": ["wellsfargo.com"],
    "adobe": ["adobe.com"],
    "yahoo": ["yahoo.com", "login.yahoo.com"],
    "ebay": ["ebay.com"],
    "steam": ["steampowered.com", "steamcommunity.com"],
    "linkedin": ["linkedin.com"],
    "dhl": ["dhl.com"],
    "dropbox": ["dropbox.com"],
    "docusign": ["docusign.com"],
    "coinbase": ["coinbase.com"],
    "whatsapp": ["whatsapp.com", "web.whatsapp.com"],
}

BRAND_LIST: List[str] = [
    "microsoft",
    "google",
    "apple",
    "paypal",
    "bank of america",
    "amazon",
    "facebook",
    "netflix",
    "chase",
    "wells fargo",
    "adobe",
    "yahoo",
    "ebay",
    "steam",
    "linkedin",
    "dhl",
    "dropbox",
    "docusign",
    "coinbase",
    "whatsapp",
]

SUSPICIOUS_TLDS = {
    "xyz", "top", "buzz", "club", "work", "icu", "tokyo", "gq", "cf", "ml", "ga", "click", "rest", "fit", "live", "vip"
}

SENSITIVE_KEYWORDS = [
    "login", "signin", "verify", "account", "update", "banking", "secure",
    "password", "wallet", "confirm", "auth", "recover", "token", "support",
    "security", "credential", "session", "suspended", "action"
]


def _shannon_entropy(text: str) -> float:
    """Compute Shannon entropy of a string."""
    if not text:
        return 0.0
    length = len(text)
    freq: Dict[str, int] = {}
    for ch in text:
        freq[ch] = freq.get(ch, 0) + 1
    entropy = 0.0
    for count in freq.values():
        p = count / length
        entropy -= p * math.log2(p)
    return entropy


def _levenshtein_similarity(s1: str, s2: str) -> float:
    """Normalized similarity in [0, 1] using Levenshtein distance."""
    if not s1 or not s2:
        return 0.0
    m, n = len(s1), len(s2)
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            cost = 0 if s1[i - 1] == s2[j - 1] else 1
            dp[i][j] = min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    dist = dp[m][n]
    max_len = max(m, n)
    return 1.0 - (dist / max_len)


def is_official_domain_for_brand(brand_or_domain_1: str, brand_or_domain_2: str) -> bool:
    """Check if domain is officially authorized for the brand."""
    k1 = brand_or_domain_1.lower().strip()
    k2 = brand_or_domain_2.lower().strip()
    if k1 in BRAND_LEGITIMATE_DOMAINS:
        brand_name, domain = k1, k2
    elif k2 in BRAND_LEGITIMATE_DOMAINS:
        brand_name, domain = k2, k1
    else:
        brand_name, domain = k1, k2

    d_clean = domain.split(":")[0]
    authorized = BRAND_LEGITIMATE_DOMAINS.get(brand_name, [])
    for auth in authorized:
        if d_clean == auth or d_clean.endswith("." + auth):
            return True
    return False


def extract_url_features(url: str, domain: Optional[str] = None) -> np.ndarray:
    """Extract a 32-dimensional normalized feature vector from a URL.

    Features:
      0: url_length_norm in [0, 1]
      1: domain_length_norm in [0, 1]
      2: path_length_norm in [0, 1]
      3: num_dots_norm in [0, 1]
      4: num_hyphens_norm in [0, 1]
      5: num_underscores_norm in [0, 1]
      6: num_slashes_norm in [0, 1]
      7: num_digits_norm in [0, 1]
      8: num_subdomains_norm in [0, 1]
      9: shannon_entropy_norm in [0, 1] (entropy / 8.0)
      10: has_ip_address flag (1.0 or 0.0)
      11: has_https flag (1.0 or 0.0)
      12: suspicious_tld flag (1.0 or 0.0)
      13: sensitive_keywords_count_norm in [0, 1]
      14: brand_in_subdomain flag (1.0 or 0.0)
      15: brand_in_path flag (1.0 or 0.0)
      16: max_brand_similarity in [0, 1] (typosquatting distance)
      17: digit_to_char_ratio in [0, 1]
      18: symbol_to_char_ratio in [0, 1]
      19: hex_encoded_char_count_norm in [0, 1]
      20: query_length_norm in [0, 1]
      21: num_query_params_norm in [0, 1]
      22: has_at_symbol flag (1.0 or 0.0)
      23: has_double_slash_in_path flag (1.0 or 0.0)
      24: subdomain_entropy_norm in [0, 1]
      25: has_port_number flag (1.0 or 0.0)
      26: tld_length_norm in [0, 1]
      27: consecutive_consonant_ratio in [0, 1] (DGA indicator)
      28: hyphen_in_domain flag (1.0 or 0.0)
      29: num_subdomain_hyphens_norm in [0, 1]
      30: path_depth_norm in [0, 1]
      31: brand_mismatch_risk_score in [0, 1]
    """
    vec = np.zeros(32, dtype=np.float32)
    if not url:
        return vec

    parsed = urlparse(url)
    dom = (domain or parsed.netloc or "").lower().split(":")[0]
    path = parsed.path or ""
    query = parsed.query or ""
    scheme = parsed.scheme.lower()

    url_len = len(url)
    dom_len = len(dom)
    path_len = len(path)

    vec[0] = min(url_len / 200.0, 1.0)
    vec[1] = min(dom_len / 50.0, 1.0)
    vec[2] = min(path_len / 100.0, 1.0)
    vec[3] = min(url.count(".") / 10.0, 1.0)
    vec[4] = min(url.count("-") / 8.0, 1.0)
    vec[5] = min(url.count("_") / 5.0, 1.0)
    vec[6] = min(url.count("/") / 10.0, 1.0)
    digits_count = sum(c.isdigit() for c in url)
    vec[7] = min(digits_count / 30.0, 1.0)

    # Subdomains
    dom_parts = dom.split(".") if dom else []
    num_subdomains = max(len(dom_parts) - 2, 0)
    vec[8] = min(num_subdomains / 4.0, 1.0)

    # Entropy
    ent = _shannon_entropy(url)
    vec[9] = min(ent / 8.0, 1.0)

    # IP Address Host
    is_ip = bool(re.match(r"^(\d{1,3}\.){3}\d{1,3}$", dom))
    vec[10] = 1.0 if is_ip else 0.0

    # HTTPS
    vec[11] = 1.0 if scheme == "https" else 0.0

    # Suspicious TLD
    tld = dom_parts[-1] if len(dom_parts) > 1 else ""
    vec[12] = 1.0 if tld in SUSPICIOUS_TLDS else 0.0

    # Sensitive keywords
    url_lower = url.lower()
    kw_count = sum(1 for kw in SENSITIVE_KEYWORDS if kw in url_lower)
    vec[13] = min(kw_count / 4.0, 1.0)

    # Brand appearance in subdomain or path
    brand_in_sub = False
    brand_in_pth = False
    max_sim = 0.0
    matched_brand = None

    subdomain_str = ".".join(dom_parts[:-2]) if len(dom_parts) > 2 else ""
    for b in BRAND_LIST:
        if b in subdomain_str:
            brand_in_sub = True
        if b in path.lower():
            brand_in_pth = True
        if b in dom and not is_official_domain_for_brand(b, dom):
            brand_in_sub = True
            matched_brand = b
        # Check domain typosquatting against brand official domains
        for official in BRAND_LEGITIMATE_DOMAINS.get(b, []):
            sim = _levenshtein_similarity(dom, official)
            if sim > max_sim:
                max_sim = sim
                if sim >= 0.70:
                    matched_brand = b

    vec[14] = 1.0 if brand_in_sub else 0.0
    vec[15] = 1.0 if brand_in_pth else 0.0
    vec[16] = min(max_sim, 1.0)

    # Ratios
    vec[17] = digits_count / max(url_len, 1)
    symbols_count = sum(not c.isalnum() for c in url)
    vec[18] = symbols_count / max(url_len, 1)

    # Hex encodings (%20, etc.)
    hex_count = len(re.findall(r"%[0-9a-fA-F]{2}", url))
    vec[19] = min(hex_count / 10.0, 1.0)

    # Query length & params
    vec[20] = min(len(query) / 100.0, 1.0)
    num_params = len(query.split("&")) if query else 0
    vec[21] = min(num_params / 5.0, 1.0)

    # '@' symbol (often used in credential URLs or URL obfuscation)
    vec[22] = 1.0 if "@" in url else 0.0

    # Double slash in path (redirect evasion)
    vec[23] = 1.0 if "//" in path else 0.0

    # Subdomain entropy
    sub_ent = _shannon_entropy(subdomain_str) if subdomain_str else 0.0
    vec[24] = min(sub_ent / 6.0, 1.0)

    # Port in netloc
    vec[25] = 1.0 if ":" in (parsed.netloc or "") else 0.0

    # TLD length
    vec[26] = min(len(tld) / 10.0, 1.0)

    # DGA indicator: consecutive consonants in domain SLD
    sld = dom_parts[-2] if len(dom_parts) >= 2 else dom
    consonants_run = max([len(m) for m in re.findall(r"[bcdfghjklmnpqrstvwxyz]+", sld)] or [0])
    vec[27] = min(consonants_run / 8.0, 1.0)

    # Hyphen in domain
    vec[28] = 1.0 if "-" in dom else 0.0

    # Subdomain hyphens
    sub_hyphens = subdomain_str.count("-")
    vec[29] = min(sub_hyphens / 3.0, 1.0)

    # Path depth
    path_depth = len([p for p in path.split("/") if p])
    vec[30] = min(path_depth / 5.0, 1.0)

    # Brand mismatch risk: brand found in URL but domain is NOT official
    brand_risk = 0.0
    if matched_brand and not is_official_domain_for_brand(matched_brand, dom):
        brand_risk = 1.0
    elif (brand_in_sub or brand_in_pth):
        brand_risk = 0.75
    vec[31] = brand_risk

    return vec


def extract_hid_features(
    pointer_events: List[Dict[str, Any]],
    keystrokes: List[Dict[str, Any]],
    dom_events: List[Dict[str, Any]],
) -> np.ndarray:
    """Extract a 16-dimensional normalized feature vector from HID and interaction events.

    Features:
      0: pointer_velocity_mean_norm in [0, 1]
      1: pointer_velocity_std_norm in [0, 1]
      2: pointer_acceleration_mean_norm in [0, 1]
      3: angular_jitter_norm in [0, 1]
      4: bot_linearity_score in [0, 1] (1.0 = perfectly robotic straight line)
      5: dwell_time_mean_norm in [0, 1] (keystroke dwell)
      6: dwell_time_std_norm in [0, 1]
      7: flight_time_mean_norm in [0, 1] (keystroke flight)
      8: flight_time_std_norm in [0, 1]
      9: backspace_hesitation_ratio in [0, 1]
      10: paste_into_password_flag (1.0 or 0.0)
      11: zero_opacity_click_flag (1.0 or 0.0)
      12: cross_origin_interaction_flag (1.0 or 0.0)
      13: total_clicks_norm in [0, 1]
      14: interaction_duration_norm in [0, 1]
      15: behavioral_anomaly_composite_score in [0, 1]
    """
    vec = np.zeros(16, dtype=np.float32)

    # 1. Pointer Kinematics
    if pointer_events:
        vels = [float(p.get("velocity", 0.0)) for p in pointer_events]
        accs = [abs(float(p.get("acceleration", 0.0))) for p in pointer_events]
        angles = [float(p.get("angle", 0.0)) for p in pointer_events]

        mean_v = float(np.mean(vels)) if vels else 0.0
        std_v = float(np.std(vels)) if vels else 0.0
        mean_a = float(np.mean(accs)) if accs else 0.0

        # Angular jitter: mean angular delta
        if len(angles) > 1:
            diffs = [abs(angles[i] - angles[i - 1]) for i in range(1, len(angles))]
            jitter = float(np.mean(diffs))
        else:
            jitter = 0.0

        # Linearity score: ratio of euclidean displacement to cumulative path distance
        xs = [float(p.get("x", 0.0)) for p in pointer_events]
        ys = [float(p.get("y", 0.0)) for p in pointer_events]
        if len(xs) > 1:
            disp = math.hypot(xs[-1] - xs[0], ys[-1] - ys[0])
            path_len = sum(
                math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]) for i in range(1, len(xs))
            )
            linearity = (disp / max(path_len, 1e-6)) if path_len > 1e-4 else 0.0
        else:
            linearity = 0.0

        vec[0] = min(mean_v / 2.0, 1.0)
        vec[1] = min(std_v / 1.5, 1.0)
        vec[2] = min(mean_a / 0.1, 1.0)
        vec[3] = min(jitter / math.pi, 1.0)
        vec[4] = min(max(linearity, 0.0), 1.0)

    # 2. Keystroke Dynamics
    if keystrokes:
        dwells = [float(k.get("dwellTimeMs", 0.0)) for k in keystrokes]
        flights = [float(k.get("flightTimeMs", 0.0)) for k in keystrokes]
        categories = [str(k.get("category", "")).upper() for k in keystrokes]

        mean_dwell = float(np.mean(dwells)) if dwells else 0.0
        std_dwell = float(np.std(dwells)) if dwells else 0.0
        mean_flight = float(np.mean(flights)) if flights else 0.0
        std_flight = float(np.std(flights)) if flights else 0.0

        num_backspace = sum(1 for c in categories if "BACKSPACE" in c)
        backspace_ratio = num_backspace / max(len(categories), 1)

        vec[5] = min(mean_dwell / 300.0, 1.0)
        vec[6] = min(std_dwell / 150.0, 1.0)
        vec[7] = min(mean_flight / 500.0, 1.0)
        vec[8] = min(std_flight / 250.0, 1.0)
        vec[9] = min(backspace_ratio, 1.0)

    # 3. DOM & Interaction Signals
    paste_into_pwd = False
    zero_opacity = False
    cross_origin = False
    click_count = 0
    duration_ms = 0.0

    if dom_events:
        for ev in dom_events:
            ev_type = str(ev.get("eventType", "")).lower()
            if ev_type == "click":
                click_count += 1
            if ev.get("isPasteIntoPassword", False):
                paste_into_pwd = True
            if ev.get("isZeroOpacity", False):
                zero_opacity = True
            if ev.get("isCrossOriginIframe", False):
                cross_origin = True
            duration_ms = max(duration_ms, float(ev.get("timestamp", 0.0)))

    if pointer_events:
        duration_ms = max(duration_ms, float(pointer_events[-1].get("timestamp", 0.0)))

    vec[10] = 1.0 if paste_into_pwd else 0.0
    vec[11] = 1.0 if zero_opacity else 0.0
    vec[12] = 1.0 if cross_origin else 0.0
    vec[13] = min(click_count / 10.0, 1.0)
    vec[14] = min(duration_ms / 10000.0, 1.0)

    # Composite behavioral anomaly score
    # High if suspicious flags present, or bot-linear, or extreme hesitation
    anomaly = (
        0.30 * vec[10]
        + 0.30 * vec[11]
        + 0.25 * vec[12]
        + 0.15 * (1.0 if vec[4] > 0.95 else 0.0)
    )
    vec[15] = min(anomaly, 1.0)

    return vec


def extract_logo_features(
    logo_detections: List[Dict[str, Any]],
    domain: str,
) -> np.ndarray:
    """Extract a 16-dimensional normalized feature vector from brand logo detections.

    Features:
      0: has_logo_detected (1.0 or 0.0)
      1: logo_confidence in [0, 1]
      2: target_brand_id_norm in [0, 1] (brandId / 10.0)
      3: brand_domain_mismatch (1.0 if logo present on unverified domain, else 0.0)
      4: logo_bbox_x in [0, 1]
      5: logo_bbox_y in [0, 1]
      6: logo_bbox_w in [0, 1]
      7: logo_bbox_h in [0, 1]
      8: logo_area_fraction in [0, 1]
      9: logo_aspect_ratio_norm in [0, 1]
      10: logo_is_prominent_header (1.0 or 0.0)
      11: multiple_competing_brands_detected (1.0 or 0.0)
      12: brand_token_present_in_domain (1.0 or 0.0)
      13: domain_is_official_for_detected_brand (1.0 or 0.0)
      14: logo_confidence_weighted_mismatch in [0, 1]
      15: logo_risk_composite in [0, 1]
    """
    vec = np.zeros(16, dtype=np.float32)
    if not logo_detections:
        return vec

    primary = logo_detections[0]
    brand_name = str(primary.get("brandName", "None"))
    brand_id = int(primary.get("brandId", 0))
    conf = float(primary.get("confidence", 0.0))
    bbox = primary.get("boundingBox", {})

    bx = float(bbox.get("x", 0.0))
    by = float(bbox.get("y", 0.0))
    bw = float(bbox.get("width", 0.0))
    bh = float(bbox.get("height", 0.0))
    area = bw * bh
    aspect = (bw / max(bh, 1e-4)) if bh > 0 else 1.0

    is_official = is_official_domain_for_brand(brand_name, domain)
    has_mismatch = (conf >= 0.5) and (brand_name.lower() not in ["none", "generic benign"]) and (not is_official)

    vec[0] = 1.0
    vec[1] = conf
    vec[2] = min(brand_id / 10.0, 1.0)
    vec[3] = 1.0 if has_mismatch else 0.0
    vec[4] = min(max(bx, 0.0), 1.0)
    vec[5] = min(max(by, 0.0), 1.0)
    vec[6] = min(max(bw, 0.0), 1.0)
    vec[7] = min(max(bh, 0.0), 1.0)
    vec[8] = min(area, 1.0)
    vec[9] = min(aspect / 5.0, 1.0)

    # Logo in header area (top 20% of page)
    vec[10] = 1.0 if by < 0.20 else 0.0

    # Multiple distinct brands
    distinct_brands = {str(d.get("brandName", "")) for d in logo_detections if str(d.get("brandName", "")) not in ["None", ""]}
    vec[11] = 1.0 if len(distinct_brands) > 1 else 0.0

    # Domain contains brand token
    vec[12] = 1.0 if brand_name.lower() in domain.lower() else 0.0
    vec[13] = 1.0 if is_official else 0.0

    # Confidence-weighted mismatch
    vec[14] = conf if has_mismatch else 0.0

    # Composite logo risk (1.0 = strong phishing indicator)
    vec[15] = 1.0 if has_mismatch else 0.0

    return vec


def extract_image_detection_features(
    image_detections: List[Dict[str, Any]],
    dom_events: Optional[List[Dict[str, Any]]] = None,
) -> np.ndarray:
    """Extract a 16-dimensional normalized feature vector from visual element detections.

    Features:
      0: credential_inputs_detected_norm in [0, 1]
      1: submit_buttons_detected_norm in [0, 1]
      2: security_badges_detected_norm in [0, 1]
      3: captchas_detected_norm in [0, 1]
      4: login_form_detected (1.0 or 0.0)
      5: login_form_center_y in [0, 1]
      6: login_form_width_norm in [0, 1]
      7: login_form_height_norm in [0, 1]
      8: credential_inputs_confidence_mean in [0, 1]
      9: submit_buttons_confidence_mean in [0, 1]
      10: has_suspicious_trust_seal (1.0 or 0.0)
      11: zero_opacity_element_count_norm in [0, 1]
      12: cross_origin_iframe_count_norm in [0, 1]
      13: total_interactive_elements_norm in [0, 1]
      14: login_dialog_centered_score in [0, 1]
      15: visual_credential_harvesting_risk in [0, 1]
    """
    vec = np.zeros(16, dtype=np.float32)

    inputs = []
    buttons = []
    badges = []
    captchas = []

    for det in image_detections:
        cat = str(det.get("category", "")).lower()
        conf = float(det.get("confidence", 0.0))
        bbox = det.get("boundingBox", {})
        if "credential" in cat or "input" in cat:
            inputs.append((conf, bbox))
        elif "button" in cat:
            buttons.append((conf, bbox))
        elif "badge" in cat or "security" in cat:
            badges.append((conf, bbox))
        elif "captcha" in cat:
            captchas.append((conf, bbox))

    vec[0] = min(len(inputs) / 4.0, 1.0)
    vec[1] = min(len(buttons) / 3.0, 1.0)
    vec[2] = min(len(badges) / 2.0, 1.0)
    vec[3] = min(len(captchas) / 2.0, 1.0)

    # Login form pattern: both credential inputs and submit button exist
    has_login_form = len(inputs) > 0 and len(buttons) > 0
    vec[4] = 1.0 if has_login_form else 0.0

    # Centering and geometry
    if inputs:
        avg_cy = float(np.mean([float(b[1].get("y", 0.5)) for b in inputs]))
        avg_w = float(np.mean([float(b[1].get("width", 0.3)) for b in inputs]))
        avg_h = float(np.mean([float(b[1].get("height", 0.05)) for b in inputs]))
        vec[5] = min(max(avg_cy, 0.0), 1.0)
        vec[6] = min(max(avg_w, 0.0), 1.0)
        vec[7] = min(max(avg_h, 0.0), 1.0)
        vec[8] = float(np.mean([b[0] for b in inputs]))

        # Form is centered around viewport center (y ~ 0.3 to 0.6)
        is_centered = 1.0 - min(abs(avg_cy - 0.45) / 0.45, 1.0)
        vec[14] = is_centered

    if buttons:
        vec[9] = float(np.mean([b[0] for b in buttons]))

    # Suspicious trust seal: fake Norton/McAfee badge on form
    vec[10] = 1.0 if len(badges) > 0 else 0.0

    # DOM events stats if provided
    zero_count = 0
    iframe_count = 0
    if dom_events:
        for ev in dom_events:
            if ev.get("isZeroOpacity", False):
                zero_count += 1
            if ev.get("isCrossOriginIframe", False):
                iframe_count += 1

    vec[11] = min(zero_count / 3.0, 1.0)
    vec[12] = min(iframe_count / 3.0, 1.0)
    vec[13] = min((len(inputs) + len(buttons) + len(badges)) / 6.0, 1.0)

    # Visual credential harvesting risk: login form + zero-opacity or fake badge
    risk = 0.0
    if has_login_form:
        risk = 0.5 + (0.3 * vec[10]) + (0.2 * vec[11])
    vec[15] = min(risk, 1.0)

    return vec
