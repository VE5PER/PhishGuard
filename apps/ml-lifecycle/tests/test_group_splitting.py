import pytest

from phishguard_ml_lifecycle.group_splitting import split_grouped_samples


def test_ordered_classes_and_variants_cannot_leak_hosts():
    samples = [
        dict(sampleId=f"{label}-{site}-{variant}", label=float(label),
             url=f"https://site-{label}-{site}.test/login?variant={variant}")
        for label in (1, 0) for site in range(12) for variant in range(3)
    ]
    splits = split_grouped_samples(samples, (0.7, 0.15, 0.15))
    assert sum(map(len, splits.values())) == len(samples)
    owners = {}
    for split, records in splits.items():
        assert {record["label"] for record in records} == {0.0, 1.0}
        for record in records:
            hostname = record["url"].split("/")[2]
            assert owners.setdefault(hostname, split) == split
    assert splits == split_grouped_samples(samples, (0.7, 0.15, 0.15))


def test_split_fails_when_group_coverage_cannot_support_classes():
    with pytest.raises(ValueError, match="Insufficient"):
        split_grouped_samples([dict(label=0, url="https://only.test/")], (0.7, 0.15, 0.15))
    with pytest.raises(ValueError, match="ratios"):
        split_grouped_samples([], (0.5, 0.5, 0.5))


def test_base_variants_and_hosts_both_define_split_identity():
    samples = [
        dict(sampleId=f"{label}-{site}-{variant}", label=float(label),
             url=f"https://host-{label}-{site}-{variant}.test/",
             provenance={"baseSampleId": f"base-{label}-{site}", "groupId": f"variant-{label}-{site}-{variant}"})
        for label in (0, 1) for site in range(9) for variant in range(2)
    ]
    owners = {}
    for split, records in split_grouped_samples(samples, (0.7, 0.15, 0.15)).items():
        for record in records:
            base = record["provenance"]["baseSampleId"]
            assert owners.setdefault(base, split) == split
