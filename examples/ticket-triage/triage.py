"""Sort a support ticket by urgency and team. Input: {"ticket": "..."}; output: the decision.

Rules decide by default. With ANTHROPIC_API_KEY set, swap rules() for a model call.
"""
import json
import os
import pathlib

URGENT = ("down", "outage", "can't log in", "cannot log in", "charged twice", "data loss", "security")
TEAMS = {"billing": ("invoice", "refund", "charged", "payment"), "auth": ("log in", "login", "password", "2fa"),
         "infra": ("down", "outage", "slow", "timeout", "error 5")}


def rules(text):
    t = text.lower()
    team = next((name for name, words in TEAMS.items() if any(w in t for w in words)), "general")
    return {"urgency": "high" if any(w in t for w in URGENT) else "normal", "team": team}


def main():
    ticket = (json.loads(pathlib.Path(os.environ["TIDEGATE_INPUT"]).read_text()) or {}).get("ticket", "")
    if not ticket:
        raise SystemExit("error: input needs a \"ticket\" field")
    decision = {"ticket": ticket[:200], **rules(ticket)}
    store = pathlib.Path("tickets.json")
    seen = json.loads(store.read_text()) if store.exists() else []
    seen.append(decision)
    store.write_text(json.dumps(seen))
    pathlib.Path(os.environ["TIDEGATE_OUTPUT"]).write_text(json.dumps({**decision, "tickets_so_far": len(seen)}))
    print(f"triaged as {decision['urgency']}/{decision['team']}")


if __name__ == "__main__":
    main()
