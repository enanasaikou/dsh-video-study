"""Targeted tests for the offline entry's suite-wide temporary workspace."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    'video_study_test_python_entry', Path(__file__).parents[1] / 'scripts' / 'test_python.py')
entry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(entry)

KEYS = ('TEMP', 'TMP', 'TMPDIR')


class TemporaryWorkspaceTests(unittest.TestCase):
    def setUp(self):
        self.original_tempdir = tempfile.tempdir
        self.original_environment = {key: os.environ.get(key) for key in KEYS}
        self.original_cwd = Path.cwd()
        self.addCleanup(self.restore_state)

    def restore_state(self):
        tempfile.tempdir = self.original_tempdir
        for key, value in self.original_environment.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def assert_restored(self, environment, cache):
        self.assertEqual({key: os.environ.get(key) for key in KEYS}, environment)
        self.assertIs(tempfile.tempdir, cache)
        self.assertEqual(Path.cwd(), self.original_cwd)

    def test_success_cleans_children_and_restores_mixed_environment_and_cache(self):
        # Include both pre-existing keys and a key that must remain absent.
        os.environ.pop('TMPDIR', None)
        cache = Path('unused-original-tempfile-cache')
        tempfile.tempdir = cache
        environment = {key: os.environ.get(key) for key in KEYS}
        original_mkdtemp = tempfile.mkdtemp
        with entry.isolated_test_tempdir() as root:
            self.assertTrue(root.is_dir())
            self.assertTrue(root.name.startswith('dsh-video-study-tests-'))
            self.assertNotEqual(root.parent, self.original_cwd)
            self.assertEqual(tempfile.gettempdir(), str(root))
            for key in KEYS:
                self.assertEqual(os.environ[key], str(root))
            child = Path(tempfile.mkdtemp(prefix='unclaimed-child-'))
            self.assertEqual(child.parent, root)
            (child / 'fixture.txt').write_text('offline fixture', encoding='utf-8')
            with tempfile.NamedTemporaryFile() as temporary:
                self.assertEqual(Path(temporary.name).parent, root)
            # Preserve legacy fixtures without changing cwd or writing there.
            with tempfile.TemporaryDirectory(dir=str(Path.cwd())) as legacy:
                self.assertEqual(Path(legacy).parent, root)
            with tempfile.TemporaryDirectory(dir=child) as nested:
                self.assertEqual(Path(nested).parent, child)
            self.assertEqual(Path.cwd(), self.original_cwd)
        self.assertFalse(root.exists())
        self.assertFalse(child.exists())
        self.assertIs(tempfile.mkdtemp, original_mkdtemp)
        self.assert_restored(environment, cache)

    def test_exception_cleans_workspace_and_restores_unset_key_and_none_cache(self):
        os.environ.pop('TMPDIR', None)
        tempfile.tempdir = None
        environment = {key: os.environ.get(key) for key in KEYS}
        for error in (RuntimeError('fixture failed'), KeyboardInterrupt(), SystemExit(2)):
            with self.subTest(error=type(error).__name__):
                with self.assertRaises(type(error)) as caught:
                    with entry.isolated_test_tempdir() as root:
                        child = Path(tempfile.mkdtemp())
                        (child / 'fixture.txt').write_text('offline fixture', encoding='utf-8')
                        raise error
                # Do not mistake an entry/setup error for the fixture exception.
                self.assertIs(caught.exception, error)
                self.assertFalse(root.exists())
                self.assertFalse(child.exists())
                self.assert_restored(environment, None)

    def test_child_process_inherits_workspace(self):
        environment = {key: os.environ.get(key) for key in KEYS}
        cache = tempfile.tempdir
        with entry.isolated_test_tempdir() as root:
            # A regular temporary output file avoids subprocess pipes on Windows.
            with tempfile.TemporaryFile(mode='w+', encoding='utf-8') as output:
                subprocess.run([
                    sys.executable, '-B', '-c',
                    'import json,os,tempfile; '
                    'print(json.dumps({"parent":tempfile.gettempdir(), '
                    '"child":tempfile.mkdtemp(), '
                    '"environment":{key:os.environ.get(key) '
                    'for key in ("TEMP","TMP","TMPDIR")}}))',
                ], stdout=output, check=True)
                output.seek(0)
                result = json.load(output)
            self.assertEqual(Path(result['parent']), root)
            self.assertEqual(Path(result['child']).parent, root)
            self.assertTrue(Path(result['child']).is_dir())
            self.assertEqual(result['environment'], dict.fromkeys(KEYS, str(root)))
        self.assertFalse(root.exists())
        self.assert_restored(environment, cache)

    def test_workspace_fallback_is_rejected_without_creating_a_directory(self):
        environment = {key: os.environ.get(key) for key in KEYS}
        cache = tempfile.tempdir
        for parent in (Path.cwd(), entry.ROOT, entry.ROOT.parent, entry.ROOT / 'scratch'):
            with self.subTest(parent=parent), \
                 patch.object(tempfile, 'gettempdir', return_value=str(parent)), \
                 patch.object(tempfile, 'TemporaryDirectory') as create:
                with self.assertRaisesRegex(RuntimeError, 'refusing workspace fallback'):
                    with entry.isolated_test_tempdir():
                        self.fail('Workspace fallback must not be entered')
                create.assert_not_called()
            self.assert_restored(environment, cache)


if __name__ == '__main__':
    unittest.main()
