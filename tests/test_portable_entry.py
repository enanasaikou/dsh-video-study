"""Model embeddable _pth startup without downloading or executing a new runtime."""
import runpy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


class PortableEntryTests(unittest.TestCase):
    def test_runner_adds_only_its_trusted_installed_code_directory(self):
        directory = Path(__file__).resolve().parents[1] / 'python'
        isolated = [entry for entry in sys.path if entry and Path(entry).resolve() != directory]
        with patch.object(sys, 'path', list(isolated)):
            module = runpy.run_path(str(directory / 'runner.py'), run_name='_portable_entry_test')
            self.assertEqual(module['_PLUGIN_CODE'], str(directory))
            self.assertEqual(sys.path[0], str(directory))
            self.assertEqual(sys.path[1:], isolated)
            self.assertEqual(module['MODES'], ('captions', 'cloud'))


if __name__ == '__main__':
    unittest.main()
