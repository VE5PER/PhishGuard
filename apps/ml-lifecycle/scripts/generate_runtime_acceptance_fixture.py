import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import onnxruntime as ort

from phishguard_ml_engine.data.page_context import prepare_page_context
from phishguard_ml_engine.data.trajectory_preprocessor import prepare_trajectory


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Runtime fixture is immutable")
    session = ort.InferenceSession(str(args.model), providers=["CPUExecutionProvider"])

    def event(identity, control="none", **overrides):
        return dict(
            eventType="click", targetBoundingBox=dict(x=10, y=10, width=200, height=48),
            isZeroOpacity=control != "none", isCrossOriginIframe=False, isPasswordInput=False,
            isPasteIntoPassword=False, elementSelector="div", timestamp=100,
            evidenceId=identity, evidenceSource="topology_scan", isHitTestIntercepting=control != "none",
            coveredControlType=control, credentialFrameEvidence="none", **overrides,
        )

    submit = event("submit-control", "submit")
    password = event("password-control", "password")
    foreign = event("foreign-frame")
    foreign.update(isCrossOriginIframe=True, credentialFrameEvidence="unverified")
    paste = event("password-paste")
    paste.update(eventType="paste", evidenceSource="observed_interaction", isPasswordInput=True, isPasteIntoPassword=True)
    hidden = event("animated-section")
    hidden.update(isZeroOpacity=True)
    pointers = [dict(x=0.1 + i * 0.01, y=0.2 + i * 0.005, dx=200, dy=100, velocity=10,
                     acceleration=0, angle=0.5, timestamp=i * 10, eventType="move") for i in range(16)]
    specs = [
        ("sample1", "/sample1/", True, [], [], False, "SAFE"),
        ("sample2", "/sample2/", True, [submit], [], False, "AMBIGUOUS"),
        ("sample2_repeated", "/sample2/", True, [submit] * 8 + [paste] * 8, [], False, "AMBIGUOUS"),
        ("sample3", "/sample3/", True, [password, submit, foreign], [], False, "BLOCK"),
        ("landing_white", "/", False, [hidden, foreign], [], True, "SAFE"),
        ("brand_article", "/articles/apple?contact=reader@example.test", False, [], pointers, True, "SAFE"),
    ]
    cases = []
    for name, path, credential, events, points, visual_present, expected in specs:
        for scheme in ("http", "https"):
            payload = dict(telemetryId="11111111-1111-4111-8111-111111111111",
                           url=f"{scheme}://localhost:8010{path}", domain="localhost", pageTitle=name,
                           sessionDurationMs=1000, pointerSeries=points, keystrokes=[], domEvents=events,
                           hasCredentialField=credential, clientTimestamp="2026-10-11T00:00:00.000Z")
            prepared = prepare_trajectory(points)
            page = prepare_page_context(payload, prepared, visual_present)
            trajectory = prepared.tensor if prepared.available else np.zeros((128, 6), np.float32)
            visual = np.ones((3, 64, 64), np.float32) if visual_present else np.zeros((3, 64, 64), np.float32)
            score = float(session.run(None, dict(trajectory=trajectory[None], visual=visual[None],
                                               page_context=page["context"][None]))[0][0, 0])
            cases.append(dict(name=f"{name}_{scheme}", pair=name, expectedAction=expected,
                              payload=payload, visualPresent=visual_present, expectedModelScore=score))
    payload = dict(telemetryId="22222222-2222-4222-8222-222222222222", url="https://login.yahoo.com/login",
                   domain="login.yahoo.com", pageTitle="Synthetic official-host login",
                   sessionDurationMs=1000, pointerSeries=pointers, keystrokes=[], domEvents=[paste, foreign],
                   hasCredentialField=True, clientTimestamp="2026-10-11T00:00:00.000Z")
    prepared = prepare_trajectory(pointers)
    page = prepare_page_context(payload, prepared, True)
    score = float(session.run(None, dict(trajectory=prepared.tensor[None], visual=np.ones((1, 3, 64, 64), np.float32),
                                       page_context=page["context"][None]))[0][0, 0])
    cases.append(dict(name="synthetic_official_yahoo_login", pair=None, expectedAction="SAFE",
                      payload=payload, visualPresent=True, expectedModelScore=score))
    fixture = dict(format="student-runtime-fixture-v2", modelSha256=hashlib.sha256(args.model.read_bytes()).hexdigest(),
                   scope="Constructed local fixtures, not real Yahoo or browser captures", cases=cases)
    args.output.write_text(json.dumps(fixture, indent=2, allow_nan=False) + "\n")
    print(json.dumps(dict(modelSha256=fixture["modelSha256"], cases=len(cases), path=str(args.output))))


if __name__ == "__main__":
    main()
