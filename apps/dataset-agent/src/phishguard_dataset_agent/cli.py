"""Command-line interface for PhishGuard Dataset Agent."""

import argparse
import asyncio
import json
import logging
from pathlib import Path
import sys

from .config import DatasetAgentConfig
from .agent import DatasetAgent

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("phishguard-dataset-agent")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="phishguard-dataset-agent",
        description="Autonomous Daily Web Search and Multimodal Dataset Aggregator Agent",
    )
    subparsers = parser.add_subparsers(dest="command", help="Agent command to execute")

    # Command: run-once
    p_run = subparsers.add_parser("run-once", help="Run a single dataset aggregation and archive cycle")
    p_run.add_argument("--target", type=int, default=None, help="Target number of multimodal samples to gather")
    p_run.add_argument("--date", type=str, default=None, help="Date partition override (YYYY-MM-DD)")
    p_run.add_argument("--output", type=str, default=None, help="Output directory path for daily archives")
    p_run.add_argument("--provider", type=str, default=None, help="Search provider ('auto', 'duckduckgo', 'serpapi', 'mock')")
    p_run.add_argument("--feeds", type=str, default=None, help="Comma-separated public feed connector ids to enable")
    p_run.add_argument("--deep-research", dest="deep_research", action="store_true", default=None,
                       help="Enable the Gemini Deep Research discovery stage")
    p_run.add_argument("--no-deep-research", dest="deep_research", action="store_false",
                       help="Disable the Gemini Deep Research discovery stage")
    p_run.add_argument("--no-export", action="store_true", help="Do not export to ML lifecycle training dataset")

    # Command: daemon
    p_daemon = subparsers.add_parser("daemon", help="Start continuous daily deployment agent daemon")
    p_daemon.add_argument("--interval", type=int, default=None, help="Interval between runs in seconds (default: 86400)")
    p_daemon.add_argument("--target", type=int, default=None, help="Target samples per daily run")
    p_daemon.add_argument("--output", type=str, default=None, help="Output directory path")
    p_daemon.add_argument("--skip-initial", action="store_true", help="Skip running immediately upon daemon start")

    # Command: status
    p_status = subparsers.add_parser("status", help="Inspect status of dataset agent and stored daily archives")
    p_status.add_argument("--output", type=str, default=None, help="Output directory path to inspect")

    # Command: search
    p_search = subparsers.add_parser("search", help="Execute an ad-hoc search query for testing")
    p_search.add_argument("--query", type=str, required=True, help="Web search query string")
    p_search.add_argument("--brand", type=str, default=None, help="Target brand name")
    p_search.add_argument("--limit", type=int, default=5, help="Maximum results to return")
    p_search.add_argument("--provider", type=str, default="auto", help="Search provider to invoke")

    # Command: sources
    subparsers.add_parser("sources", help="List the committed source registry and enabled feed connectors")

    # Command: research
    p_research = subparsers.add_parser("research", help="Run a Deep Research topic (Gemini API key required)")
    p_research.add_argument("--topic", type=str, required=True, help="Research topic id from seeds/research_topics.json")
    p_research.add_argument("--dry-run", action="store_true", help="Print the resolved prompt without calling Gemini")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    # Base config from environment
    config = DatasetAgentConfig.from_env()
    if hasattr(args, "output") and args.output:
        config.output_dir = Path(args.output)
    if hasattr(args, "target") and args.target:
        config.daily_sample_target = args.target
    if hasattr(args, "provider") and args.provider:
        config.search_provider = args.provider
    if hasattr(args, "no_export") and args.no_export:
        config.export_to_ml_lifecycle = False
    if hasattr(args, "interval") and args.interval:
        config.interval_seconds = args.interval
    if hasattr(args, "feeds") and args.feeds:
        config.feed_sources = [s.strip() for s in args.feeds.split(",") if s.strip()]
    if getattr(args, "deep_research", None) is not None:
        config.deep_research_enabled = args.deep_research

    if args.command == "sources":
        from .sources.registry import load_registry, CONNECTORS
        from .sources.feeds import SeedSnapshotFeed

        registry = load_registry()
        enabled = set(config.feed_sources) | {SeedSnapshotFeed.source_id}
        listing = []
        for spec in registry:
            entry = spec.model_dump()
            entry["enabled"] = spec.id in enabled or (
                spec.connector is not None and spec.connector in enabled
            )
            entry["connector_implemented"] = spec.connector in CONNECTORS if spec.connector else False
            listing.append(entry)
        print(json.dumps(listing, indent=2))
        return

    if args.command == "research":
        from datetime import datetime, timezone
        from .research.deep_research import DeepResearchCollector

        collector = DeepResearchCollector(config=config)
        topic = next((t for t in collector.topics if t.id == args.topic), None)
        if topic is None:
            available = ", ".join(t.id for t in collector.topics) or "(none)"
            print(f"Unknown research topic '{args.topic}'. Available: {available}", file=sys.stderr)
            sys.exit(1)
        if args.dry_run:
            print(collector.build_prompt(topic))
            return
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        result = asyncio.run(collector.collect(today, topics_override=[topic]))
        print(json.dumps(result.model_dump(), indent=2, default=str))
        return

    agent = DatasetAgent(config=config)

    if args.command == "run-once":
        logger.info("Executing run-once...")
        summary = asyncio.run(agent.run_once(sample_target=args.target, date_str=args.date))
        print(json.dumps(summary, indent=2))

    elif args.command == "daemon":
        logger.info("Starting daily agent daemon...")
        run_immediately = not args.skip_initial
        try:
            asyncio.run(agent.start_daily_daemon(run_immediately=run_immediately))
        except (KeyboardInterrupt, asyncio.CancelledError):
            logger.info("Daemon interrupted by user. Exiting.")

    elif args.command == "status":
        status = agent.get_status()
        print(json.dumps(status, indent=2))

    elif args.command == "search":
        logger.info("Running search for '%s'...", args.query)
        results = asyncio.run(agent.test_search(query_text=args.query, brand=args.brand, max_results=args.limit))
        print(json.dumps([r.model_dump() for r in results], indent=2, default=str))


if __name__ == "__main__":
    main()
