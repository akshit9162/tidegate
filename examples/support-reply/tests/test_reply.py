import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from reply import draft, evals

class Reply(unittest.TestCase):
    def test_refunds_are_routed_not_promised(self):
        r = draft("I want a refund for order 12")
        self.assertIn("billing team", r)
        self.assertTrue(evals(r)["no_promises"])

    def test_promises_fail_the_eval(self):
        self.assertFalse(evals("We guarantee it ships by tomorrow")["no_promises"])

if __name__ == "__main__":
    unittest.main()
