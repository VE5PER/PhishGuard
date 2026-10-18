import argparse
import hashlib
import json
from pathlib import Path

import torch

from phishguard_ml_lifecycle.context_training import export_and_evaluate_context
from phishguard_ml_lifecycle.context_corpus import canonical_json


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-run", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Use a new immutable correction directory")
    selection = json.loads((args.source_run / "selection.json").read_text())
    source = args.source_run / "checkpoints" / f"context_seed{selection['selected_seed']}.pt"
    saved = torch.load(source, map_location="cpu", weights_only=False)
    if saved["config"].get("transport_invariant"):
        raise ValueError("Checkpoint is already invariant; do not fold twice")
    state = saved["model_state_dict"]
    weight = state["context_trunk.0.weight"].clone()
    state["context_trunk.0.bias"] = state["context_trunk.0.bias"] + weight[:, 15]
    weight[:, 15] = 0
    state["context_trunk.0.weight"] = weight
    saved["config"]["transport_invariant"] = True
    saved["post_training_transform"] = {
        "kind": "fold_constant_training_transport_into_context_bias",
        "source_checkpoint_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
        "preserved_input_regime": "All original frozen-corpus inputs have HTTPS=1",
        "risk_feature_exclusion": "HTTPS is retained in the wire context but cannot affect risk projection",
    }
    args.output.mkdir(parents=True)
    checkpoint = args.output / "transport_invariant.pt"
    torch.save(saved, checkpoint)
    corpus = json.loads((args.source_run / "corpus.json").read_text())
    (args.output / "source-identity.json").write_bytes(canonical_json(dict(
        source_run=str(args.source_run), corpus_path=str(args.source_run / "corpus.json"),
        corpus_digest=corpus["digest"], transform=saved["post_training_transform"],
        checkpoint_sha256=hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
    )) + b"\n")
    root = Path(__file__).resolve().parents[3]
    torch.set_num_threads(1)
    result = export_and_evaluate_context(root, corpus, checkpoint, args.output / "candidate")
    print(json.dumps({key: value for key, value in result.items() if key not in ("predictions", "modality_regimes")}), flush=True)
    return 0 if result["passed_all_gates"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
