import argparse
import hashlib
import json
from pathlib import Path
import resource

import numpy as np
import onnxruntime as ort


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Runtime evidence is immutable")
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    options.inter_op_num_threads = 1
    baseline = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024
    session = ort.InferenceSession(str(args.model), sess_options=options, providers=["CPUExecutionProvider"])
    context = np.zeros((1, 16), dtype=np.float32)
    context[0, 14] = 1
    for _ in range(30):
        session.run(None, dict(trajectory=np.zeros((1, 128, 6), np.float32),
                              visual=np.zeros((1, 3, 64, 64), np.float32), page_context=context))
    measurement = dict(
        modelSha256=hashlib.sha256(args.model.read_bytes()).hexdigest(),
        runtime="onnxruntime CPU, Linux process peak RSS including Python/NumPy",
        baselineRssMb=baseline, peakRssMb=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024,
        browserMemoryMeasured=False, targetBrowserBudgetMb=200,
    )
    args.output.write_text(json.dumps(measurement, indent=2) + "\n")
    print(json.dumps(measurement))


if __name__ == "__main__":
    main()
