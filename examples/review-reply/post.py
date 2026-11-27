# Runs only after a person approved or corrected the draft. Replays never reach this agent. With
# GITHUB_TOKEN set it posts the reply on the pull request; without one it prints what it would post.
import json, os, urllib.request

inp = json.load(open(os.environ["TIDEGATE_INPUT"]))
out = inp["output"]
c = out["comment"]
if c["event"] == "pull_request_review_comment":
    url = f"https://api.github.com/repos/{c['repo']}/pulls/{c['number']}/comments/{c['id']}/replies"
else:
    url = f"https://api.github.com/repos/{c['repo']}/issues/{c['number']}/comments"
token = os.environ.get("GITHUB_TOKEN")
if token:
    req = urllib.request.Request(url, method="POST", data=json.dumps({"body": out["reply"]}).encode(),
                                 headers={"authorization": f"Bearer {token}", "accept": "application/vnd.github+json"})
    posted = json.loads(urllib.request.urlopen(req).read()).get("html_url")
else:
    print(f"POST {url}\n\n{out['reply']}")
    posted = None
json.dump({"posted": posted, "corrected": inp.get("corrected", False)}, open(os.environ["TIDEGATE_OUTPUT"], "w"))
