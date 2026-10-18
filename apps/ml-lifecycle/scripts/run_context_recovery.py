import argparse
import json
from pathlib import Path

from phishguard_ml_lifecycle.context_corpus import build_context_corpus, canonical_json
from phishguard_ml_lifecycle.context_training import train_context_candidate, export_and_evaluate_context


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--sources", type=int, default=128)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Use a new run directory; existing run is immutable")
    root = Path(__file__).resolve().parents[3]
    args.output.mkdir(parents=True)
    manifest = build_context_corpus(root, max_sources=args.sources)
    (args.output / "corpus.json").write_bytes(canonical_json(manifest) + b"\n")
    trained = [train_context_candidate(root, manifest, args.output / "checkpoints", seed) for seed in (0, 1, 2)]
    selected = min(trained, key=lambda result: result["best_val_loss"])
    (args.output / "selection.json").write_bytes(canonical_json(dict(runs=trained, selected_seed=selected["seed"])) + b"\n")
    evaluated = export_and_evaluate_context(root, manifest, Path(selected["checkpoint"]), args.output / "candidate")
    print(json.dumps({key: value for key, value in evaluated.items() if key not in ("predictions", "modality_regimes")}), flush=True)
    return 0 if evaluated["passed_all_gates"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
