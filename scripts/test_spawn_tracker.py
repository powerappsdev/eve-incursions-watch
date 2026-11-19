"""Regression checks for storing staging IDs without changing lifecycle times."""
import unittest
from unittest.mock import patch

import update_incursion_state as tracker


class SpawnTrackerTests(unittest.TestCase):
    def test_metadata_upgrade_preserves_phase_start(self):
        state = {"incursions": {"1": {
            "constellation_id": 1, "active": True, "state": "established",
            "first_seen_at": "2026-11-01T00:00:00Z",
            "state_changed_at": "2026-11-01T01:00:00Z",
        }}}
        spawn = {"constellation_id": 1, "state": "established", "staging_solar_system_id": 30000001}
        with patch.object(tracker, "utc_now", return_value="2026-11-02T00:00:00Z"):
            self.assertTrue(tracker.update_state(state, [spawn]))
            self.assertEqual(state["incursions"]["1"]["state_changed_at"], "2026-11-01T01:00:00Z")
            self.assertEqual(state["incursions"]["1"]["staging_solar_system_id"], 30000001)
            self.assertFalse(tracker.update_state(state, [spawn]))
            self.assertTrue(tracker.update_state(state, []))
            self.assertEqual(state["incursions"]["1"]["ended_at"], "2026-11-02T00:00:00Z")
            self.assertEqual(state["incursions"]["1"]["staging_solar_system_id"], 30000001)
            self.assertTrue(tracker.update_state(state, [spawn]))
            self.assertNotIn("ended_at", state["incursions"]["1"])


if __name__ == "__main__":
    unittest.main()
