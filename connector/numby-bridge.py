#!/usr/bin/env python3
"""Private agent-led setup and outbound-only Numby SSE connector."""
import argparse
import hashlib
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

BASE = 'https://numby.io'


def save(path, value):
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    os.chmod(temp, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(value, f)
    os.replace(temp, path)


def request(path, data=None, credential=None):
    headers = {'Content-Type': 'application/json'}
    if credential:
        headers['Authorization'] = 'Bearer ' + credential
    return urllib.request.urlopen(urllib.request.Request(
        BASE + path, data=json.dumps(data).encode() if data is not None else None,
        headers=headers), timeout=60)


def api(path, data=None, credential=None):
    with request(path, data, credential) as r:
        return json.load(r)


def main():
    p = argparse.ArgumentParser()
    p.add_argument('command', choices=['bootstrap', 'start', 'status', 'claim', 'cancel',
                                      'disconnect', 'listen', 'send', 'reply', 'react', 'ack'])
    p.add_argument('--dir', default=os.environ.get('NUMBY_DIR', './numby'))
    p.add_argument('--poll', action='store_true', help='Use finite HTTPS polling for runtimes that buffer SSE')
    p.add_argument('--purpose', choices=['connect', 'disconnect'], default='connect')
    p.add_argument('--phone-file')
    p.add_argument('--consent', action='store_true')
    p.add_argument('--replace', action='store_true')
    p.add_argument('--confirmed', action='store_true')
    p.add_argument('--id')
    p.add_argument('--text-file')
    p.add_argument('--emoji')
    a = p.parse_args()
    d = pathlib.Path(a.dir).resolve()
    d.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(d, 0o700)
    setup_file, credential_file = d / 'setup.json', d / 'credential.json'

    def setup_token():
        return json.loads(setup_file.read_text())['setupToken']

    def agent_token():
        return json.loads(credential_file.read_text())['token']

    def show_status(result):
        # The ownership challenge is intended for the user; credentials never are.
        print(json.dumps(result))

    if a.command == 'bootstrap':
        if setup_file.exists():
            p.error('A setup is already saved. Use status or cancel before starting again.')
        result = api('/api/setup/bootstrap', {'purpose': a.purpose})
        save(setup_file, result)
        print(json.dumps({'state': 'awaiting_phone', 'purpose': result['purpose'],
                          'expiresAt': result['expiresAt']}))
    elif a.command == 'start':
        if not a.consent or not a.phone_file:
            p.error('start requires --consent and --phone-file after owner permission')
        phone = pathlib.Path(a.phone_file).read_text().strip()
        show_status(api('/api/setup/start', {'phone': phone, 'consent': True}, setup_token()))
    elif a.command == 'status':
        if setup_file.exists():
            show_status(api('/api/setup/status', credential=setup_token()))
        else:
            show_status(api('/api/agent/status', credential=agent_token()))
    elif a.command == 'claim':
        result = api('/api/setup/claim', {'replace': a.replace}, setup_token())
        save(credential_file, {'token': result['token']})
        setup_file.unlink()
        print(json.dumps({'state': 'paired', 'assigned': result['assigned'], 'shared': True}))
    elif a.command == 'cancel':
        try:
            api('/api/setup/cancel', {}, setup_token())
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
        setup_file.unlink(missing_ok=True)
        print('Setup cancelled. Existing pairing is unchanged.')
    elif a.command == 'disconnect':
        if not a.confirmed:
            p.error('disconnect requires --confirmed after the owner requests it')
        if setup_file.exists():
            api('/api/setup/disconnect', {}, setup_token())
        else:
            api('/api/agent/disconnect', {}, agent_token())
        setup_file.unlink(missing_ok=True)
        credential_file.unlink(missing_ok=True)
        for file in d.glob('*.json'):
            if len(file.stem) == 64 and all(c in '0123456789abcdef' for c in file.stem):
                file.unlink()
        print('Disconnected. Stop the listener and unregister its hook. An already sending message cannot be recalled.')
    elif a.command in ('send', 'reply', 'react', 'ack'):
        if not a.id or (a.command in ('send', 'reply') and not a.text_file) or (a.command == 'react' and not a.emoji):
            p.error('message operation requires --id, text operations need --text-file, react needs --emoji')
        file = d / (hashlib.sha256(a.id.encode()).hexdigest() + '.json')
        job = json.loads(file.read_text())
        payload = {'id': job['id'], 'lease': job['lease']}
        if a.command in ('send', 'reply'):
            payload['text'] = pathlib.Path(a.text_file).read_text()
        elif a.command == 'react':
            payload['emoji'] = a.emoji
        result = api('/api/agent/' + a.command, payload, agent_token())
        file.unlink(missing_ok=True)
        print('Operation accepted:', result['state'])
    else:
        secret = agent_token()
        backoff = 1
        while True:
            try:
                if a.poll:
                    job = api('/api/agent/poll', credential=secret)['message']
                    if job is not None:
                        save(d / (hashlib.sha256(job['id'].encode()).hexdigest() + '.json'), job)
                    backoff = 1
                    time.sleep(5)
                else:
                    with request('/api/agent/events', credential=secret) as stream:
                        backoff = 1
                        for line in stream:
                            if line.startswith(b'data: '):
                                job = json.loads(line[6:])
                                save(d / (hashlib.sha256(job['id'].encode()).hexdigest() + '.json'), job)
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    sys.exit('Credential revoked. Use agent-led bootstrap and fresh phone verification to reconnect.')
                print('Connection unavailable; reconnecting.', file=sys.stderr)
            except (OSError, ValueError):
                print('Connection interrupted; reconnecting.', file=sys.stderr)
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as e:
        # Server errors are deliberately safe and never include submitted secrets.
        try:
            message = json.load(e).get('error', 'Request failed.')
        except (ValueError, OSError):
            message = 'Request failed.'
        sys.exit(f'Numby HTTP {e.code}: {message}')
    except (OSError, ValueError, KeyError):
        sys.exit('Private state or connection unavailable. Inspect local files privately; do not paste credentials. If a claim response was lost, bootstrap again and verify your phone to recover.')
