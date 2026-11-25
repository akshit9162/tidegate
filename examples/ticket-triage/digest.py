"""Summarise the tickets triaged since the last digest, then clear them."""
import collections
import json
import os
import pathlib

store = pathlib.Path("tickets.json")
tickets = json.loads(store.read_text()) if store.exists() else []
by = collections.Counter(f"{t['urgency']}/{t['team']}" for t in tickets)
summary = {"tickets": len(tickets), "by_urgency_and_team": dict(by)}
pathlib.Path(os.environ["TIDEGATE_OUTPUT"]).write_text(json.dumps(summary))
store.write_text("[]")
print(f"digest of {len(tickets)} tickets")
