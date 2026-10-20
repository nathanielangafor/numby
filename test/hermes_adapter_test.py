import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
adapter = load('hermes_adapter', ROOT / 'connector/numby-hermes.py')
bridge = load('numby_bridge', ROOT / 'connector/numby-bridge.py')

class HermesAdapterTests(unittest.TestCase):
    def test_private_payload_uses_stdin_and_explicit_session(self):
        args = SimpleNamespace(hermes='/bin/hermes', profile='owner', session='dedicated-id',
                               skill=Path('/private/skill.md'), bridge=Path('/private/bridge.py'), directory=Path('/private/state'))
        payload = {'items': [{'text': '$(touch /tmp/do-not-run)', 'lease': 'secret'}], 'attention': []}
        with patch.object(adapter.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as call:
            self.assertEqual(adapter.invoke(args,payload),0)
        argv = call.call_args.args[0]
        self.assertEqual(argv, ['/bin/hermes','-p','owner','chat','--resume','dedicated-id','--query-file','-'])
        self.assertNotIn('secret',' '.join(argv))
        self.assertIn('$(touch /tmp/do-not-run)',call.call_args.kwargs['input'])
        self.assertNotIn('shell',call.call_args.kwargs)

    def test_no_empty_wake(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(adapter, 'invoke') as invoke:
            args=SimpleNamespace(directory=Path(directory))
            self.assertEqual(adapter.run_once(args,bridge),0)
            invoke.assert_not_called()

    def test_owned_work_never_replayed_and_attention_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            d=Path(directory); args=SimpleNamespace(directory=d)
            for message_id in ['owned','fresh']:
                bridge.save(bridge.job_path(d,message_id), {'id':message_id,'lease':'lease','text':'hello'})
            owner=bridge.worker_start(d,'owned',now=0)
            with patch.object(adapter,'invoke',return_value=1) as invoke:
                self.assertEqual(adapter.run_once(args,bridge),1)
                payload=invoke.call_args.args[1]
                self.assertEqual([x['id'] for x in payload['items']],['fresh'])
                self.assertEqual(payload['attention'][0]['id'],'owned')
                self.assertTrue(payload['attention'][0]['reportOnly'])
            self.assertEqual(bridge.check_worker(d,'owned',owner)['phase'],'working')
            with patch.object(adapter,'invoke') as invoke:
                adapter.run_once(args,bridge)
                invoke.assert_not_called()

if __name__=='__main__': unittest.main()
