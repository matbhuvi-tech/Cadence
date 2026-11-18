#!/usr/bin/env python3
"""On-demand UPnP TCP capture and conservative renderer-profile candidate generator."""
import argparse
import csv
import ipaddress
import json
import math
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def analyze(rows, bitrate, minimum_seconds):
    if not rows or not math.isfinite(bitrate) or bitrate <= 0:
        raise ValueError("capture has no sender payload or an invalid bitrate")
    rows = sorted(rows, key=lambda row: row["time"])
    origin = rows[0]["time"]
    if rows[-1]["time"] - origin < minimum_seconds:
        raise ValueError("capture has insufficient continuous observation time")
    total = 0
    max_lead = 0.0
    first_event = None
    retransmissions = zero_windows = 0
    for row in rows:
        elapsed = row["time"] - origin
        if row["retransmission"]:
            retransmissions += 1
        else:
            total += row["length"]
        if row["zero_window"]:
            zero_windows += 1
        if first_event is None and (row["retransmission"] or row["zero_window"]):
            first_event = elapsed
        if first_event is None:
            max_lead = max(max_lead, 1000 * (total / bitrate - elapsed))
    if total <= 0:
        raise ValueError("capture has no unique sender payload")
    observed_rate = total / (rows[-1]["time"] - origin)
    if not 0.8 * bitrate <= observed_rate <= 1.5 * bitrate:
        raise ValueError("capture rate is inconsistent with the selected test format")
    return {"duration_seconds": round(rows[-1]["time"] - origin, 3),
            "unique_payload_bytes": total, "max_lead_ms": round(max_lead),
            "first_flow_event_seconds": first_event, "retransmissions": retransmissions,
            "zero_windows": zero_windows}


def make_profile(udn, dsd, pcm):
    if not udn or not udn.strip() or len(udn) > 512:
        raise ValueError("a renderer UDN is required")
    lead = min(1200, max(0, min(dsd["max_lead_ms"], pcm["max_lead_ms"]) // 2))
    config = {"initial_lead_target_ms": lead, "initial_fill_lead_ms": lead,
              "initial_overfeed_multiplier": 1.0, "min_steady_multiplier": 1.0,
              "max_overfeed_multiplier": 1.0, "soft_ceiling_floor": 1.0,
              "lock_cruise_on_fill_or_backoff": True, "retrans_only_backoff": True,
              "disable_sleep_for_tests": False}
    return {"schema_version": 1, "default_profile": {}, "profiles": [{
        "id": "calibration-candidate", "description": "Unqualified candidate; validate on this renderer before use",
        "learned_from_stress_test": False, "matcher": {"udn": udn.strip()},
        "pacer_config": config}], "calibration_evidence": {"dsd256": dsd, "redbook": pcm}}


def extract_rows(tshark, capture, sender, receiver, port):
    fields = ["frame.time_epoch", "ip.src", "ip.dst", "tcp.srcport", "tcp.dstport", "tcp.stream",
              "tcp.len", "tcp.analysis.retransmission", "tcp.analysis.fast_retransmission",
              "tcp.analysis.zero_window", "tcp.window_size"]
    args = [tshark, "-n", "-r", str(capture), "-Y", "tcp", "-T", "fields", "-E", "separator=/t"]
    for field in fields:
        args.extend(["-e", field])
    result = subprocess.run(args, check=True, capture_output=True, text=True, encoding="utf-8", errors="replace")
    flows = {}
    for values in csv.reader(result.stdout.splitlines(), delimiter="\t"):
        if len(values) != len(fields):
            continue
        timestamp, src, dst, sport, dport, stream, length, retrans, fast, zero, window = values
        forward = src == sender and dst == receiver and sport == str(port)
        reverse = src == receiver and dst == sender and dport == str(port)
        if not (forward or reverse) or not stream:
            continue
        try:
            row = {"time": float(timestamp), "length": int(length or 0) if forward else 0,
                   "retransmission": bool(retrans or fast) if forward else False,
                   "zero_window": bool(zero) if reverse else False,
                   "window": int(window or 0) if reverse else 0}
        except ValueError:
            raise ValueError("invalid TCP field in capture") from None
        flows.setdefault(stream, []).append(row)
    active = [rows for rows in flows.values() if sum(r["length"] for r in rows) > 0]
    if len(active) != 1:
        raise ValueError(f"expected exactly one media TCP stream, found {len(active)}")
    rows = active[0]
    start = next((r["time"] for r in rows if r["length"] > 0), None)
    return [r for r in rows if r["time"] >= start]


def capture(tshark, interface, sender, receiver, port, duration, destination):
    capture_filter = f"tcp and host {sender} and host {receiver} and port {port}"
    command = [tshark, "-n", "-i", interface, "-f", capture_filter,
               "-a", f"duration:{duration}", "-w", str(destination)]
    subprocess.run(command, check=True)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--interface", required=True, help="TShark capture interface; list with tshark -D")
    p.add_argument("--sender", required=True, help="playback engine IPv4 address")
    p.add_argument("--renderer", required=True, help="renderer IPv4 address")
    p.add_argument("--udn", required=True, help="exact renderer UPnP UDN")
    p.add_argument("--port", type=int, default=18890)
    p.add_argument("--seconds", type=int, default=90)
    p.add_argument("--output", type=Path, required=True, help="new candidate JSON path")
    p.add_argument("--tshark", default="tshark")
    args = p.parse_args(argv)
    try:
        sender = str(ipaddress.IPv4Address(args.sender))
        receiver = str(ipaddress.IPv4Address(args.renderer))
        if sender == receiver or not 1 <= args.port <= 65535 or not 45 <= args.seconds <= 600:
            raise ValueError("use distinct IPv4 addresses, a valid port, and 45–600 seconds")
        if args.output.exists():
            raise ValueError("output already exists; choose a new path")
        results = {}
        with tempfile.TemporaryDirectory(prefix="cadence-calibration-") as tmp:
            for name, rate, instructions in [("dsd256", 2_822_400, "stereo DSD256"),
                                               ("redbook", 176_400, "stereo 44.1 kHz / 16-bit WAV")]:
                print(f"Prepare {instructions} on the generic UPnP pacer. Press Enter to start capture, then start playback immediately.", flush=True)
                input()
                path = Path(tmp) / f"{name}.pcapng"
                capture(args.tshark, args.interface, sender, receiver, args.port, args.seconds, path)
                results[name] = analyze(extract_rows(args.tshark, path, sender, receiver, args.port), rate, 30)
                print(f"{name}: {json.dumps(results[name])}", flush=True)
                print("Stop playback and wait for the engine's 30-second cooldown before continuing.", flush=True)
                input("Press Enter when idle: ")
        profile = make_profile(args.udn, results["dsd256"], results["redbook"])
        with args.output.open("x", encoding="utf-8") as output:
            json.dump(profile, output, indent=2, allow_nan=False)
            output.write("\n")
        print(f"Candidate written to {args.output}. This profile is unqualified; validate it with new PCM and DSD captures.")
        return 0
    except (ValueError, OSError, subprocess.CalledProcessError, EOFError, KeyboardInterrupt) as exc:
        print(f"Calibration failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
