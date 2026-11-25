# Runs only after a person approved or corrected the reply, or nothing flagged it. A real agent would send
# the email here; the example prints it. Replays never reach this agent.
import json, os
inp = json.load(open(os.environ["TIDEGATE_INPUT"]))
out = inp["output"]
print(f"to: {out.get('to')}\n\n{out['reply']}")
json.dump({"sent_to": out.get("to"), "corrected": inp.get("corrected", False)}, open(os.environ["TIDEGATE_OUTPUT"], "w"))
