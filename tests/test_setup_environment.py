"""Explicit base-venv planning tests; no pip/venv/model install is performed."""
import contextlib
import io
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
        self.assertEqual(result['requirements'], ['yt-dlp==2026.8.19', 'python-docx==1.2.0'])
        self.assertFalse(any(key.startswith('model') for key in result))

    def test_both_backend_plans_have_only_base_dependencies(self):
        for backend in ('captions', 'cloud'):
            with self.subTest(backend=backend):
                plan = setup.build_plan(self.args('--backend', backend))
                self.assertEqual(plan['backend'], backend)
                self.assertEqual(plan['requirements'], ['yt-dlp==2026.8.19', 'python-docx==1.2.0'])
                self.assertEqual(plan['package_index'], 'https://pypi.org/simple')
                self.assertFalse(plan['approved'])
                self.assertFalse(any(key.startswith('model') for key in plan))

    def test_parser_rejects_local_and_removed_model_option(self):
        for extra in (('--backend', 'local'), ('--backend', 'other'), ('--model', 'small'),
                      ('--backend', 'cloud', '--model', 'small')):
            with self.subTest(extra=extra), contextlib.redirect_stderr(io.StringIO()), \
                 self.assertRaises(SystemExit) as caught:
                self.args(*extra)
            self.assertEqual(caught.exception.code, 2)
        self.assertFalse(self.state.exists())

    def test_non_cli_local_backend_rejected_before_filesystem_or_execution(self):
        args = self.args('--allow-downloads')
        plan = setup.build_plan(args)
        args.backend = 'local'
        with patch.object(setup, 'run_step') as execute:
            with self.assertRaises(setup.SetupError) as caught:
                setup.build_plan(args)
            self.assertIn('captions/cloud', str(caught.exception))
            with self.assertRaises(setup.SetupError):
                setup.execute(args, plan)
        execute.assert_not_called()
        self.assertFalse(self.state.exists())

    def test_relative_state_and_authenticated_proxy_rejected(self):
        for values in (['--state-dir', 'relative'], ['--state-dir', str(self.state), '--proxy', 'http://u:secret@host:80'],
                       ['--state-dir', str(self.state), '--proxy', 'https://host:443']):
            with self.subTest(values=values), self.assertRaises(setup.SetupError):
                setup.build_plan(setup.parser().parse_args(values))

    def test_environment_does_not_inherit_tokens_proxies_or_python_hooks(self):
        with patch.dict(os.environ, {'HF_TOKEN': 'DO_NOT_READ', 'HTTPS_PROXY': 'http://evil:1',
                                    'HF_ENDPOINT': 'https://evil', 'HF_HOME': 'evil',
                                    'PYTHONPATH': 'evil', 'PYTHONSTARTUP': 'evil'}):
            environment = setup.clean_environment(self.state, None)
        for key in ('HF_TOKEN', 'HTTPS_PROXY', 'HF_ENDPOINT', 'HF_HOME', 'HF_HUB_DISABLE_IMPLICIT_TOKEN',
                    'PYTHONPATH', 'PYTHONSTARTUP'):
            self.assertNotIn(key, environment)

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

    def test_original_plugin_venv_marker_is_not_owned_by_cloud_plugin(self):
        venv = self.state / 'venv'
        venv.mkdir(parents=True)
        (venv / '.dsh-video-study-venv').write_text('original fixture', encoding='utf-8')
        args = self.args('--allow-downloads')
        with patch.object(setup, 'run_step') as execute, self.assertRaises(setup.SetupError):
            setup.execute(args, setup.build_plan(args))
        execute.assert_not_called()
        self.assertEqual(setup.OWNER_MARKER, '.dsh-video-study-cloud-venv')

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
        self.assertEqual(execute.call_count, 3)  # pip install, pip check, version snapshot only
        self.assertTrue((self.state / 'last-setup.json').is_file())
        self.assertFalse((self.state / 'models').exists())

    def test_installer_scratch_is_state_local_private_and_removed(self):
        args = self.args('--allow-downloads')
        before = dict(os.environ)
        seen = []
        def fixture_step(command, environment, timeout):
            scratch = Path(environment['TMP'])
            self.assertEqual(scratch.parent, self.state)
            self.assertTrue(scratch.is_dir())
            self.assertTrue(scratch.name.startswith('.setup-'))
            for key in ('TMP', 'TEMP', 'TMPDIR'):
                self.assertEqual(environment[key], str(scratch))
            seen.append(scratch)
            if command[1:4] == ['-I', '-m', 'venv']:
                (self.state / 'venv').mkdir()
        with patch.object(setup, 'run_step', side_effect=fixture_step), \
             patch.object(tempfile, 'gettempdir', side_effect=AssertionError('no global temp')):
            setup.execute(args, setup.build_plan(args))
        self.assertTrue(seen)
        self.assertEqual(len(set(seen)), 1)
        self.assertFalse(seen[0].exists())
        self.assertEqual(dict(os.environ), before)

    def test_installer_failure_cleans_only_its_scratch(self):
        args = self.args('--allow-downloads')
        seen = []
        def fail_step(command, environment, timeout):
            seen.append(Path(environment['TMP']))
            raise setup.SetupError('fixture failure')
        with patch.object(setup, 'run_step', side_effect=fail_step), self.assertRaises(setup.SetupError):
            setup.execute(args, setup.build_plan(args))
        self.assertFalse(seen[0].exists())
        self.assertTrue(self.state.is_dir())

    def test_new_base_venv_is_preserved_without_model_downloads(self):
        args = self.args('--allow-downloads', '--backend', 'captions')
        def fixture_step(command, environment, timeout):
            if command[1:4] == ['-I', '-m', 'venv']:
                (self.state / 'venv').mkdir()
        with patch.object(setup, 'run_step', side_effect=fixture_step) as execute:
            result = setup.execute(args, setup.build_plan(args))
        self.assertEqual(result['status'], 'prepared_not_runtime_verified')
        self.assertEqual(execute.call_count, 4)
        self.assertEqual(execute.call_args_list[0].args[0][:4], [setup.sys.executable, '-I', '-m', 'venv'])
        self.assertTrue((self.state / 'venv' / setup.OWNER_MARKER).is_file())
        self.assertFalse((self.state / 'models').exists())
        commands = ' '.join(' '.join(call.args[0]) for call in execute.call_args_list)
        self.assertNotIn('huggingface', commands)
        self.assertNotIn('faster-whisper', commands)
        self.assertNotIn('snapshot_download', commands)


if __name__ == '__main__':
    unittest.main()
