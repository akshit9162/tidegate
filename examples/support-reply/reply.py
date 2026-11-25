# Drafts a reply to a support email. With ANTHROPIC_API_KEY set it asks Claude through the official HTTP
# API; Tidegate's gateway records the call without any code here. Without a key it uses a template, so the
# example runs anywhere.
import json, os, urllib.request

def draft_with_model(email, examples):
    shots = "\n\n".join(f"Email: {e['input'].get('email', '')}\nGood reply: {e['output'].get('reply', '')}" for e in examples["good"])
    avoid = "\n".join(f"- {e['note']}" for e in examples["avoid"] if e["note"])
    prompt = (f"Write a short, kind reply to this support email. Never promise refunds or dates.\n"
              f"{'Replies the team approved:' + chr(10) + shots if shots else ''}\n"
              f"{'Avoid what the team rejected:' + chr(10) + avoid if avoid else ''}\n\nEmail: {email}\nReply:")
    req = urllib.request.Request(
        os.environ.get("ANTHROPIC_BASE_URL", "https://api.anthropic.com") + "/v1/messages", method="POST",
        headers={"x-api-key": os.environ["ANTHROPIC_API_KEY"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
        data=json.dumps({"model": os.environ.get("REPLY_MODEL", "claude-haiku-5-5"), "max_tokens": 300,
                         "messages": [{"role": "user", "content": prompt}]}).encode())
    return json.loads(urllib.request.urlopen(req).read())["content"][0]["text"].strip()

def draft(email):
    if "refund" in email.lower():
        return "Thanks for writing. I've passed your refund request to our billing team, who will reply directly."
    return "Thanks for reaching out. We're looking into this and will get back to you shortly."

def evals(reply):
    words = reply.lower()
    return {"short": len(reply) < 400, "no_promises": not any(w in words for w in ["guarantee", "we will refund", "by tomorrow"])}

if __name__ == "__main__":
    inp = json.load(open(os.environ["TIDEGATE_INPUT"])) or {}
    examples = json.load(open(os.environ["TIDEGATE_EXAMPLES"]))
    email = inp.get("email", "")
    reply = draft_with_model(email, examples) if os.environ.get("ANTHROPIC_API_KEY") else draft(email)
    e = evals(reply)
    json.dump({"title": f"Reply to: {email[:60]}", "summary": reply, "reply": reply, "to": inp.get("from"),
               "confidence": 0.9 if all(e.values()) else 0.4, "evals": e}, open(os.environ["TIDEGATE_OUTPUT"], "w"))
