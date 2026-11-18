"""Exercise a running Windows engine with an existing catalog track (no LLM).

Run with --track-id to replace its queue and start playback. This changes the
live engine's queue and output state; use a dedicated test engine when possible.
"""
import argparse
import json
import os
import pathlib
import ssl
import sys
import time
import urllib.request
import uuid


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pairing', type=pathlib.Path, default=pathlib.Path(os.environ['LOCALAPPDATA']) / 'CadenceEngine' / 'localhost-pairing.json')
    parser.add_argument('--track-id', help='existing catalog track ID; replaces the live queue and starts playback')
    args = parser.parse_args()
    pairing = json.loads(args.pairing.read_text(encoding='utf-8-sig'))
    # This loopback-only diagnostic uses the engine's self-signed certificate.
    if not pairing['baseUrl'].startswith('https://127.0.0.1:'):
        raise ValueError('pairing URL must be a loopback HTTPS endpoint')
    context = ssl._create_unverified_context()
    base = {'protocolVersion': 1, 'engineId': pairing['engineId'], 'libraryId': pairing['libraryId']}

    def request(operation, **fields):
        body = json.dumps({**base, 'operation': operation, **fields}).encode()
        req = urllib.request.Request(pairing['baseUrl'] + '/v1/core', data=body,
                                     headers={'Content-Type': 'application/json', 'x-cadence-token': pairing['token']})
        with urllib.request.urlopen(req, context=context, timeout=30) as response:
            return json.load(response)

    def checked(operation, **fields):
        response = request(operation, **fields)
        if not response.get('ok'):
            raise RuntimeError(f"{operation}: {response.get('error')}")
        return response['data']

    snapshot = checked('session.snapshot')
    print('snapshot:', json.dumps({'revision': snapshot['revision'], 'playback': snapshot['playback'], 'queue': snapshot['queue']}))
    if not args.track_id:
        print('Read-only check complete. Supply --track-id to exercise playback.')
        return
    if snapshot['playback'].get('activity') != 'idle':
        raise RuntimeError('engine is not idle; refusing to replace the live queue')
    entry = {'entryId': 'qa_' + uuid.uuid4().hex, 'trackId': args.track_id}
    snapshot = checked('queue.replace', commandId='qa_' + uuid.uuid4().hex,
                       expectedRevision=snapshot['revision'], entries=[entry])
    print('queue.replace: accepted')
    snapshot = checked('playback.control', action='play', trackId=args.track_id,
                       commandId='qa_' + uuid.uuid4().hex, expectedRevision=snapshot['revision'])
    for _ in range(20):
        snapshot = checked('session.snapshot')
        if snapshot['playback'].get('activity') == 'playing':
            print('PASS: track queued and playback started')
            return
        time.sleep(1)
    raise RuntimeError('playback did not reach playing within 20 seconds')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'FAIL: {exc}', file=sys.stderr)
        sys.exit(1)
