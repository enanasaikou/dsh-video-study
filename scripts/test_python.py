"""Portable offline test entry: main guard is required by Windows spawn."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import socket
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'python'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', help='Optional new absolute JSON result path; never overwrites')
    args = parser.parse_args()
    if args.report and (not Path(args.report).is_absolute() or Path(args.report).exists()):
        parser.error('report must be a new absolute file')
    suite = unittest.defaultTestLoader.discover(str(ROOT / 'tests'), pattern='test_*.py')
    with patch.object(socket, 'create_connection', side_effect=AssertionError('Offline tests forbid network')), \
         patch.object(socket.socket, 'connect', side_effect=AssertionError('Offline tests forbid network')):
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
