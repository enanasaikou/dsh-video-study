"""Portable offline test entry: main guard is required by Windows spawn."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'python'))


@contextmanager
def isolated_test_tempdir():
    """Keep suite scratch files together, without tempfile's cwd fallback."""
    original_tempdir = tempfile.tempdir
    keys = ('TEMP', 'TMP', 'TMPDIR')
    original_environment = {key: os.environ.get(key) for key in keys}
    try:
        # Resolve the system default afresh, not a previous caller's cached path.
        tempfile.tempdir = None
        parent = Path(tempfile.gettempdir()).resolve()
        cwd = Path.cwd().resolve()
        if parent in (cwd, ROOT, ROOT.parent) or ROOT in parent.parents:
            raise RuntimeError('System temporary directory unavailable; refusing workspace fallback')
        with tempfile.TemporaryDirectory(prefix='dsh-video-study-tests-', dir=str(parent)) as directory:
            tempfile.tempdir = directory
            for key in keys:
                os.environ[key] = directory
            original_mkdtemp = tempfile.mkdtemp

            def suite_mkdtemp(suffix=None, prefix=None, dir=None):
                # Older fixtures explicitly requested cwd. Redirect only that
                # legacy case; keep intentional nested scratch paths intact.
                if dir is not None and Path(os.fsdecode(dir)).resolve() == cwd:
                    dir = os.fsencode(directory) if isinstance(dir, bytes) else directory
                return original_mkdtemp(suffix=suffix, prefix=prefix, dir=dir)

            with patch.object(tempfile, 'mkdtemp', new=suite_mkdtemp):
                yield Path(directory)
    finally:
        tempfile.tempdir = original_tempdir
        for key, value in original_environment.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', help='Optional new absolute JSON result path; never overwrites')
    args = parser.parse_args()
    if args.report and (not Path(args.report).is_absolute() or Path(args.report).exists()):
        parser.error('report must be a new absolute file')
    with isolated_test_tempdir(), \
         patch.object(socket, 'create_connection', side_effect=AssertionError('Offline tests forbid network')), \
         patch.object(socket.socket, 'connect', side_effect=AssertionError('Offline tests forbid network')):
        suite = unittest.defaultTestLoader.discover(str(ROOT / 'tests'), pattern='test_*.py')
        result = unittest.TextTestRunner(verbosity=1).run(suite)
    report = {'verified_at': datetime.now(timezone.utc).isoformat(), 'python': sys.version,
              'tests': result.testsRun, 'successful': result.wasSuccessful(),
              'failures': [test.id() for test, _ in result.failures],
              'errors': [test.id() for test, _ in result.errors],
              'skipped': [test.id() for test, _ in result.skipped],
              'scope': 'Offline fixtures and real spawned fake workers; no media/API/model downloads'}
    if args.report:
        with Path(args.report).open('x', encoding='utf-8') as output:
            json.dump(report, output, ensure_ascii=False, indent=2)
            output.write('\n')
    print(json.dumps(report, ensure_ascii=False))
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    raise SystemExit(main())
