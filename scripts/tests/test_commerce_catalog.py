import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class StandaloneCatalogTests(unittest.TestCase):
    def test_standalone_write_check_and_drift_detection(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)
            for name in ('scripts/commerce_catalog.py', 'assets/v1/commerce-catalog.json', 'assets/v1/manifest.json'):
                destination = target / name
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, destination)
            command = [sys.executable, str(target / 'scripts/commerce_catalog.py'), '--target', 'shared']
            # Check is read-only even when mirrors have not been generated yet.
            failed = subprocess.run(command + ['--check'], capture_output=True, text=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertFalse((target / 'services').exists())
            written = subprocess.run(command + ['--write'], capture_output=True, text=True)
            self.assertEqual(written.returncode, 0, written.stderr)
            self.assertIn('2 mirrors verified', written.stdout)
            self.assertFalse((target / 'macos').exists())
            self.assertFalse((target / 'windows').exists())
            self.assertFalse((target / 'website').exists())
            checked = subprocess.run(command + ['--check'], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            mirror = target / 'services/app-store-verifier/src/product-entitlements.ts'
            mirror.write_text('stale')
            drift = subprocess.run(command + ['--check'], capture_output=True, text=True)
            self.assertNotEqual(drift.returncode, 0)
            self.assertEqual(mirror.read_text(), 'stale')

    def test_native_target_is_rejected(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/commerce_catalog.py'),
                                 '--target', 'macos', '--check'], capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('invalid choice', result.stderr)


if __name__ == '__main__':
    unittest.main()
