import argparse
import hashlib
import json
from pathlib import Path

from phishguard_ml_lifecycle.context_corpus import canonical_json
from phishguard_ml_lifecycle.release_validation import validate_context_release


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", type=Path, required=True)
    args = parser.parse_args()
    original = args.run / "candidate/evaluation.json"
    if (args.run / "selection.json").exists():
        selection = json.loads((args.run / "selection.json").read_text())
        checkpoint = args.run / "checkpoints" / f"context_seed{selection['selected_seed']}.pt"
        corpus_path = args.run / "corpus.json"
    else:
        identity = json.loads((args.run / "source-identity.json").read_text())
        checkpoint = args.run / "transport_invariant.pt"
        corpus_path = Path(identity["corpus_path"])
        selection = {"selected_seed": json.loads(original.read_text())["selected_seed"]}
    checked = validate_context_release(args.run / "candidate/student_model.onnx", original, corpus_path)
    report = checked["report"]
    if report["selected_seed"] != selection["selected_seed"]:
        raise ValueError("Selected checkpoint differs from evaluated checkpoint")
    target = args.run / "candidate/evaluation-with-source.json"
    if target.exists():
        raise FileExistsError("Finalized report already exists")
    report["source_checkpoint_sha256"] = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    report["original_evaluation_report_sha256"] = checked["report_sha256"]
    report["sampling_interval_note"] = "Variant-row Wilson bounds are descriptive; correlated synthetic variants are not independent web observations"
    report["runtime_acceptance_sha256"] = hashlib.sha256((args.run / "candidate/runtime-acceptance.json").read_bytes()).hexdigest()
    target.write_bytes(canonical_json(report) + b"\n")
    print(json.dumps(dict(path=str(target), source_checkpoint_sha256=report["source_checkpoint_sha256"],
                          sha256=hashlib.sha256(target.read_bytes()).hexdigest())))


if __name__ == "__main__":
    main()
