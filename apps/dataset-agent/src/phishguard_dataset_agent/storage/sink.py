"""Storage sink for daily dataset archiving and ML lifecycle promotion."""

from datetime import datetime, timezone
import json
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from phishguard_types import MultimodalDatasetSample
from phishguard_ml_lifecycle.dataset_storage import store_multimodal_dataset
from ..collector.sample_builder import DatasetSampleBuilder

logger = logging.getLogger(__name__)


class DatasetSink:
    """Manages disk persistence and ML lifecycle export of daily dataset batches."""

    def __init__(
        self,
        output_dir: Path,
        lifecycle_dataset_dir: Optional[Path] = None,
        export_to_ml_lifecycle: bool = True,
    ):
        self.output_dir = Path(output_dir)
        self.lifecycle_dataset_dir = Path(lifecycle_dataset_dir) if lifecycle_dataset_dir else None
        self.export_to_ml_lifecycle = export_to_ml_lifecycle
        self.builder = DatasetSampleBuilder()

    def persist_daily_batch(
        self,
        samples: List[MultimodalDatasetSample],
        date_str: Optional[str] = None,
        extra_meta: Optional[Dict[str, Any]] = None,
        research_artifacts: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Save daily batch into structured JSONL archive and optional ML lifecycle format."""
        if not date_str:
            date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        batch_dir = self.output_dir / date_str
        batch_dir.mkdir(parents=True, exist_ok=True)

        jsonl_file = batch_dir / "samples.jsonl"
        meta_file = batch_dir / "meta.json"

        phish_count = 0
        benign_count = 0
        unknown_count = 0
        brands_seen = set()
        storage_dicts: List[Dict[str, Any]] = []
        training_dicts: List[Dict[str, Any]] = []

        with open(jsonl_file, "w", encoding="utf-8") as f_out:
            for s in samples:
                if s.label == 0.5:
                    unknown_count += 1
                elif s.label > 0.5:
                    phish_count += 1
                else:
                    benign_count += 1

                if s.targetBrand:
                    brands_seen.add(s.targetBrand.value)

                s_dict = self.builder.to_storage_dict(s)
                storage_dicts.append(s_dict)
                provenance = s.provenance
                if (
                    provenance
                    and s.label in (0.0, 1.0)
                    and provenance.labelSource in ("manual_fixture", "verified_feed")
                    and provenance.labelConfidence >= 0.95
                    and provenance.sourceType != "repository_fixture"
                ):
                    training_dicts.append(s_dict)
                f_out.write(json.dumps(s_dict) + "\n")

        summary_meta = {
            "date": date_str,
            "total_samples": len(samples),
            "phishing_count": phish_count,
            "benign_count": benign_count,
            "unknown_count": unknown_count,
            "phishing_ratio": round(phish_count / max(1, len(samples)), 4),
            "brands_covered": sorted(list(brands_seen)),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "jsonl_path": str(jsonl_file),
            "training_eligible_samples": len(training_dicts),
            "withheld_training_samples": len(storage_dicts) - len(training_dicts),
        }
        if extra_meta:
            summary_meta.update(extra_meta)

        with open(meta_file, "w", encoding="utf-8") as f_meta:
            json.dump(summary_meta, f_meta, indent=2)

        if research_artifacts:
            research_file = batch_dir / "research.json"
            with open(research_file, "w", encoding="utf-8") as f_research:
                json.dump(research_artifacts, f_research, indent=2, default=str)

        logger.info(
            "Archived daily batch %s: %d samples (%d phish, %d benign) -> %s",
            date_str, len(samples), phish_count, benign_count, jsonl_file,
        )

        # Export directly to ML training format if enabled
        if self.export_to_ml_lifecycle and self.lifecycle_dataset_dir and training_dicts:
            try:
                manifest = store_multimodal_dataset(
                    output_dir=self.lifecycle_dataset_dir,
                    samples=training_dicts,
                    dataset_name="phishguard-multimodal-daily-aggregated",
                    dataset_version=f"daily-{date_str}",
                    save_images=False,
                )
                summary_meta["ml_lifecycle_manifest"] = manifest.model_dump()
                logger.info("Successfully exported daily batch to ML lifecycle training format: %s", self.lifecycle_dataset_dir)
            except Exception as exc:
                logger.error("Failed to export to ML lifecycle dataset storage: %s", exc)
                summary_meta["ml_lifecycle_error"] = str(exc)

        return summary_meta

    def get_status(self) -> Dict[str, Any]:
        """Inspect storage directory and return aggregated metrics."""
        if not self.output_dir.exists():
            return {
                "exists": False,
                "total_batches": 0,
                "total_samples": 0,
                "latest_batch": None,
            }

        batch_dirs = [d for d in self.output_dir.iterdir() if d.is_dir()]
        total_samples = 0
        latest_date = None
        latest_info = None

        for b_dir in sorted(batch_dirs):
            meta_path = b_dir / "meta.json"
            if meta_path.exists():
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        total_samples += data.get("total_samples", 0)
                        latest_date = b_dir.name
                        latest_info = data
                except Exception:
                    pass

        return {
            "exists": True,
            "output_dir": str(self.output_dir),
            "total_batches": len(batch_dirs),
            "total_samples": total_samples,
            "latest_batch_date": latest_date,
            "latest_batch": latest_info,
        }
