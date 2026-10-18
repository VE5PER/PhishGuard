"""Command-line interface for ML lifecycle operations."""

import argparse
import json
from pathlib import Path
import sys

from .checkpoint_manager import CheckpointManager
from .training_pipeline import TrainingPipeline
from .evaluator import ModelEvaluator
from .export_pipeline import ModelExportPipeline
from .promotion import ModelPromoter


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="phishguard-ml",
        description="PhishGuard ML Lifecycle, Checkpoint Management & Deployment CLI",
    )
    subparsers = parser.add_subparsers(dest="command", help="Lifecycle command to execute")

    # Command: extract-dataset
    extract_parser = subparsers.add_parser(
        "extract-dataset",
        help="Extract and store multimodal dataset supporting URL, HID, Logo, Screen, and Detection",
    )
    extract_parser.add_argument(
        "--output",
        type=str,
        default="data/phishguard_multimodal_sota",
        help="Target output directory for the dataset",
    )
    extract_parser.add_argument("--samples", type=int, default=1000, help="Total number of samples to generate/extract")
    extract_parser.add_argument(
        "--benchmark",
        type=str,
        default="synthetic",
        choices=["synthetic", "industrial"],
        help="Dataset source: synthetic generator or industrial benchmark (PhishTank/OpenPhish/Tranco/Phishpedia)",
    )
    extract_parser.add_argument("--no-images", action="store_true", help="Skip saving raw PNG screenshots")
    extract_parser.add_argument("--seed", type=int, default=42, help="Random generator seed for reproducibility")

    # Command: train
    train_parser = subparsers.add_parser("train", help="Run student training, distillation, or SOTA multimodal training")
    train_parser.add_argument("--config", type=str, default=None, help="Path to JSON config file")
    train_parser.add_argument("--epochs", type=int, default=5, help="Number of training epochs")
    train_parser.add_argument("--samples", type=int, default=128, help="Number of synthetic samples (if dataset not used)")
    train_parser.add_argument("--distill", action="store_true", help="Run teacher distillation mode")
    train_parser.add_argument("--dataset", type=str, default=None, help="Path to stored multimodal dataset directory")
    train_parser.add_argument("--sota", action="store_true", help="Train 5-stream SOTA multimodal model")
    train_parser.add_argument("--context", action="store_true", help="Train context student from a frozen corpus manifest")

    # Command: evaluate
    eval_parser = subparsers.add_parser("evaluate", help="Evaluate checkpoint against deployment gates")
    eval_parser.add_argument("--checkpoint", type=str, required=True, help="Path to checkpoint .pt")
    eval_parser.add_argument("--samples", type=int, default=100, help="Number of evaluation samples")
    eval_parser.add_argument("--visual", action="store_true", help="Evaluate the (trajectory, viewport) visual student")
    eval_parser.add_argument("--onnx", type=str, default=None, help="Measure latency through this ONNX file (visual evaluation)")

    # Command: benchmark
    bench_parser = subparsers.add_parser("benchmark", help="Benchmark checkpoint against industry SOTA thresholds")
    bench_parser.add_argument("--checkpoint", type=str, required=True, help="Path to trained checkpoint .pt")
    bench_parser.add_argument("--dataset", type=str, required=True, help="Path to multimodal dataset directory")
    bench_parser.add_argument("--split", type=str, default="test", choices=["train", "val", "test"], help="Dataset split")

    # Command: export
    export_parser = subparsers.add_parser("export", help="Export PyTorch checkpoint to ONNX")
    export_parser.add_argument("--checkpoint", type=str, required=True, help="Path to checkpoint .pt")
    export_parser.add_argument("--version", type=str, required=True, help="Version tag, e.g. 1.2.0")
    export_parser.add_argument("--visual", action="store_true", help="Export the visual student (inputs: trajectory, visual)")
    export_parser.add_argument("--context", action="store_true", help="Export the context student (trajectory, visual, page_context)")

    # Command: promote
    promote_parser = subparsers.add_parser("promote", help="Promote ONNX candidate to production registry")
    promote_parser.add_argument("--onnx", type=str, required=True, help="Path to ONNX binary")
    promote_parser.add_argument("--version", type=str, required=True, help="Release SemVer, e.g. 1.2.0")
    promote_parser.add_argument("--name", type=str, default="phishguard-student-edge", help="Model name")
    promote_parser.add_argument("--architecture", type=str, default="1D-CNN + BiLSTM", help="Model architecture")
    promote_parser.add_argument("--report", type=str, required=True)
    promote_parser.add_argument("--corpus", type=str, required=True)
    promote_parser.add_argument("--runtime-evidence", type=str, required=True)

    # Command: list
    list_parser = subparsers.add_parser("list", help="List checkpoints across lifecycle stages")
    list_parser.add_argument("--stage", type=str, default=None, choices=["raw", "candidate", "onnx", "registry"], help="Filter stage")

    # Command: prune
    prune_parser = subparsers.add_parser("prune", help="Prune old raw checkpoints")
    prune_parser.add_argument("--keep", type=int, default=3, help="Number of top checkpoints to keep")

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 0

    manager = CheckpointManager()

    if args.command == "extract-dataset":
        pipeline = TrainingPipeline(checkpoint_manager=manager)
        print(f"[PhishGuard-ML] Extracting and storing multimodal dataset ({args.samples} samples, benchmark={args.benchmark}) to: {args.output}...")
        manifest = pipeline.extract_and_store_dataset(
            output_dir=args.output,
            num_samples=args.samples,
            save_images=not args.no_images,
            seed=args.seed,
            benchmark=args.benchmark,
        )
        print("[PhishGuard-ML] Dataset extraction and storage complete!")
        print(f"  Dataset name: {manifest.datasetName}")
        print(f"  Total samples: {manifest.totalSamples}")
        print(f"  Supported modalities: {', '.join(manifest.modalitiesSupported)}")
        print(f"  Manifest saved to: {Path(args.output) / 'dataset_manifest.json'}")
        return 0

    elif args.command == "train":
        config = {}
        if args.config:
            cfg_path = Path(args.config)
            if cfg_path.exists():
                with open(cfg_path, "r", encoding="utf-8") as f:
                    config = json.load(f)
        if "hyperparameters" not in config:
            config["hyperparameters"] = {}
        config["hyperparameters"]["epochs"] = args.epochs

        pipeline = TrainingPipeline(checkpoint_manager=manager)

        if args.sota:
            dataset_path = args.dataset or "data/phishguard_multimodal_sota"
            print(f"[PhishGuard-ML] Starting SOTA multimodal training using dataset at: {dataset_path} (epochs={args.epochs})...")
            res = pipeline.train_sota_multimodal(
                dataset_dir=dataset_path,
                config=config,
                epochs=args.epochs,
            )
            print("[PhishGuard-ML] SOTA training complete!")
            print(f"  Best checkpoint: {res.get('best_checkpoint_path')}")
            print(f"  Passed SOTA gates: {res.get('passed_sota')}")
            if "test_metrics" in res:
                print(f"  Test metrics: {json.dumps(res['test_metrics'], indent=2)}")
            return 0
        if args.dataset or args.context or config.get("include_page_context"):
            if not args.dataset:
                parser.error("Context student training requires --dataset pointing to a frozen corpus manifest")
            corpus_path = Path(args.dataset)
            if corpus_path.is_dir():
                corpus_path = corpus_path / "corpus.json"
            config.update(include_visual=True, include_page_context=True, corpus_manifest=str(corpus_path))
            res = pipeline.train_student(config=config, num_samples=args.samples)
            print(json.dumps(res, indent=2))
            return 0

        print(f"[PhishGuard-ML] Starting training (distill={args.distill}, epochs={args.epochs}, samples={args.samples})...")
        if args.distill:
            res = pipeline.train_distillation(config=config, num_samples=args.samples)
        else:
            res = pipeline.train_student(config=config, num_samples=args.samples)

        print("[PhishGuard-ML] Training complete!")
        print(f"  Best checkpoint: {res.get('best_checkpoint_path')}")
        return 0

    elif args.command == "evaluate":
        chk_path = Path(args.checkpoint)
        from phishguard_ml_engine.models.student_model import DistilledStudentModel
        model = DistilledStudentModel(behavioral_in_channels=6, behavioral_dim=64, include_visual=args.visual)
        manager.load_checkpoint(chk_path, model)

        evaluator = ModelEvaluator()
        if args.visual:
            size_mb = Path(args.onnx).stat().st_size / 1024 / 1024 if args.onnx else None
            report = evaluator.evaluate_visual_model(
                model, test_samples=args.samples, file_size_mb=size_mb, onnx_path=args.onnx
            )
        else:
            report = evaluator.evaluate_model(model, test_samples=args.samples)
        print("[PhishGuard-ML] Evaluation Report:")
        print(json.dumps(report.model_dump(), indent=2))
        return 0 if report.passed_all_gates else 1

    elif args.command == "benchmark":
        chk_path = Path(args.checkpoint)
        from .unified_model import PhishGuardSOTAMultimodalModel
        model = PhishGuardSOTAMultimodalModel()
        manager.load_checkpoint(chk_path, model)

        evaluator = ModelEvaluator()
        report = evaluator.evaluate_sota_dataset(
            model=model,
            dataset_dir=args.dataset,
            split=args.split,
        )
        print("[PhishGuard-ML] SOTA Benchmark Report:")
        print(json.dumps(report.model_dump(), indent=2))
        return 0 if report.passedSotaBenchmark else 1

    elif args.command == "export":
        exporter = ModelExportPipeline(checkpoint_manager=manager)
        out_path = exporter.export_checkpoint(Path(args.checkpoint), version_label=args.version, include_visual=args.visual or args.context, include_page_context=args.context)
        print(f"[PhishGuard-ML] Successfully exported ONNX: {out_path}")
        return 0

    elif args.command == "promote":
        promoter = ModelPromoter(checkpoint_manager=manager)
        result = promoter.promote_to_registry(
            onnx_source_path=Path(args.onnx),
            version=args.version,
            name=args.name,
            architecture=args.architecture,
            metrics={},
            changelog=[f"Released version {args.version}"],
            evaluation_report=Path(args.report),
            corpus_manifest=Path(args.corpus),
            runtime_evidence=Path(args.runtime_evidence),
            sync_to_extension=False,
        )
        print(f"[PhishGuard-ML] Promotion result:")
        print(json.dumps(result.model_dump(), indent=2))
        return 0

    elif args.command == "list":
        checkpoints = manager.list_checkpoints(stage=args.stage)
        print(f"[PhishGuard-ML] Found {len(checkpoints)} checkpoints:")
        for c in checkpoints:
            stage = c.get("stage", "unknown")
            cid = c.get("checkpoint_id", c.get("version", "unnamed"))
            metrics = c.get("metrics", {})
            sha = c.get("sha256", "")[:12]
            print(f"  [{stage.upper()}] {cid} | SHA: {sha} | Metrics: {metrics}")
        return 0

    elif args.command == "prune":
        deleted = manager.prune_raw_checkpoints(keep_best_k=args.keep)
        print(f"[PhishGuard-ML] Pruned {len(deleted)} older checkpoints.")
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
