import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('bridge', pathlib.Path(__file__).parents[1] / 'connector/numby-bridge.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class ConnectorTest(unittest.TestCase):
    def test_private_bootstrap_claim_and_disconnect(self):
        with tempfile.TemporaryDirectory() as td:
            path=pathlib.Path(td)
            def run(args, response):
                stdout=io.StringIO()
                with patch('sys.argv',['bridge',*args,'--dir',td]), patch.object(bridge,'api',return_value=response) as api, contextlib.redirect_stdout(stdout):
                    bridge.main()
                return stdout.getvalue(),api
            text,_=run(['bootstrap'],{'setupToken':'private-setup','purpose':'connect','expiresAt':123})
            self.assertNotIn('private-setup',text)
            self.assertEqual((path/'setup.json').stat().st_mode & 0o777,0o600)
            text,api=run(['claim'],{'token':'private-agent','assigned':'+14155550100','shared':True})
            self.assertNotIn('private-agent',text)
            self.assertFalse((path/'setup.json').exists())
            self.assertEqual((path/'credential.json').stat().st_mode & 0o777,0o600)
            api.assert_called_with('/api/setup/claim',{'replace':False},'private-setup')
            text,api=run(['disconnect','--confirmed'],{'disconnected':True})
            api.assert_called_with('/api/agent/disconnect',{},'private-agent')
            self.assertFalse((path/'credential.json').exists())

    def test_phone_requires_consent(self):
        with tempfile.TemporaryDirectory() as td:
            with patch('sys.argv',['bridge','start','--dir',td]), patch.object(bridge,'api') as api, contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit): bridge.main()
                api.assert_not_called()

    def test_long_poll_reconnects_immediately_and_saves_private_event(self):
        with tempfile.TemporaryDirectory() as td:
            path = pathlib.Path(td)
            bridge.save(path / 'credential.json', {'token': 'private-agent'})
            job = {'id': 'message', 'lease': 'lease', 'conversation': 'dm', 'text': 'test'}
            with patch('sys.argv', ['bridge', 'listen', '--poll', '--dir', td]), patch.object(bridge, 'api', side_effect=[{'message': job}, {'message': None}, KeyboardInterrupt]) as api, patch.object(bridge.time, 'sleep') as sleep:
                with self.assertRaises(KeyboardInterrupt): bridge.main()
                self.assertEqual(api.call_count, 3)
                api.assert_called_with('/api/agent/poll?wait=20', credential='private-agent')
                sleep.assert_not_called()
            file = path / (bridge.hashlib.sha256(b'message').hexdigest() + '.json')
            self.assertEqual(json.loads(file.read_text()), job)
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)

if __name__ == '__main__': unittest.main()
