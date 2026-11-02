"""Explicit deployment planning tests; no pip/venv/model install is performed."""
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import setup_environment as setup


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='setup-plan-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.state = self.root / 'state'

    def args(self, *extra):
        return setup.parser().parse_args(['--state-dir', str(self.state), *extra])

    def test_default_plan_writes_nothing(self):
        args = self.args()
        with patch.object(setup, 'run_step', side_effect=AssertionError('must not execute')):
            result = setup.execute(args, setup.build_plan(args))
        self.assertEqual(result['status'], 'plan_only')
        self.assertFalse(self.state.exists())
        self.assertIsNone(result['model'])
        self.assertEqual(result['requirements'], ['yt-dlp==2026.8.19'])

    def test_cloud_plan_has_no_local_model_dependency(self):
        plan = setup.build_plan(self.args('--backend', 'cloud'))
        self.assertIsNone(plan['model_repository'])
        self.assertNotIn('faster-whisper==1.2.1', plan['requirements'])

    def test_local_plan_is_explicit_and_fixed_source(self):
        plan = setup.build_plan(self.args('--backend', 'local', '--model', 'small'))
        self.assertFalse(plan['approved'])
        self.assertEqual(plan['model_repository'], 'Systran/faster-whisper-small')
        self.assertIn('faster-whisper==1.2.1', plan['requirements'])
        self.assertEqual(plan['model_dir'], str(self.state / 'models' / 'small'))

    def test_relative_state_and_authenticated_proxy_rejected(self):
        for values in (['--state-dir', 'relative'], ['--state-dir', str(self.state), '--proxy', 'http://u:secret@host:80'],
                       ['--state-dir', str(self.state), '--proxy', 'https://host:443']):
            with self.subTest(values=values), self.assertRaises(setup.SetupError):
                setup.build_plan(setup.parser().parse_args(values))

    def test_environment_does_not_inherit_tokens_proxies_or_python_hooks(self):
        with patch.dict(os.environ, {'HF_TOKEN': 'DO_NOT_READ', 'HTTPS_PROXY': 'http://evil:1',
                                    'HF_ENDPOINT': 'https://evil', 'PYTHONPATH': 'evil',
                                    'PYTHONSTARTUP': 'evil'}):
            environment = setup.clean_environment(self.state, None)
        for key in ('HF_TOKEN', 'HTTPS_PROXY', 'HF_ENDPOINT', 'PYTHONPATH', 'PYTHONSTARTUP'):
            self.assertNotIn(key, environment)
        self.assertEqual(environment['HF_HUB_DISABLE_IMPLICIT_TOKEN'], '1')

    def test_explicit_proxy_only_in_child_environment(self):
        environment = setup.clean_environment(self.state, 'http://127.0.0.1:7897')
        self.assertEqual(environment['HTTPS_PROXY'], 'http://127.0.0.1:7897')

    def test_unowned_existing_venv_is_never_modified(self):
        (self.state / 'venv').mkdir(parents=True)
        args = self.args('--allow-downloads')
        execute = Mock()
        with patch.object(setup, 'run_step', execute), self.assertRaises(setup.SetupError):
            setup.execute(args, setup.build_plan(args))
        execute.assert_not_called()

    def test_owned_environment_commands_remain_isolated_and_no_global_path_changes(self):
        venv = self.state / 'venv'
        venv.mkdir(parents=True)
        (venv / setup.OWNER_MARKER).write_text('owned fixture', encoding='utf-8')
        args = self.args('--allow-downloads', '--backend', 'cloud')
        with patch.object(setup, 'run_step') as execute:
            result = setup.execute(args, setup.build_plan(args))
        self.assertEqual(result['status'], 'prepared_not_runtime_verified')
        command = execute.call_args_list[0].args[0]
        self.assertIn('--isolated', command)
        self.assertIn('--only-binary=:all:', command)
        self.assertIn('https://pypi.org/simple', command)
        self.assertIn('venv', command[0])
        self.assertTrue((self.state / 'last-setup.json').is_file())

    def test_model_fetch_disables_implicit_auth_and_limits_download_files(self):
        self.assertIn('token=False', setup.MODEL_DOWNLOAD)
        self.assertIn("endpoint='https://huggingface.co'", setup.MODEL_DOWNLOAD)
        self.assertIn('allow_patterns=', setup.MODEL_DOWNLOAD)
        self.assertNotIn('trust_remote_code', setup.MODEL_DOWNLOAD)


if __name__ == '__main__':
    unittest.main()
