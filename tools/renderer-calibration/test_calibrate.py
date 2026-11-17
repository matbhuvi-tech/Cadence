import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("calibration", Path(__file__).with_name("calibrate.py"))
calibration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(calibration)

class CalibrationTests(unittest.TestCase):
    def test_lead_counts_unique_sender_payload_and_first_flow_event(self):
        rows = [
            {"time": 0.0, "length": 1000, "retransmission": False, "zero_window": False, "window": 1000000},
            {"time": 1.0, "length": 1000, "retransmission": False, "zero_window": False, "window": 950000},
            {"time": 2.0, "length": 1000, "retransmission": True, "zero_window": False, "window": 800000},
        ]
        result = calibration.analyze(rows, 1000, 2)
        self.assertEqual(result["unique_payload_bytes"], 2000)
        self.assertEqual(result["retransmissions"], 1)
        self.assertEqual(result["first_flow_event_seconds"], 2.0)

    def test_profile_is_udn_scoped_and_conservative(self):
        evidence = {"max_lead_ms": 1800, "retransmissions": 1, "zero_windows": 0}
        profile = calibration.make_profile("uuid:device", evidence, evidence)
        self.assertEqual(profile["schema_version"], 1)
        self.assertEqual(profile["profiles"][0]["matcher"]["udn"], "uuid:device")
        cfg = profile["profiles"][0]["pacer_config"]
        self.assertLessEqual(cfg["initial_fill_lead_ms"], 1200)
        self.assertEqual(cfg["max_overfeed_multiplier"], 1.0)
        self.assertFalse(profile["profiles"][0]["learned_from_stress_test"])

    def test_insufficient_or_invalid_capture_rejected(self):
        with self.assertRaises(ValueError):
            calibration.analyze([], 1000, 30)
        with self.assertRaises(ValueError):
            calibration.analyze([{"time": 1.0, "length": 1, "retransmission": False, "zero_window": False, "window": 1}], 0, 30)
        with self.assertRaises(ValueError):
            calibration.make_profile("", {}, {})

if __name__ == "__main__":
    unittest.main()
