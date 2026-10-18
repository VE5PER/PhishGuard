"""Tests for dataset storage sink and ML lifecycle export."""

import json
from pathlib import Path
from phishguard_dataset_agent.collector.models import FetchedPageMetadata
from phishguard_dataset_agent.collector.sample_builder import DatasetSampleBuilder
from phishguard_dataset_agent.storage.sink import DatasetSink
from phishguard_types.dataset import DatasetProvenance


def test_dataset_sink_persist_and_inspect(temp_output_dir: Path, temp_lifecycle_dir: Path):
    builder = DatasetSampleBuilder(seed=42)
    meta = FetchedPageMetadata(
        url="https://login.example.com",
        final_url="https://login.example.com",
        domain="example.com",
    )
    samples = [
        builder.build_sample(meta, label=0.0, target_brand_name="Google"),
        builder.build_sample(meta, label=1.0, target_brand_name="Microsoft"),
        builder.build_sample(meta, label=1.0, target_brand_name="PayPal"),
    ]

    sink = DatasetSink(
        output_dir=temp_output_dir,
        lifecycle_dataset_dir=temp_lifecycle_dir,
        export_to_ml_lifecycle=True,
    )

    summary = sink.persist_daily_batch(samples, date_str="2026-10-07")
    assert summary["date"] == "2026-10-07"
    assert summary["total_samples"] == 3
    assert summary["phishing_count"] == 2
    assert summary["benign_count"] == 1

    # Check files on disk
    batch_dir = temp_output_dir / "2026-10-07"
    assert (batch_dir / "samples.jsonl").exists()
    assert (batch_dir / "meta.json").exists()

    with open(batch_dir / "samples.jsonl", "r", encoding="utf-8") as f:
        lines = f.readlines()
        assert len(lines) == 3

    # Check ML lifecycle export files
    assert summary["training_eligible_samples"] == 0
    assert summary["withheld_training_samples"] == 3
    assert not (temp_lifecycle_dir / "dataset_manifest.json").exists()
    assert not (temp_lifecycle_dir / "train" / "tensors.npz").exists()

    # Check storage status inspection
    status = sink.get_status()
    assert status["exists"] is True
    assert status["total_batches"] == 1
    assert status["total_samples"] == 3
    assert status["latest_batch_date"] == "2026-10-07"


def test_explicit_fixture_labels_export_with_independent_class_groups(temp_output_dir: Path, temp_lifecycle_dir: Path):
    builder = DatasetSampleBuilder(seed=42)
    samples = []
    for label in (0.0, 1.0):
        for index in range(3):
            hostname = f"class-{int(label)}-base-{index}.test"
            url = f"https://{hostname}/login"
            meta = FetchedPageMetadata(url=url, final_url=url, domain=hostname)
            samples.append(builder.build_sample(
                meta, label=label,
                provenance=DatasetProvenance(
                    sourceType="synthetic", labelSource="manual_fixture", labelConfidence=1.0,
                    labelReason="Explicit storage-unit fixture; not observed browsing",
                    groupId=hostname, baseSampleId=hostname,
                    modalities={"url": "synthetic", "hid": "synthetic", "dom": "synthetic",
                                "visual": "missing", "logo": "missing"},
                ),
            ))
    sink = DatasetSink(
        output_dir=temp_output_dir, lifecycle_dataset_dir=temp_lifecycle_dir,
        export_to_ml_lifecycle=True,
    )
    summary = sink.persist_daily_batch(samples, date_str="2026-10-07")
    assert summary["total_samples"] == 6
    assert summary["training_eligible_samples"] == 6
    assert summary["withheld_training_samples"] == 0
    assert (temp_lifecycle_dir / "dataset_manifest.json").exists()
    split_hosts = []
    for name in ("train", "val", "test"):
        assert (temp_lifecycle_dir / name / "tensors.npz").exists()
        records = [json.loads(line) for line in (temp_lifecycle_dir / name / "samples.jsonl").read_text().splitlines()]
        assert {record["label"] for record in records} == {0.0, 1.0}
        split_hosts.append({record["domain"] for record in records})
    assert not (split_hosts[0] & split_hosts[1] or split_hosts[0] & split_hosts[2] or split_hosts[1] & split_hosts[2])


def _sample_with_provenance(builder, url, label, source_type, label_source, confidence):
    meta = FetchedPageMetadata(url=url, final_url=url, domain=url.split("//")[1].split("/")[0])
    return builder.build_sample(
        meta, label=label,
        provenance=DatasetProvenance(
            sourceType=source_type, labelSource=label_source, labelConfidence=confidence,
            labelReason="test fixture", groupId=meta.domain,
            modalities={"url": "observed", "hid": "synthetic", "dom": "synthetic",
                        "visual": "missing", "logo": "missing"},
        ),
    )


def test_fixture_and_research_labels_withheld_and_research_json_written(temp_output_dir: Path, temp_lifecycle_dir: Path):
    builder = DatasetSampleBuilder(seed=42)
    samples = []
    # 3 phishing + 3 benign eligible public_feed groups (split requires >=3 per class)
    for i in range(3):
        samples.append(_sample_with_provenance(
            builder, f"https://feed-phish-{i}.example/x", 1.0, "public_feed", "verified_feed", 0.97))
        samples.append(_sample_with_provenance(
            builder, f"https://feed-benign-{i}.example/", 0.0, "public_feed", "verified_feed", 0.95))
    withheld = [
        _sample_with_provenance(builder, "https://seed-bad.example/x", 1.0, "repository_fixture", "verified_feed", 0.97),
        _sample_with_provenance(builder, "https://research-bad.example/x", 1.0, "research_agent", "llm_research", 0.6),
        _sample_with_provenance(builder, "https://h.example/x", 1.0, "fetched_metadata", "heuristic", 0.9),
    ]

    sink = DatasetSink(
        output_dir=temp_output_dir,
        lifecycle_dataset_dir=temp_lifecycle_dir,
        export_to_ml_lifecycle=True,
    )
    artifacts = {
        "interactions": [{"id": "ix-1", "status": "completed", "topic_id": "new_phishing_datasets"}],
        "discovered_sources": [{"name": "NewFeed"}],
        "url_findings": [{"url": "https://research-bad.example/x"}],
    }
    summary = sink.persist_daily_batch(samples + withheld, date_str="2026-10-13", research_artifacts=artifacts)

    # Only the verified public_feed samples are training-eligible.
    assert summary["training_eligible_samples"] == 6
    assert summary["withheld_training_samples"] == 3
    assert (temp_lifecycle_dir / "dataset_manifest.json").exists()
    exported_domains = set()
    for split in ("train", "val", "test"):
        exported_domains |= {
            r["domain"] for r in
            (json.loads(line) for line in (temp_lifecycle_dir / split / "samples.jsonl").read_text().splitlines())
        }
    assert exported_domains == {f"feed-phish-{i}.example" for i in range(3)} | {f"feed-benign-{i}.example" for i in range(3)}

    batch_dir = temp_output_dir / "2026-10-13"
    assert (batch_dir / "research.json").exists()
    written = json.loads((batch_dir / "research.json").read_text())
    assert written["interactions"][0]["status"] == "completed"
    assert len(written["url_findings"]) == 1


def test_no_research_json_without_artifacts(temp_output_dir: Path, temp_lifecycle_dir: Path):
    builder = DatasetSampleBuilder(seed=42)
    samples = [_sample_with_provenance(builder, "https://a.example/x", 1.0, "mock", "heuristic", 0.5)]
    sink = DatasetSink(output_dir=temp_output_dir, lifecycle_dataset_dir=temp_lifecycle_dir, export_to_ml_lifecycle=False)
    sink.persist_daily_batch(samples, date_str="2026-10-13")
    assert not (temp_output_dir / "2026-10-13" / "research.json").exists()
