# syntax=docker/dockerfile:1
# ---------------------------------------------------------------------------
# PhishGuard Autonomous Dataset Agent
# Deploys daily web search and multimodal dataset aggregation worker
# ---------------------------------------------------------------------------

FROM python:3.12-slim AS runtime

# Copy uv binary from official Astral image
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_SYSTEM_PYTHON=1 \
    UV_NO_CACHE=1 \
    DATASET_AGENT_OUTPUT_DIR=/app/data/daily_datasets \
    DATASET_AGENT_LIFECYCLE_DIR=/app/data/phishguard_daily_aggregated

# OpenMP runtime required by PyTorch
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgomp1 curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1. CPU-only torch
RUN uv pip install --system --index-url https://download.pytorch.org/whl/cpu "torch>=2.2,<3"

# 2. Dependencies
RUN uv pip install --system "httpx>=0.25.0" "pydantic>=2.0.0" numpy pillow "google-genai==2.28.0" "google-adk==2.11.0" setuptools wheel scipy onnx onnxruntime

# 3. Workspace packages
COPY packages/types /app/packages/types
COPY packages/ml-engine /app/packages/ml-engine
COPY apps/ml-lifecycle /app/apps/ml-lifecycle
COPY apps/dataset-agent /app/apps/dataset-agent

RUN uv pip install --system --no-deps --no-build-isolation \
      -e ./packages/types \
      -e ./packages/ml-engine \
      -e ./apps/ml-lifecycle \
      -e ./apps/dataset-agent

# 4. Non-root user and data directories
RUN useradd --create-home --uid 10001 agentuser \
 && mkdir -p /app/data/daily_datasets /app/data/phishguard_daily_aggregated \
 && chown -R agentuser:agentuser /app

USER agentuser

# By default, runs continuous daily daemon
CMD ["phishguard-dataset-agent", "daemon"]
