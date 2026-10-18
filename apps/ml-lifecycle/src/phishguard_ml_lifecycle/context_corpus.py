import hashlib
import json
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import numpy as np
import torch
from PIL import Image, ImageEnhance
from torch.utils.data import Dataset

from phishguard_ml_engine.data.page_context import prepare_page_context, evaluate_evidence_risk
from phishguard_ml_engine.data.trajectory_preprocessor import prepare_trajectory
from .dataset import viewport_to_student_tensor


SCENARIOS = (
    ("benign_login", 0),
    ("benign_paste", 0),
    ("benign_hidden_animation", 0),
    ("benign_ad_frame", 0),
    ("benign_brand_article", 0),
    ("benign_content", 0),
    ("benign_brand_host", 0),
    ("deceptive_authority", 1),
    ("credential_submit_interception", 1),
    ("corroborated_frame_interception", 1),
    ("ambiguous_submit_overlay", None),
    ("ambiguous_credential_overlay", None),
    ("ambiguous_authority_without_credentials", None),
)
MODES = ("full", "no_visual", "no_trajectory", "sparse", "neither")
THEMES = ("original", "bright", "dark", "white")


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def scenario_payload(scenario: str, site: str, pointer_series: list[dict[str, Any]]) -> dict[str, Any]:
    def event(identity: str, control: str) -> dict[str, Any]:
        return dict(
            evidenceSource="topology_scan", evidenceId=identity, isZeroOpacity=True,
            isHitTestIntercepting=True, coveredControlType=control, credentialFrameEvidence="none",
            isCrossOriginIframe=False, isPasswordInput=False, isPasteIntoPassword=False,
            elementSelector="div",
        )

    payload = dict(url=f"https://{site}/login", domain=site, hasCredentialField=True,
                   domEvents=[], pointerSeries=pointer_series)
    if scenario == "deceptive_authority":
        payload["url"] = f"https://accounts.google.com@{site}/login"
    elif scenario == "credential_submit_interception":
        payload["domEvents"] = [event("credential", "password"), event("submit", "submit")]
    elif scenario == "corroborated_frame_interception":
        payload["domEvents"] = [
            event("credential", "password"),
            dict(evidenceSource="observed_interaction", evidenceId="foreign-credential",
                 credentialFrameEvidence="observed", isCrossOriginIframe=True, isPasswordInput=True,
                 isZeroOpacity=False, isHitTestIntercepting=False, coveredControlType="none",
                 isPasteIntoPassword=False, elementSelector="input"),
        ]
    elif scenario == "benign_hidden_animation":
        payload["domEvents"] = [
            dict(evidenceSource="topology_scan", evidenceId=f"hidden-{i}", isZeroOpacity=True,
                 isHitTestIntercepting=False, coveredControlType="none", credentialFrameEvidence="none",
                 isCrossOriginIframe=False, isPasswordInput=False, isPasteIntoPassword=False, elementSelector="div")
            for i in range(5)
        ]
    elif scenario == "benign_ad_frame":
        payload["domEvents"] = [
            dict(evidenceSource="topology_scan", evidenceId="ad", isZeroOpacity=False,
                 isHitTestIntercepting=False, coveredControlType="none", credentialFrameEvidence="unverified",
                 isCrossOriginIframe=True, isPasswordInput=False, isPasteIntoPassword=False, elementSelector="iframe")
        ]
    elif scenario == "benign_paste":
        payload["domEvents"] = [
            dict(evidenceSource="observed_interaction", evidenceId="password", isZeroOpacity=False,
                 isHitTestIntercepting=False, coveredControlType="none", credentialFrameEvidence="none",
                 isCrossOriginIframe=False, isPasswordInput=True, isPasteIntoPassword=True, elementSelector="input")
        ] * 8
    elif scenario == "benign_brand_article":
        payload["url"] = f"https://{site}/articles/apple-google-paypal?contact=reader@example.test"
        payload["hasCredentialField"] = False
    elif scenario == "benign_content":
        payload["hasCredentialField"] = False
    elif scenario == "benign_brand_host":
        payload["domain"] = f"microsoft-community-{site}"
        payload["url"] = f"https://{payload['domain']}/login"
    elif scenario == "ambiguous_submit_overlay":
        payload["domEvents"] = [event("submit", "submit")]
    elif scenario == "ambiguous_credential_overlay":
        payload["domEvents"] = [event("credential", "password")]
    elif scenario == "ambiguous_authority_without_credentials":
        payload["url"] = f"https://accounts.google.com@{site}/"
        payload["hasCredentialField"] = False
    elif scenario != "benign_login":
        raise ValueError(f"Unknown scenario {scenario}")
    return payload


def load_repository_sources(root: Path) -> list[dict[str, Any]]:
    sources = []
    seen: set[str] = set()
    for dataset in ("phishguard_multimodal_sota", "phishguard_industrial_benchmark"):
        for split in ("train", "val", "test"):
            directory = root / "data" / dataset / split
            jsonl = directory / "samples.jsonl"
            if not jsonl.exists():
                continue
            for line in jsonl.read_text().splitlines():
                record = json.loads(line)
                identity = record["sampleId"]
                image = directory / "screens" / f"{identity}.png"
                host = urlsplit(record["url"]).hostname
                if not host or not image.exists() or identity in seen:
                    continue
                seen.add(identity)
                sources.append(dict(
                    base_id=identity, group=host.lower().rstrip("."), image=str(image.relative_to(root)),
                    image_hash=hashlib.sha256(image.read_bytes()).hexdigest(), pointer_series=record["pointerSeries"],
                    source="repository_synthetic", original_label_used=False,
                ))
    if not sources:
        raise ValueError("No existing repository image/trajectory sources")
    return sources


def build_context_corpus(root: Path, seed: int = 42, max_sources: int = 128) -> dict[str, Any]:
    sources = load_repository_sources(root)
    parents = {source["group"]: source["group"] for source in sources}

    def find(group: str) -> str:
        while parents[group] != group:
            parents[group] = parents[parents[group]]
            group = parents[group]
        return group

    image_groups: dict[str, str] = {}
    for source in sources:
        host = source["group"]
        previous = image_groups.setdefault(source["image_hash"], host)
        left, right = find(host), find(previous)
        if left != right:
            parents[max(left, right)] = min(left, right)
    for source in sources:
        source["group"] = find(source["group"])
    groups = sorted({source["group"] for source in sources},
                    key=lambda group: hashlib.sha256(f"{seed}:{group}".encode()).hexdigest())
    if len(groups) < 10:
        raise ValueError("Insufficient independent source hostname groups")
    train_end, val_end = int(len(groups) * 0.70), int(len(groups) * 0.85)
    assignments = {group: "train" if i < train_end else "val" if i < val_end else "test"
                   for i, group in enumerate(groups)}
    sources.sort(key=lambda source: hashlib.sha256(f"{seed}:{source['base_id']}".encode()).hexdigest())
    selected = []
    limits = {"train": max(1, int(max_sources * 0.70)), "val": max(1, int(max_sources * 0.15)),
              "test": max_sources - int(max_sources * 0.70) - int(max_sources * 0.15)}
    counts = dict.fromkeys(limits, 0)
    for source in sources:
        split = assignments[source["group"]]
        if counts[split] < limits[split]:
            selected.append({**source, "split": split})
            counts[split] += 1
    if any(count == 0 for count in counts.values()):
        raise ValueError("Corpus does not cover all splits")
    records = []
    for source in selected:
        site = f"site-{hashlib.sha256(source['group'].encode()).hexdigest()[:16]}.test"
        for scenario, label in SCENARIOS:
            for mode in MODES:
                for theme in THEMES:
                    record_id = f"{source['base_id']}:{scenario}:{mode}:{theme}"
                    records.append(dict(
                        record_id=record_id, base_id=source["base_id"], group=source["group"],
                        split=source["split"], scenario=scenario, label=label, mode=mode, theme=theme,
                        target=0.5 if label is None else label,
                        expected_route="AMBIGUOUS" if label is None else "BLOCK" if label else "SAFE",
                        site=site, image=source["image"], image_hash=source["image_hash"],
                        pointer_series=source["pointer_series"], provenance=dict(
                            sourceType="synthetic", labelSource="synthetic_scenario",
                            labelConfidence=0.0 if label is None else 1.0,
                            labelReason=f"Constructed offline {'uncertainty regularizer' if label is None else 'scenario'}: {scenario}",
                            original_label_used=False,
                        ),
                    ))
    manifest = dict(
        format="student-context-corpus-v2", seed=seed, basis="repository_synthetic",
        class_prior_note="Constructed scenario frequencies, not a web population prior",
        limitations=["Synthetic visual and behavioral sources", "No independently observed Yahoo captures",
                     "Constructed attack scenarios do not estimate general phishing recall"],
        source_counts=counts, group_count=len({source["group"] for source in selected}),
        records=records,
    )
    manifest["digest"] = hashlib.sha256(canonical_json(manifest)).hexdigest()
    audit_context_corpus(manifest)
    return manifest


def audit_context_corpus(manifest: dict[str, Any]) -> None:
    expected = hashlib.sha256(canonical_json({k: v for k, v in manifest.items() if k != "digest"})).hexdigest()
    if manifest.get("digest") != expected:
        raise ValueError("Corpus digest mismatch")
    ownership: dict[tuple[str, str], str] = {}
    labels: dict[str, set[int]] = {}
    identities: set[str] = set()
    for record in manifest["records"]:
        if record["record_id"] in identities:
            raise ValueError("Duplicate record")
        identities.add(record["record_id"])
        for kind, identity in (("base", record["base_id"]), ("host", record["group"]), ("image", record["image_hash"])):
            key = kind, identity
            if key in ownership and ownership[key] != record["split"]:
                raise ValueError(f"Cross-split {kind} leakage")
            ownership[key] = record["split"]
        if (record["scenario"], record["label"]) not in SCENARIOS:
            raise ValueError("Scenario label mismatch")
        if record["label"] is not None:
            labels.setdefault(record["split"], set()).add(record["label"])
    if labels != {"train": {0, 1}, "val": {0, 1}, "test": {0, 1}}:
        raise ValueError("Split missing label coverage")


class ContextStudentDataset(Dataset):
    def __init__(self, root: Path, manifest: dict[str, Any], split: str):
        audit_context_corpus(manifest)
        self.root = root.resolve()
        self.records = [record for record in manifest["records"] if record["split"] == split]
        if not self.records:
            raise ValueError(f"Empty split {split}")
        self.images: dict[tuple[str, str], torch.Tensor] = {}

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, index: int):
        record = self.records[index]
        points = record["pointer_series"]
        if record["mode"] in ("no_trajectory", "neither"):
            points = []
        elif record["mode"] == "sparse":
            points = points[:1]
        trajectory = prepare_trajectory(points)
        tensor = trajectory.tensor if trajectory.available else np.zeros((128, 6), np.float32)
        has_visual = record["mode"] not in ("no_visual", "neither")
        key = record["image_hash"], record["theme"]
        if has_visual and key not in self.images:
            path = (self.root / record["image"]).resolve()
            if not path.is_relative_to(self.root):
                raise ValueError("Image outside repository")
            if hashlib.sha256(path.read_bytes()).hexdigest() != record["image_hash"]:
                raise ValueError("Source image changed")
            with Image.open(path) as image:
                image = image.convert("RGB")
                if record["theme"] == "bright":
                    image = ImageEnhance.Brightness(image).enhance(1.4)
                elif record["theme"] == "dark":
                    image = ImageEnhance.Brightness(image).enhance(0.35)
                elif record["theme"] == "white":
                    image = Image.new("RGB", image.size, "white")
                self.images[key] = viewport_to_student_tensor(image)
        visual = self.images[key] if has_visual else torch.zeros(3, 64, 64)
        payload = scenario_payload(record["scenario"], record["site"], points)
        page = prepare_page_context(payload, trajectory, has_visual)
        if not page["available"]:
            raise ValueError("Invalid scenario page context")
        return (torch.from_numpy(tensor), visual, torch.from_numpy(page["context"]),
                torch.tensor([record["target"]], dtype=torch.float32),
                torch.tensor([evaluate_evidence_risk(page)["score"]], dtype=torch.float32))
