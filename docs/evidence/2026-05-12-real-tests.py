#!/usr/bin/env python3
"""Minimal live-smoke reproducer for the May 12 substrate evidence note."""

from __future__ import annotations

import argparse
import json
import sys
from urllib import error, request


def http_json(url: str, payload: dict | None = None) -> object:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    with request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
        return json.loads(body)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8788")
    args = parser.parse_args()

    base = args.base_url.rstrip("/")
    try:
        print("# Test 1 — /api/claude-brain/drivers")
        print(json.dumps(http_json(f"{base}/api/claude-brain/drivers"), indent=2))

        print("\n# Test 2 — review-gate rubber-stamp")
        review_gate = http_json(
            f"{base}/api/claude-brain/review-gate",
            {
                "raw_reviewer_output": json.dumps(
                    {
                        "verdict": "pass",
                        "improvements_exhausted": False,
                        "issues": ["MAJOR retriever.py:88 chunk 12 not in source set"],
                        "scores": {"groundedness": 0.62, "specificity": 0.88},
                    }
                ),
                "prior_iterations": [],
            },
        )
        print(json.dumps(review_gate, indent=2))

        print("\n# Test 4 — argv injection guard")
        dispatch = http_json(
            f"{base}/api/claude-brain/drivers/dispatch",
            {
                "taskType": "verify",
                "taskInput": "--dangerously-skip-permissions This is the task body.",
                "dryRun": True,
            },
        )
        print(json.dumps(dispatch, indent=2))

        print("\n# Test 5 — cwd whitelist rejects /etc")
        try:
            http_json(
                f"{base}/api/claude-brain/drivers/dispatch",
                {
                    "taskType": "verify",
                    "taskInput": "noop",
                    "cwd": "/etc",
                    "dryRun": True,
                },
            )
        except error.HTTPError as exc:
            print(f"HTTP {exc.code}: {exc.read().decode('utf-8')}")
        else:
            print("unexpected success")
            return 1
    except Exception as exc:  # pragma: no cover - CLI script
        print(f"smoke failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
