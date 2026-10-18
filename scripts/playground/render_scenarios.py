#!/usr/bin/env python3
"""Dev-only generator for the playground scenario fixtures.

Renders the HTML mocks with headless Chrome, writes the JPEG screenshots and
payload-template JSON files into the backend fixtures package, and optionally
reports the edge-model route each scenario would take.

    .venv/bin/python scripts/playground/render_scenarios.py [--report] [--no-render]
"""

import argparse
import base64
import json
import math
import random
import re
import subprocess
import tempfile
from html.parser import HTMLParser
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
MOCKS_DIR = ROOT / "apps/landing/public/sandbox"
FIXTURES_DIR = ROOT / "apps/backend/src/phishguard_backend/playground/scenarios"
ONNX_PATH = ROOT / "apps/extension/public/models/student_model.onnx"
CHROME = "/usr/bin/google-chrome"
VIEWPORT = (1024, 640)
MAX_DATA_URL_CHARS = 300_000

from phishguard_ml_engine.data.bezier_synthesizer import synthesize_human_trajectory_curve  # noqa: E402
from phishguard_ml_engine.data.page_context import (  # noqa: E402
    compose_risk,
    evaluate_evidence_risk,
    prepare_page_context,
)
from phishguard_ml_engine.data.trajectory_preprocessor import prepare_trajectory  # noqa: E402
from phishguard_types import PointerEventPoint, PlaygroundScenario  # noqa: E402


def norm(px: float, py: float) -> tuple[float, float]:
    return px / VIEWPORT[0], py / VIEWPORT[1]


def box(x: float, y: float, w: float, h: float) -> dict:
    return {"x": x, "y": y, "width": w, "height": h}


def center(b: dict) -> tuple[float, float]:
    return norm(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2)


class MockGeometry(HTMLParser):
    """Reads page title and marked element geometry from a sandbox mock."""

    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.password: dict | None = None
        self.submit: dict | None = None
        self.evidence: list[dict] = []
        self._in_title = False

    @staticmethod
    def _box(style: str) -> dict:
        values = {}
        for name in ("left", "top", "width", "height"):
            match = re.search(rf"(?<![\w-]){name}:\s*(-?\d+(?:\.\d+)?)px", style)
            if not match:
                raise ValueError(f"missing {name} in inline style: {style!r}")
            values[name] = float(match.group(1))
        return box(values["left"], values["top"], values["width"], values["height"])

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "title":
            self._in_title = True
        if attributes.get("id") == "password":
            self.password = self._box(attributes.get("style", ""))
        if "data-pg-submit" in attributes:
            self.submit = self._box(attributes.get("style", ""))
        if "data-pg-evidence" in attributes:
            self.evidence.append({
                "id": attributes["data-pg-evidence"],
                "covers": attributes.get("data-pg-covers"),
                "frame": attributes.get("data-pg-frame"),
                "box": self._box(attributes.get("style", "")),
                "tag": tag,
            })

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def parse_mock(scenario_id: str) -> MockGeometry:
    parser = MockGeometry()
    parser.feed((MOCKS_DIR / f"{scenario_id}.html").read_text(encoding="utf-8"))
    if parser.password is None or parser.submit is None:
        raise ValueError(f"{scenario_id}: mock needs #password and [data-pg-submit]")
    return parser


def topology_events(geometry: MockGeometry) -> list[dict]:
    events = []
    for index, item in enumerate(geometry.evidence):
        selector = f'body > {item["tag"]}[data-pg-evidence="{item["id"]}"]'
        timestamp = 120.0 + 10.0 * index
        if item["frame"]:
            events.append(dom_event("hover", item["box"], selector, timestamp, source="topology_scan", cross=True,
                                    frame=item["frame"], evidence_id=item["id"]))
        else:
            events.append(dom_event("hover", item["box"], selector, timestamp, source="topology_scan", zero=True,
                                    intercept=True, covered=item["covers"], evidence_id=item["id"]))
    return events


def dom_event(event_type, bbox, selector, timestamp, *, source, zero=False, cross=False, password=False,
              intercept=False, covered="none", frame="none", evidence_id=None) -> dict:
    event = {
        "eventType": event_type,
        "targetBoundingBox": bbox,
        "isZeroOpacity": zero,
        "isCrossOriginIframe": cross,
        "isPasswordInput": password,
        "isPasteIntoPassword": False,
        "elementSelector": selector,
        "timestamp": timestamp,
        "evidenceSource": source,
        "isHitTestIntercepting": intercept,
        "coveredControlType": covered,
        "credentialFrameEvidence": frame,
    }
    if evidence_id:
        event["evidenceId"] = evidence_id
    return event


def robotic_trajectory(start, end, steps=128, total_ms=400.0) -> list[dict]:
    points = []
    dt = total_ms / (steps - 1)
    prev = start
    for i in range(steps):
        s = i / (steps - 1)
        x = start[0] + (end[0] - start[0]) * s
        y = start[1] + (end[1] - start[1]) * s
        dx, dy = x - prev[0], y - prev[1]
        dist = math.hypot(dx, dy)
        points.append({
            "x": round(x, 5), "y": round(y, 5), "dx": round(dx, 5), "dy": round(dy, 5),
            "velocity": round(dist / dt if i else 0.0, 5), "acceleration": 0.0,
            "angle": round(math.atan2(dy, dx) if dist > 1e-9 else 0.0, 5),
            "timestamp": round(i * dt, 2),
            "eventType": "down" if i == steps - 1 else "move",
        })
        prev = (x, y)
    return points


def human_trajectory(seed, start, end, total_ms) -> list[dict]:
    random.seed(seed)
    points = synthesize_human_trajectory_curve(start, end, num_steps=128, total_time_ms=total_ms)
    points[0]["eventType"] = "move"
    return points


def robotic_keystrokes(count=10, start_ms=620.0) -> list[dict]:
    return [
        {"category": "ALPHANUMERIC", "dwellTimeMs": 5.0, "flightTimeMs": 10.0, "timestamp": start_ms + i * 15.0}
        for i in range(count)
    ]


def human_keystrokes(seed, count=12, start_ms=1400.0, backspace_at=7) -> list[dict]:
    rng = random.Random(seed)
    result, t = [], start_ms
    for i in range(count):
        flight = round(rng.uniform(90, 250), 1)
        dwell = round(rng.uniform(70, 130), 1)
        t += flight + dwell
        category = "BACKSPACE" if i == backspace_at else "ALPHANUMERIC"
        result.append({"category": category, "dwellTimeMs": dwell, "flightTimeMs": flight, "timestamp": round(t, 1)})
    return result


def scenario_definitions() -> dict[str, dict]:
    brand_geo, sso_geo, google_geo = (parse_mock(name) for name in ("brand-impersonation", "ambiguous-sso", "benign-google"))
    brand = {
        "title": "Brand impersonation",
        "tagline": "A PayPal look-alike on login-verify-paypa1.xyz hides transparent traps over the password and submit controls.",
        "payload": {
            "url": "https://login-verify-paypa1.xyz/signin",
            "domain": "login-verify-paypa1.xyz",
            "hasCredentialField": True,
            "mouseTrajectorySeries": robotic_trajectory(norm(100, 150), center(brand_geo.password)),
            "domElementsSummary": topology_events(brand_geo),
            "keystrokesSummary": robotic_keystrokes(),
        },
    }
    sso = {
        "title": "Ambiguous SSO portal",
        "tagline": "An unfamiliar corporate sign-in page with one transparent overlay — not enough for the edge model to decide alone.",
        "payload": {
            "url": "https://sso.northwind-gateway.co/auth",
            "domain": "sso.northwind-gateway.co",
            "hasCredentialField": True,
            "mouseTrajectorySeries": human_trajectory(7, norm(160, 120), center(sso_geo.password), 1200.0),
            "domElementsSummary": [
                *topology_events(sso_geo),
                dom_event("focus", sso_geo.password, "input#password", 1250.0, source="observed_interaction", password=True),
            ],
            "keystrokesSummary": human_keystrokes(11),
        },
    }
    google = {
        "title": "Benign Google sign-in",
        "tagline": "A Google-style sign-in on the authorized accounts.google.com host with natural human input.",
        "payload": {
            "url": "https://accounts.google.com/signin",
            "domain": "accounts.google.com",
            "hasCredentialField": True,
            "mouseTrajectorySeries": human_trajectory(21, norm(200, 140), center(google_geo.password), 900.0),
            "domElementsSummary": [
                dom_event("focus", google_geo.password, "input#password", 950.0, source="observed_interaction", password=True),
            ],
            "keystrokesSummary": human_keystrokes(33, count=11, start_ms=1000.0, backspace_at=5),
        },
    }
    return {"brand-impersonation": brand, "ambiguous-sso": sso, "benign-google": google}


def render_mock(scenario_id: str) -> Image.Image:
    html = MOCKS_DIR / f"{scenario_id}.html"
    with tempfile.TemporaryDirectory() as tmp:
        shot = Path(tmp) / "shot.png"
        subprocess.run(
            [CHROME, "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
             f"--window-size={VIEWPORT[0]},{VIEWPORT[1]}", f"--screenshot={shot}", html.as_uri()],
            check=True, capture_output=True, timeout=60,
        )
        image = Image.open(shot).convert("RGB")
        image.load()
    return image.crop((0, 0, *VIEWPORT)) if image.size != VIEWPORT else image


def encode_jpeg(image: Image.Image, target: Path) -> int:
    for quality in range(88, 30, -4):
        image.save(target, "JPEG", quality=quality, optimize=True)
        data_url_len = len("data:image/jpeg;base64,") + 4 * math.ceil(target.stat().st_size / 3)
        if data_url_len < MAX_DATA_URL_CHARS:
            return quality
    raise RuntimeError(f"cannot fit {target.name} under {MAX_DATA_URL_CHARS} chars")


def write_fixtures(render: bool) -> None:
    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    for scenario_id, definition in scenario_definitions().items():
        for point in definition["payload"]["mouseTrajectorySeries"]:
            PointerEventPoint.model_validate(point)
        (FIXTURES_DIR / f"{scenario_id}.json").write_text(json.dumps(definition, indent=2) + "\n", encoding="utf-8")
        if render:
            quality = encode_jpeg(render_mock(scenario_id), FIXTURES_DIR / f"{scenario_id}.jpg")
            print(f"wrote {scenario_id}: jpeg quality {quality}")


def visual_tensor(jpg: Path) -> np.ndarray:
    image = Image.open(jpg).convert("RGB").resize((64, 64), Image.BILINEAR)
    return (np.asarray(image, dtype=np.float32) / 255.0).transpose(2, 0, 1)[None]


def report() -> None:
    import onnxruntime as ort

    session = ort.InferenceSession(str(ONNX_PATH), providers=["CPUExecutionProvider"])
    names = [i.name for i in session.get_inputs()]
    print(f"onnx inputs: {names}")
    print(f"{'scenario':<22}{'model':>10}{'evidence':>10}{'fused':>10}  route")
    for scenario_id, definition in scenario_definitions().items():
        payload = definition["payload"]
        trajectory = prepare_trajectory(payload["mouseTrajectorySeries"])
        page = prepare_page_context(
            {"url": payload["url"], "domain": payload["domain"], "domEvents": payload["domElementsSummary"],
             "hasCredentialField": payload["hasCredentialField"]},
            trajectory, visual_available=True,
        )
        evidence = evaluate_evidence_risk(page)
        feeds = {
            "trajectory": trajectory.tensor[None].astype(np.float32),
            "visual": visual_tensor(FIXTURES_DIR / f"{scenario_id}.jpg"),
            "page_context": page["context"][None].astype(np.float32),
        }
        model_score = float(np.asarray(session.run(None, {n: feeds[n] for n in names})[0]).reshape(-1)[0])
        fused, route = compose_risk(model_score, evidence["score"])
        print(f"{scenario_id:<22}{model_score:>10.4f}{evidence['score']:>10.4f}{fused:>10.4f}  {route}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", action="store_true", help="print the edge model/evidence/fused score per scenario")
    parser.add_argument("--no-render", action="store_true", help="rewrite JSON only; keep existing JPEGs")
    args = parser.parse_args()
    write_fixtures(render=not args.no_render)
    if args.report:
        report()


if __name__ == "__main__":
    main()
