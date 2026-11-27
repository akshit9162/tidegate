import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from draft import comment_of, draft, evals, kind_of

def event(body, path="src/pager.js", line=42, kind="User"):
    return {"event": "pull_request_review_comment", "action": "created", "payload": {
        "comment": {"id": 1, "body": body, "path": path, "line": line, "user": {"login": "r", "type": kind}},
        "pull_request": {"number": 7}, "repository": {"full_name": "you/repo"}}}

class Draft(unittest.TestCase):
    def test_a_change_request_names_the_line(self):
        c = comment_of(event("This drops the last item."))
        self.assertEqual(kind_of(c["body"]), "change")
        self.assertTrue(evals(c, draft(c))["names_the_line"])

    def test_thanks_needs_no_reply(self):
        self.assertEqual(draft(comment_of(event("LGTM!"))), "")

    def test_filler_fails_the_eval(self):
        c = comment_of(event("Why not reuse the helper?"))
        self.assertFalse(evals(c, "Great point! Checking src/pager.js:42.")["no_filler"])

    def test_bots_are_seen(self):
        self.assertTrue(comment_of(event("Coverage dropped", kind="Bot"))["bot"])

if __name__ == "__main__":
    unittest.main()
