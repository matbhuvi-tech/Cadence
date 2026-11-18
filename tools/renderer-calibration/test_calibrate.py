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


class CaptureTests(unittest.TestCase):
    def test_extracts_sender_data_and_receiver_zero_window(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        output = "100\t10.0.0.1\t10.0.0.2\t18890\t40000\t0\t1000\t\t\t\t\n101\t10.0.0.2\t10.0.0.1\t40000\t18890\t0\t0\t\t\t1\t0\n"
        with patch.object(calibration.subprocess, 'run', return_value=SimpleNamespace(stdout=output)):
            rows = calibration.extract_rows('tshark', 'test.pcapng', '10.0.0.1', '10.0.0.2', 18890)
        self.assertEqual(rows[0]['length'], 1000)
        self.assertTrue(rows[1]['zero_window'])

    def test_rejects_incomplete_or_wrong_rate(self):
        rows = [{"time": t, "length": 1, "retransmission": False, "zero_window": False, "window": 0} for t in [0, 31]]
        with self.assertRaises(ValueError):
            calibration.analyze(rows, 1000, 30)

    def test_existing_output_is_not_overwritten(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'existing.json'
            output.write_text('keep')
            result = calibration.main(['--interface', '1', '--sender', '192.168.1.1', '--renderer', '192.168.1.2', '--udn', 'uuid:test', '--output', str(output)])
            self.assertEqual(result, 1)
            self.assertEqual(output.read_text(), 'keep')


class WorkflowTests(unittest.TestCase):
    def test_two_capture_workflow_writes_scoped_candidate(self):
        import tempfile
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'profile.json'
            sample = {"duration_seconds": 40, "unique_payload_bytes": 10000, "max_lead_ms": 1600, "first_flow_event_seconds": None, "retransmissions": 0, "zero_windows": 0}
            with patch('builtins.input', return_value=''), patch.object(calibration, 'capture') as capture, patch.object(calibration, 'extract_rows', return_value=[]), patch.object(calibration, 'analyze', return_value=sample):
                status = calibration.main(['--interface', '1', '--sender', '192.168.1.1', '--renderer', '192.168.1.2', '--udn', 'uuid:test', '--output', str(output)])
            self.assertEqual(status, 0)
            self.assertEqual(capture.call_count, 2)
            self.assertEqual(__import__('json').loads(output.read_text())['profiles'][0]['matcher']['udn'], 'uuid:test')

if __name__ == "__main__":
    unittest.main()
