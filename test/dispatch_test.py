import concurrent.futures
import contextlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).parents[1] / 'connector/numby-bridge.py'
spec = importlib.util.spec_from_file_location('bridge', SCRIPT)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

class DispatchTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.d = pathlib.Path(self.tmp.name)
        self.job = {'id':'message', 'lease':'lease-1', 'conversation':'dm', 'kind':'text', 'text':'hello'}
        bridge.save(bridge.job_path(self.d, 'message'), self.job)
        bridge.save(self.d/'credential.json', {'token':'private'})

    def run_command(self, args, response=None):
        with patch('sys.argv', ['bridge', *args, '--dir', str(self.d)]), patch.object(bridge, 'api', return_value=response) as api, contextlib.redirect_stdout(io.StringIO()) as out:
            bridge.main()
            return out.getvalue(), api

    def test_lost_wake_is_retried_then_reported_once(self):
        self.assertEqual(len(bridge.dispatch(self.d, 0)['items']), 1)
        self.assertFalse(bridge.dispatch(self.d, 29)['items'])
        self.assertEqual(len(bridge.dispatch(self.d, 30)['items']), 1)
        self.assertEqual(len(bridge.dispatch(self.d, 90)['items']), 1)
        result = bridge.dispatch(self.d, 210)
        self.assertFalse(result['items'])
        self.assertEqual(result['attention'][0]['reason'], 'wake_unaccepted')
        self.assertFalse(bridge.dispatch(self.d, 999)['attention'])

    def test_claim_never_expires_into_duplicate_execution(self):
        owner = bridge.worker_start(self.d, 'message', 0)
        self.assertFalse(bridge.dispatch(self.d, 60)['items'])
        result = bridge.dispatch(self.d, 120)
        self.assertEqual(result['attention'][0]['reason'], 'worker_unfinished')
        self.job['lease']='lease-2'
        bridge.save(bridge.job_path(self.d, 'message'), self.job)
        self.assertFalse(bridge.dispatch(self.d, 99999)['items'])
        with self.assertRaises(ValueError): bridge.worker_start(self.d, 'message', 99999)
        self.assertEqual(bridge.check_worker(self.d, 'message', owner)['phase'], 'working')

    def test_real_processes_cannot_both_claim(self):
        def claim(_):
            return subprocess.run([sys.executable,str(SCRIPT),'worker-start','--dir',str(self.d),'--id','message'],capture_output=True).returncode
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            results=list(pool.map(claim, range(2)))
        self.assertEqual(sorted(results), [0,1])

    def test_hold_persists_through_time_and_release(self):
        owner = bridge.worker_start(self.d, 'message', 0)
        self.run_command(['worker-hold','--id','message','--worker',owner])
        self.job['lease']='lease-2'; bridge.save(bridge.job_path(self.d,'message'), self.job)
        self.assertEqual(bridge.dispatch(self.d,99999999999), {'items':[], 'attention':[]})
        with self.assertRaises(ValueError): bridge.check_worker(self.d,'message',owner)
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            self.run_command(['worker-resume','--id','message','--worker',owner])
        self.run_command(['worker-resume','--id','message','--worker',owner,'--confirmed'])
        bridge.check_worker(self.d,'message',owner)

    def test_owner_required_after_dispatch(self):
        bridge.dispatch(self.d,0)
        with self.assertRaises(ValueError): self.run_command(['ack','--id','message'], {'state':'sent'})
        owner = bridge.worker_start(self.d,'message',0)
        with self.assertRaises(ValueError): self.run_command(['ack','--id','message','--worker','wrong'], {'state':'sent'})
        out,_ = self.run_command(['ack','--id','message','--worker',owner], {'state':'sent'})
        self.assertTrue(json.loads(out)['localJobRemoved'])
        self.assertFalse(json.loads(out)['providerConfirmed'])
        self.assertFalse(bridge.job_path(self.d,'message').exists())
        # A delayed repeated stream event must not create a second worker.
        bridge.save(bridge.job_path(self.d,'message'),self.job)
        self.assertEqual(bridge.dispatch(self.d,1),{'items':[],'attention':[]})

    def test_failed_request_retains_owned_job(self):
        owner=bridge.worker_start(self.d,'message',0)
        with patch('sys.argv',['bridge','ack','--dir',str(self.d),'--id','message','--worker',owner]), patch.object(bridge,'api',side_effect=OSError('connection lost')):
            with self.assertRaises(OSError): bridge.main()
        self.assertTrue(bridge.job_path(self.d,'message').exists())
        self.assertEqual(bridge.check_worker(self.d,'message',owner)['phase'],'working')

    def test_released_unaccepted_job_gets_new_wake(self):
        bridge.dispatch(self.d,0)
        self.job['lease']='lease-2'; bridge.save(bridge.job_path(self.d,'message'),self.job)
        self.assertEqual(len(bridge.dispatch(self.d,1)['items']),1)

    def test_credentials_never_enter_dispatch_payload(self):
        self.assertNotIn('private', json.dumps(bridge.dispatch(self.d,0)))
        self.assertEqual((self.d/'dispatch').stat().st_mode & 0o777,0o700)

    def test_terminal_wait_reports_failure_without_resubmission(self):
        owner = bridge.worker_start(self.d, 'message', 0)
        reply = self.d / 'reply.txt'; reply.write_text('hello')
        with patch('sys.argv', ['bridge','send','--dir',str(self.d),'--id','message','--worker',owner,'--text-file',str(reply),'--wait','5']), patch.object(bridge,'api',side_effect=[{'state':'outbound'},{'state':'uncertain','needsAttention':True,'providerConfirmed':False,'delivery':{'code':'recipientCoolingDown'}}]) as api, patch.object(bridge.time,'sleep'), contextlib.redirect_stdout(io.StringIO()) as out:
            bridge.main()
        result=json.loads(out.getvalue())
        self.assertEqual(result['state'],'uncertain')
        self.assertFalse(result['providerConfirmed'])
        self.assertEqual(api.call_count,2)
        self.assertEqual(api.call_args.args[0],'/api/agent/message-status?id=message')
        self.assertFalse(bridge.job_path(self.d,'message').exists())

    def test_reference_hook_uses_shared_dispatch_and_report_only_attention(self):
        runtime = self.d / 'runtime.sh'
        runtime.write_text('wake() { printf "%s\\n" "$2"; exit 0; }\nsilent() { printf "%s\\n" "$2"; exit 0; }\n')
        env = dict(os.environ, NUMBY_DIR=str(self.d), NUMBY_BRIDGE=str(SCRIPT.resolve()), HATCH_HOOK_RUNTIME=str(runtime))
        def hook():
            return json.loads(subprocess.check_output(['bash', str(SCRIPT.with_name('numby-hook.sh'))], env=env))
        self.assertEqual(hook()['items'][0]['id'], 'message')
        self.assertEqual(hook(), {})
        bridge.worker_start(self.d, 'message', 0)
        attention = hook()['attention'][0]
        self.assertTrue(attention['reportOnly'])
        self.assertEqual(attention['reason'], 'worker_unfinished')
        self.assertEqual(hook(), {})

if __name__=='__main__': unittest.main()
