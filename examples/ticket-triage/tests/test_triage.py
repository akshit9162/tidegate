import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
from triage import rules


class Rules(unittest.TestCase):
    def test_outage_is_urgent_infra(self):
        self.assertEqual(rules("The dashboard is down for everyone"), {"urgency": "high", "team": "infra"})

    def test_refund_goes_to_billing(self):
        self.assertEqual(rules("Please refund my last invoice"), {"urgency": "normal", "team": "billing"})


if __name__ == "__main__":
    unittest.main()
