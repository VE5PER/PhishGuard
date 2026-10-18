"""Tests for dataset agent CLI commands."""

import json
from pathlib import Path
import pytest
from phishguard_dataset_agent.cli import build_parser, main


def test_cli_parser_build():
    parser = build_parser()
    assert parser.prog == "phishguard-dataset-agent"

    # Test run-once args
    args_run = parser.parse_args(["run-once", "--target", "20", "--provider", "mock"])
    assert args_run.command == "run-once"
    assert args_run.target == 20
    assert args_run.provider == "mock"

    # Test daemon args
    args_daemon = parser.parse_args(["daemon", "--interval", "3600", "--skip-initial"])
    assert args_daemon.command == "daemon"
    assert args_daemon.interval == 3600
    assert args_daemon.skip_initial is True

    # Test status args
    args_status = parser.parse_args(["status", "--output", "data/test"])
    assert args_status.command == "status"
    assert args_status.output == "data/test"

    # Test search args
    args_search = parser.parse_args(["search", "--query", "test login", "--brand", "Google"])
    assert args_search.command == "search"
    assert args_search.query == "test login"
    assert args_search.brand == "Google"


def test_cli_execution_status(monkeypatch, capsys, temp_output_dir: Path):
    monkeypatch.setattr("sys.argv", ["phishguard-dataset-agent", "status", "--output", str(temp_output_dir)])
    main()
    captured = capsys.readouterr()
    data = json.loads(captured.out)
    assert "cycles_completed" in data
    assert "storage_status" in data


def test_cli_execution_search(monkeypatch, capsys):
    monkeypatch.setattr(
        "sys.argv",
        ["phishguard-dataset-agent", "search", "--query", "Apple id login", "--brand", "Apple", "--provider", "mock", "--limit", "2"],
    )
    main()
    captured = capsys.readouterr()
    items = json.loads(captured.out)
    assert len(items) == 2
    assert items[0]["target_brand"] == "Apple"


def test_cli_execution_sources(monkeypatch, capsys):
    monkeypatch.delenv("DATASET_AGENT_FEED_SOURCES", raising=False)
    monkeypatch.setattr("sys.argv", ["phishguard-dataset-agent", "sources"])
    main()
    captured = capsys.readouterr()
    listing = json.loads(captured.out)
    assert len(listing) >= 8
    by_id = {e["id"]: e for e in listing}
    assert by_id["openphish"]["enabled"] is True
    assert by_id["openphish"]["connector_implemented"] is True
    assert by_id["phishtank"]["connector_implemented"] is False
    assert by_id["seed_snapshot"]["enabled"] is True


def test_cli_research_dry_run(monkeypatch, capsys):
    monkeypatch.setattr(
        "sys.argv",
        ["phishguard-dataset-agent", "research", "--topic", "new_phishing_datasets", "--dry-run"],
    )
    main()
    captured = capsys.readouterr()
    assert "PhishGuard" in captured.out
    assert "phishing" in captured.out.lower()
