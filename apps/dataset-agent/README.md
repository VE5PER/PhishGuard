# PhishGuard Dataset Agent

Autonomous daily web search and multimodal dataset aggregation agent for **PhishGuard**.

---

## 1. Overview

The **Dataset Agent** continuously discovers emerging phishing threats, typosquats, credential harvesting landing pages, and benign baseline web anchors. It synthesizes multimodal samples conforming to PhishGuard's strict 5-stream data contracts:
1. **URL Lexical Topology:** 32-dimensional URL/domain feature vector.
2. **Kinematic & Keystroke Dynamics:** Synthesized Bézier curve pointer trajectories and GDPR-compliant keystroke flight/dwell dynamics (zero raw key logs).
3. **Logo Grounding:** Authentic vs spoofed brand logo identity alignment.
4. **Visual Object Detection:** Credentials input fields, submission buttons, and security badges.
5. **DOM Interaction Events:** Form interaction coordinates and element metadata.

Collected data is archived daily into structured JSONL partitions (`data/daily_datasets/YYYY-MM-DD/`) and optionally synchronized with `apps/ml-lifecycle` (`data/phishguard_daily_aggregated/`) for automated continuous model retraining.

### Acquisition pipeline (per cycle, in order)

1. **Deep Research (optional, paid):** an ADK `SequentialAgent` runs a non-LLM
   `ResearchGatherer` (Gemini Deep Research via `client.aio.interactions`,
   background mode) and then an ADK `LlmAgent` curator that turns the reports
   into cited URL findings + discovered sources. LLM labels are never
   training-eligible: findings become `research_agent`/`llm_research` samples
   (0.6, withheld) unless code corroborates them against a verified feed record
   of the same cycle (phishing: exact normalized URL match; benign: exact host
   match; labels must agree). A corroborated finding takes the feed's label and
   confidence (`verified_feed`) and still needs `>= 0.95` to export. Raw reports
   and findings land in `<date>/research.json` for human review.
2. **Public feeds:** connectors in `sources/` (OpenPhish phishing feed,
   Tranco top-sites benign anchors, optional Phishing.Database) emit
   `FeedRecord`s with verified labels (`public_feed`/`verified_feed`).
3. **Search + heuristic:** the existing DDG/SerpAPI/mock search providers top
   up the remaining quota (`fetched_metadata`/`heuristic`).
4. **Fill:** the committed seed snapshot (`sources/seeds/seed_urls.csv`,
   `repository_fixture`) and finally the mock generator close any gap.

Only `manual_fixture` and `verified_feed` samples with `labelConfidence >= 0.95`
export to the ML lifecycle training dir; `repository_fixture` and LLM-derived
labels are always withheld.

---

## 2. Directory Structure

```text
apps/dataset-agent/
├── Dockerfile                  # Container runtime for Dokploy worker or Cloud Run Job
├── pyproject.toml              # Python project manifest
├── README.md                   # This documentation
├── AGENTS.md                   # Agent directives & operational conventions
├── src/
│   └── phishguard_dataset_agent/
│       ├── __init__.py         # Package exports
│       ├── config.py           # Agent settings and environment variables
│       ├── agent.py            # High-level DatasetAgent coordinator
│       ├── cli.py              # CLI commands (run-once, daemon, status, search)
│       ├── main.py             # Entrypoint
│       ├── search/             # Web search query generation and providers
│       │   ├── models.py       # Query and search item schemas
│       │   ├── query_generator.py # Targeted phishing dorks and benign queries
│       │   └── providers.py    # DuckDuckGo, SerpAPI, Mock/ThreatFeed providers
│       ├── collector/          # URL inspection, heuristic labeling, and sample synthesis
│       │   ├── models.py       # Page metadata schemas
│       │   ├── page_fetcher.py # Async HTTP DOM & metadata inspection
│       │   ├── labeler.py      # Brand identity & heuristic ground truth classifier
│       │   └── sample_builder.py # MultimodalDatasetSample builder (Pydantic v2)
│       ├── aggregator/         # Multi-stream dataset aggregation and quota balancer
│       │   └── dataset_aggregator.py
│       ├── sources/            # Public source registry + feed connectors
│       │   ├── registry.json   # Curated catalog of feeds/datasets/APIs
│       │   ├── models.py       # SourceSpec and FeedRecord schemas
│       │   ├── registry.py     # Registry loader + connector map
│       │   ├── feeds.py        # OpenPhish, Tranco, Phishing.Database, seed snapshot
│       │   └── seeds/          # Committed seed snapshot + research topics
│       ├── research/           # Gemini Deep Research discovery stage
│       │   ├── models.py       # Finding/curated batch/topic schemas
│       │   ├── gemini_client.py # Deep Research Interactions API client
│       │   ├── adk_pipeline.py # ADK gatherer + curator pipeline and tools
│       │   ├── corroboration.py # Feed index for deterministic corroboration
│       │   └── deep_research.py # Topic selection, prompts, normalization
│       ├── storage/            # Daily JSONL archive sink & ML lifecycle export
│       │   └── sink.py
│       └── scheduler/          # Continuous daily deployment scheduler
│           └── daily_runner.py
└── tests/                      # Pytest unit tests
```

---

## 3. Configuration

Configured via environment variables or CLI flags:

| Variable | Default | Description |
| :--- | :--- | :--- |
| `DATASET_AGENT_OUTPUT_DIR` | `data/daily_datasets` | Archive directory for daily gathered datasets |
| `DATASET_AGENT_SCHEDULE_CRON` | `0 2 * * *` | Schedule cron expression (e.g. daily at 02:00 UTC) |
| `DATASET_AGENT_INTERVAL_SECONDS` | `86400` | Loop interval in seconds (default: 24 hours) |
| `DATASET_AGENT_SAMPLE_TARGET` | `100` | Target multimodal samples per daily cycle |
| `DATASET_AGENT_SEARCH_PROVIDER` | `auto` | Search engine (`auto`, `duckduckgo`, `serpapi`, `mock`) |
| `DATASET_AGENT_SEARCH_API_KEY` | `None` | API key for external search providers (SerpAPI) |
| `DATASET_AGENT_TARGET_BRANDS` | Top 20 brands | Comma-separated target brand list |
| `DATASET_AGENT_EXPORT_LIFECYCLE`| `true` | Export to training-ready ML lifecycle tensors/manifest |
| `DATASET_AGENT_LIFECYCLE_DIR` | `data/phishguard_daily_aggregated` | ML lifecycle target directory (the curated `phishguard_multimodal_sota` set is never overwritten) |
| `DATASET_AGENT_FEED_SOURCES` | `openphish,tranco` | Enabled feed connector ids from the source registry |
| `DATASET_AGENT_TRANCO_TOP_N` | `10000` | Tranco top-ranked domains to treat as benign anchors |
| `DATASET_AGENT_FETCH_FEED_PAGES` | `false` | Fetch live page content for feed-listed URLs |
| `DATASET_AGENT_FETCH_CONCURRENCY` | `8` | Max concurrent page fetches per cycle |
| `GEMINI_API_KEY` | `None` | Gemini API key (falls back to `GOOGLE_API_KEY`) |
| `DATASET_AGENT_DEEP_RESEARCH_ENABLED` | `false` | Run the Deep Research stage each cycle (paid) |
| `DATASET_AGENT_DEEP_RESEARCH_AGENT` | `deep-research-preview-04-2026` | Gemini Deep Research agent id |
| `DATASET_AGENT_DEEP_RESEARCH_TASKS` | `1` | Research topics per cycle |
| `DATASET_AGENT_DEEP_RESEARCH_TIMEOUT_SECONDS` | `1800` | Poll budget per Deep Research interaction |
| `DATASET_AGENT_DEEP_RESEARCH_MAX_URLS` | `50` | Cap on research URL findings per cycle |
| `DATASET_AGENT_EXTRACTION_MODEL` | `gemini-3.6-flash` | Gemini model for the ADK dataset curator |

---

## 4. Usage

### CLI Commands

```bash
# 1. Run a single aggregation cycle immediately
phishguard-dataset-agent run-once --target 50

# 2. Deploy continuous daily daemon (runs every 24 hours)
phishguard-dataset-agent daemon --interval 86400

# 3. Inspect archive status and sample totals
phishguard-dataset-agent status

# 4. Test an ad-hoc search query
phishguard-dataset-agent search --query "Microsoft account login verification" --brand Microsoft

# 5. List the committed source registry and enabled connectors
phishguard-dataset-agent sources

# 6. Preview a Deep Research prompt (free) or run it (paid, needs GEMINI_API_KEY)
phishguard-dataset-agent research --topic new_phishing_datasets --dry-run
phishguard-dataset-agent research --topic new_phishing_datasets
```

`run-once` also accepts `--feeds openphish,tranco` and
`--deep-research`/`--no-deep-research` overrides.

### Python SDK Usage

```python
import asyncio
from phishguard_dataset_agent import DatasetAgent, DatasetAgentConfig

async def main():
    config = DatasetAgentConfig(daily_sample_target=25)
    agent = DatasetAgent(config=config)
    
    # Run a single cycle
    summary = await agent.run_once()
    print("Aggregated batch summary:", summary)

asyncio.run(main())
```

---

## 5. Deployment

### Dokploy Deployment
The agent ships as a **dormant** one-shot service in `docker-compose.yml`
(profile `dataset-agent`); a plain `up` never starts it:
```bash
docker compose --profile dataset-agent run --rm dataset-agent
```
See `deploy/DEPLOY_DOKPLOY.md` for the full profile setup and env block.

### GCP Cloud Run Job
`cloudbuild.yaml` deploys `phishguard-dataset-agent-${_ENV}` as a Cloud Run
Job — deployed but never scheduled or auto-executed. Run it manually:
```bash
gcloud run jobs execute phishguard-dataset-agent-dev-1 --region=asia-south1
```
See `deploy/gcp/README.md` for secrets, the optional GCS data volume, and how
a Cloud Scheduler trigger can be added later.
