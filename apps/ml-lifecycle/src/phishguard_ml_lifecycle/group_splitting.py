import hashlib
import json
from typing import Any
from urllib.parse import urlsplit


def split_grouped_samples(
    samples: list[dict[str, Any]], ratios: tuple[float, float, float], seed: int = 42,
) -> dict[str, list[dict[str, Any]]]:
    if len(ratios) != 3 or any(value <= 0 for value in ratios) or abs(sum(ratios) - 1) > 1e-8:
        raise ValueError("Split ratios must be positive and sum to one")
    parents = list(range(len(samples)))

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    owners: dict[tuple[str, str], int] = {}
    for index, sample in enumerate(samples):
        provenance = sample.get("provenance") or {}
        hostname = urlsplit(sample.get("url", "")).hostname
        identities = [
            ("host", hostname.lower().rstrip(".")) if hostname else None,
            ("group", provenance["groupId"]) if provenance.get("groupId") else None,
            ("base", provenance["baseSampleId"]) if provenance.get("baseSampleId") else None,
        ]
        if not any(identities):
            raise ValueError("Sample needs a hostname or explicit provenance group")
        for identity in identities:
            if identity is None:
                continue
            previous = owners.setdefault(identity, index)
            left, right = find(index), find(previous)
            if left != right:
                parents[max(left, right)] = min(left, right)
    groups: dict[str, list[dict[str, Any]]] = {}
    for index, sample in enumerate(samples):
        groups.setdefault(str(find(index)), []).append(sample)
    stable_groups = {}
    for members in groups.values():
        identifiers = set()
        for sample in members:
            provenance = sample.get("provenance") or {}
            host = urlsplit(sample.get("url", "")).hostname
            if host:
                identifiers.add(("host", host.lower().rstrip(".")))
            for key in ("groupId", "baseSampleId"):
                if provenance.get(key):
                    identifiers.add((key, provenance[key]))
        key = hashlib.sha256(json.dumps(sorted(identifiers), separators=(",", ":")).encode()).hexdigest()
        stable_groups[key] = members
    groups = stable_groups
    split_names = ("train", "val", "test")
    output: dict[str, list[dict[str, Any]]] = {name: [] for name in split_names}
    targets = {name: len(samples) * ratio for name, ratio in zip(split_names, ratios)}
    memberships: dict[str, set[int]] = {
        group: {int(float(sample["label"]) >= 0.5) for sample in members}
        for group, members in groups.items()
    }
    class_groups = {label: {group for group, labels in memberships.items() if label in labels} for label in (0, 1)}
    if any(len(identities) < 3 for identities in class_groups.values()):
        raise ValueError("Insufficient hostname groups for class-covered independent splits")
    ordering = sorted(groups, key=lambda group: (-len(groups[group]), hashlib.sha256(f"{seed}:{group}".encode()).hexdigest()))
    owned: set[str] = set()
    coverage = {name: set() for name in split_names}
    for name in ("test", "val", "train"):
        for label in (0, 1):
            if label in coverage[name]:
                continue
            group = next((group for group in reversed(ordering) if group not in owned and label in memberships[group]), None)
            if group is None:
                raise ValueError("Cannot construct independent class-covered splits")
            output[name].extend(groups[group])
            coverage[name].update(memberships[group])
            owned.add(group)
    for group in ordering:
        if group in owned:
            continue
        name = max(split_names, key=lambda name: (targets[name] - len(output[name])) / targets[name])
        output[name].extend(groups[group])
        owned.add(group)
    return output
