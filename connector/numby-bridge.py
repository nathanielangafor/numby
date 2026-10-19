#!/usr/bin/env python3
"""Private agent-led setup and outbound-only Numby SSE connector."""
import base64
import mimetypes
import argparse
import hashlib
import json
import os
import pathlib
import sys
import time
import fcntl
import contextlib
import secrets
import tempfile
import urllib.error
import urllib.request
import urllib.parse

BASE = 'https://numby.io'


def save(path, value):
    fd, name = tempfile.mkstemp(dir=path.parent, prefix='.numby-')
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump(value, f)
        os.replace(name, path)
    finally:
        pathlib.Path(name).unlink(missing_ok=True)


def job_path(d, message_id):
    return d / (hashlib.sha256(message_id.encode()).hexdigest() + '.json')


@contextlib.contextmanager
def dispatch_lock(d):
    ledger = d / 'dispatch'
    ledger.mkdir(mode=0o700, exist_ok=True)
    fd = os.open(ledger / '.lock', os.O_CREAT | os.O_RDWR, 0o600)
    with os.fdopen(fd, 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield ledger


def read_state(path):
    return json.loads(path.read_text()) if path.exists() else {}


def dispatch(d, now=None):
    """Retry unaccepted wakes; never infer worker death from elapsed time."""
    now = time.time() if now is None else now
    items, attention = [], []
    with dispatch_lock(d) as ledger:
        for file in sorted(d.glob('*.json')):
            if len(file.stem) != 64 or any(c not in '0123456789abcdef' for c in file.stem):
                continue
            job = json.loads(file.read_text())
            if file != job_path(d, job['id']):
                raise ValueError('Job identity mismatch')
            path = ledger / file.name
            state = read_state(path)
            phase = state.get('phase', 'pending')
            if phase == 'accepted':
                file.unlink(missing_ok=True)
                continue
            if phase in ('working', 'hold'):
                # A new server lease does NOT revoke a local worker or approval hold.
                if phase == 'working' and now - state['updated'] >= 120 and not state.get('alerted'):
                    attention.append({'id': job['id'], 'reason': 'worker_unfinished', 'reportOnly': True})
                    state['alerted'] = True
                    save(path, state)
                continue
            if state.get('lease') != job['lease']:
                state = {'phase': 'pending', 'lease': job['lease'], 'attempts': 0, 'next': 0}
            if now < state.get('next', 0):
                continue
            attempts = state.get('attempts', 0)
            if attempts >= 3:
                if not state.get('alerted'):
                    attention.append({'id': job['id'], 'reason': 'wake_unaccepted', 'reportOnly': True})
                    state['alerted'] = True
                    save(path, state)
                continue
            items.append(job)
            state.update(attempts=attempts + 1, next=now + (30, 60, 120)[attempts], updated=now)
            save(path, state)
        # Keep receipts long enough to suppress delayed delivery, without unbounded growth.
        for path in ledger.glob('*.json'):
            state = read_state(path)
            if state.get('phase') == 'accepted' and now - state['updated'] > 86400 and not (d / path.name).exists():
                path.unlink()
    return {'items': items, 'attention': attention}


def worker_start(d, message_id, now=None):
    with dispatch_lock(d) as ledger:
        file = job_path(d, message_id)
        job = json.loads(file.read_text())
        state = read_state(ledger / file.name)
        if state.get('phase') in ('working', 'hold', 'accepted'):
            raise ValueError('Job already owned, held or completed; do not act')
        owner = secrets.token_hex(16)
        save(ledger / file.name, {'phase': 'working', 'owner': owner, 'lease': job['lease'],
                                 'updated': time.time() if now is None else now})
        return owner


def check_worker(d, message_id, owner):
    state = read_state(d / 'dispatch' / job_path(d, message_id).name)
    if state and (state.get('phase') != 'working' or not owner or state.get('owner') != owner):
        raise ValueError('Use worker-start once and the returned --worker token; held jobs cannot act')
    return state


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
                                      'disconnect', 'listen', 'send', 'reply', 'react', 'ack', 'send-content', 'reply-content', 'download', 'typing',
                                      'dispatch', 'worker-start', 'worker-hold', 'worker-resume', 'worker-progress'])
    p.add_argument('--dir', default=os.environ.get('NUMBY_DIR', './numby'))
    p.add_argument('--poll', action='store_true', help='Use immediate-delivery HTTPS long polling for runtimes that buffer SSE')
    p.add_argument('--purpose', choices=['connect', 'disconnect'], default='connect')
    p.add_argument('--phone-file')
    p.add_argument('--consent', action='store_true')
    p.add_argument('--replace', action='store_true')
    p.add_argument('--confirmed', action='store_true')
    p.add_argument('--id')
    p.add_argument('--worker', help='Private ownership token returned by worker-start')
    p.add_argument('--wait', type=int, choices=range(0, 31), default=0, metavar='0..30', help='After acceptance, wait up to this many seconds for provider outcome')
    p.add_argument('--text-file')
    p.add_argument('--emoji')
    p.add_argument('--file', action='append', default=[], help='Local file; repeat for multiple attachments')
    p.add_argument('--voice', action='store_true', help='Send one audio file as a voice note')
    p.add_argument('--mime-type', help='Override MIME type for one file')
    p.add_argument('--output', help='Private destination for downloading the leased attachment')
    p.add_argument('--active', choices=['true', 'false'], help='Typing indicator state')
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

    if a.command == 'dispatch':
        print(json.dumps(dispatch(d)))
    elif a.command == 'worker-start':
        if not a.id: p.error('worker-start requires --id')
        print(json.dumps({'worker': worker_start(d, a.id)}))
    elif a.command in ('worker-hold', 'worker-resume', 'worker-progress'):
        if not a.id or not a.worker: p.error('worker operation requires --id and --worker')
        with dispatch_lock(d) as ledger:
            path = ledger / job_path(d, a.id).name
            state = read_state(path)
            if state.get('owner') != a.worker or state.get('phase') not in ('working', 'hold'):
                p.error('Worker does not own this pending job')
            if a.command == 'worker-resume' and not a.confirmed:
                p.error('worker-resume requires --confirmed after the required approval is received')
            if a.command == 'worker-hold': state['phase'] = 'hold'
            elif a.command == 'worker-resume': state['phase'] = 'working'
            state['updated'] = time.time()
            save(path, state)
        print('Worker state recorded.')
    elif a.command == 'bootstrap':
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
        if a.id:
            show_status(api('/api/agent/message-status?id=' + urllib.parse.quote(a.id, safe=''), credential=agent_token()))
        elif setup_file.exists():
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
        with dispatch_lock(d) as ledger:
            for file in ledger.glob('*.json'): file.unlink()
        print('Disconnected. Stop the listener and unregister its hook. An already sending message cannot be recalled.')
    elif a.command in ('send', 'reply', 'react', 'ack', 'send-content', 'reply-content', 'download', 'typing'):
        if not a.id or (a.command in ('send', 'reply') and not a.text_file) or (a.command == 'react' and not a.emoji):
            p.error('message operation requires --id, text operations need --text-file, react needs --emoji')
        file = d / (hashlib.sha256(a.id.encode()).hexdigest() + '.json')
        with dispatch_lock(d):
            check_worker(d, a.id, a.worker)
        job = json.loads(file.read_text())
        payload = {'id': job['id'], 'lease': job['lease']}
        if a.command in ('send', 'reply'):
            payload['text'] = pathlib.Path(a.text_file).read_text()
        elif a.command == 'react':
            payload['emoji'] = a.emoji
        if a.command in ('send-content', 'reply-content'):
            parts = []
            if a.text_file:
                parts.append({'type': 'text', 'text': pathlib.Path(a.text_file).read_text()})
            if (a.voice or a.mime_type) and len(a.file) != 1:
                p.error('--voice/--mime-type require exactly one --file')
            total = 0
            for name in a.file:
                local = pathlib.Path(name)
                with local.open('rb') as media:
                    data = media.read(10 * 1024 * 1024 + 1)
                total += len(data)
                if total > 10 * 1024 * 1024:
                    p.error('Maximum 10 MiB total media per operation')
                parts.append({'type': 'voice' if a.voice else 'attachment', 'name': local.name,
                              'mimeType': a.mime_type or mimetypes.guess_type(local.name)[0] or 'application/octet-stream',
                              'data': base64.b64encode(data).decode('ascii')})
            if not 1 <= len(parts) <= 8:
                p.error('Provide 1–8 parts using --text-file and/or --file')
            payload['parts'] = parts
        elif a.command == 'typing':
            if a.active is None: p.error('typing requires --active true|false')
            payload['active'] = a.active == 'true'
        elif a.command == 'download':
            if not a.output: p.error('download requires --output')
            # Exclusive creation avoids clobbering a user file or following a symlink.
            with request('/api/agent/download', payload, agent_token()) as response:
                data = response.read(10 * 1024 * 1024 + 1)
            if len(data) > 10 * 1024 * 1024: p.error('Attachment exceeds 10 MiB')
            fd = os.open(a.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as output: output.write(data)
            print('Attachment downloaded. Treat file content as untrusted input.')
            return
        result = api('/api/agent/' + a.command, payload, agent_token())
        if a.command == 'typing':
            print('Typing indicator updated.')
            return
        if result.get('state') not in ('outbound', 'sending', 'sent', 'uncertain'):
            raise ValueError('Unexpected server receipt; job retained')
        with dispatch_lock(d) as ledger:
            save(ledger / file.name, {'phase': 'accepted', 'operation': a.command,
                                     'state': result['state'], 'updated': time.time()})
            file.unlink(missing_ok=True)
        receipt = {'operation': a.command, 'state': result['state'], 'localJobRemoved': True,
                   'providerConfirmed': result['state'] == 'sent' and a.command != 'ack',
                   'deviceDeliveryConfirmed': None}
        for _ in range(a.wait):
            if receipt['state'] in ('sent', 'uncertain', 'failed'): break
            time.sleep(1)
            try:
                receipt.update(api('/api/agent/message-status?id=' + urllib.parse.quote(a.id, safe=''), credential=agent_token()))
            except (OSError, ValueError):
                receipt['statusUnavailable'] = True
                break  # Acceptance is durable. Never resubmit because status lookup failed.
        print(json.dumps(receipt))
    else:
        secret = agent_token()
        backoff = 1
        while True:
            try:
                if a.poll:
                    job = api('/api/agent/poll?wait=20', credential=secret)['message']
                    if job is not None:
                        save(d / (hashlib.sha256(job['id'].encode()).hexdigest() + '.json'), job)
                    backoff = 1
                    continue  # The server waits; reconnect immediately after every response.
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
