import json
from pathlib import Path

from phishguard_ml_engine.data.trajectory_preprocessor import prepare_trajectory
from phishguard_ml_engine.data.page_context import BRAND_DOMAINS, PAGE_CONTEXT_FEATURES, prepare_page_context, evaluate_evidence_risk


def main():
    root = Path(__file__).resolve().parents[3]
    path = root / "apps/extension/tests/fixtures/runtime_features_v2.json"
    if path.exists():
        raise FileExistsError("Golden fixture already exists; do not silently regenerate expected results")
    point = lambda x, t: dict(x=x, y=0.3, timestamp=t, dx=100, dy=200, velocity=1,
                             acceleration=0, angle=1, eventType="move")
    sequences = dict(
        empty=[], one=[point(0.2, 10)], two=[point(0.1, 0), point(0.8, 100)],
        duplicate=[point(0.1, 0), point(0.2, 0), point(0.7, 100)],
        backward=[point(0.1, 20), point(0.2, 10)],
        out_of_bounds=[point(1.1, 10)],
        stationary=[point(0.2, i * 10) for i in range(128)],
        sixteen=[point(0.1 + i * 0.02, i * 12) for i in range(16)],
        full=[point(0.1 + i * 0.002, i * 13) for i in range(128)],
        rolling=[point(0.1 + i * 0.002, i * 11) for i in range(256)],
    )
    cases = []
    for name, points in sequences.items():
        prepared = prepare_trajectory(points)
        cases.append(dict(name=name, points=points, expected=prepared.tensor.reshape(-1).tolist(),
                          validPointCount=prepared.valid_point_count, durationMs=prepared.duration_ms,
                          available=prepared.available, invalidReason=prepared.invalid_reason))
    pages = []
    for url in [
        "https://login.yahoo.com/login", "https://microsoft.com.evil.test/login",
        "https://pineapple.test/login", "https://news.test/google?user=a@b.test",
        "https://accounts.google.com@evil.test/login", "http://[::1]:8010/login",
        "https://bücher.example/login",
    ]:
        from urllib.parse import urlsplit
        payload = dict(url=url, domain=urlsplit(url).hostname, domEvents=[], hasCredentialField=True)
        prepared = prepare_trajectory(sequences["sixteen"])
        page = prepare_page_context(payload, prepared, True)
        policy = evaluate_evidence_risk(page)
        pages.append(dict(payload=payload, context=page["context"].tolist(),
                          available=page["available"], evidenceScore=policy["score"], ruleIds=policy["rule_ids"]))
    path.write_text(json.dumps(dict(brands=BRAND_DOMAINS, features=PAGE_CONTEXT_FEATURES,
                                    trajectories=cases, pages=pages), indent=2, allow_nan=False) + "\n")


if __name__ == "__main__":
    main()
