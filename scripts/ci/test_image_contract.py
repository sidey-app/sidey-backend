import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from image_smoke import inspect_image
from publish_image import manifest, validate_reference
from verify_tests import verify


class ImageContractTest(unittest.TestCase):
    def test_only_full_sha_tags_are_allowed(self):
        revision = 'a' * 40
        validate_reference('ghcr.io/sidey-app/sidey-backend:sha-' + revision, revision)
        for image in ('ghcr.io/sidey-app/sidey-backend:latest',
                      'ghcr.io/sidey-app/sidey-backend:sha-aaaaaaa',
                      'ghcr.io/other/backend:sha-' + revision):
            with self.assertRaises(ValueError):
                validate_reference(image, revision)

    def test_runtime_or_revision_drift_rejected(self):
        config = {'User': '10001:10001', 'Entrypoint': ['java', '-jar', '/app/sidey-server.jar'],
                  'Env': ['JAVA_TOOL_OPTIONS=-Xms256m -Xmx768m -XX:+ExitOnOutOfMemoryError'],
                  'Labels': {'org.opencontainers.image.revision': 'a' * 40,
                             'org.opencontainers.image.source': 'https://github.com/sidey-app/sidey-backend'}}
        image = {'Id': 'tested', 'Os': 'linux', 'Architecture': 'amd64', 'Config': config}
        with patch('image_smoke.docker', side_effect=lambda *args: json.dumps([image])):
            self.assertEqual('tested', inspect_image('image', 'a' * 40))
            with self.assertRaises(RuntimeError):
                inspect_image('image', 'b' * 40)
            image['Architecture'] = 'arm64'
            with self.assertRaises(RuntimeError):
                inspect_image('image', 'a' * 40)
            image['Architecture'] = 'amd64'
            config['User'] = '0'
            with self.assertRaises(RuntimeError):
                inspect_image('image', 'a' * 40)

    def test_registry_permission_and_network_errors_are_not_missing_tags(self):
        for error in ('403 Forbidden', 'unauthorized', 'connection reset'):
            with patch('publish_image.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', error)):
                with self.assertRaises(RuntimeError):
                    manifest('image', allow_missing=True)
        with patch('publish_image.subprocess.run', return_value=subprocess.CompletedProcess([], 1, '', 'manifest unknown')):
            self.assertIsNone(manifest('image', allow_missing=True))

    def test_empty_failed_or_skipped_suite_cannot_publish(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            reports = root / 'target/surefire-reports'
            reports.mkdir(parents=True)
            with self.assertRaises(RuntimeError):
                verify(root)
            jar = root / 'target/sidey-server-0.1.0-SNAPSHOT.jar'
            with zipfile.ZipFile(jar, 'w') as archive:
                archive.writestr('META-INF/MANIFEST.MF', 'Main-Class: org.springframework.boot.loader.launch.JarLauncher\n')
            report = reports / 'TEST-example.xml'
            for attributes in ('tests="1" failures="1"', 'tests="1" skipped="1"', 'tests="0"'):
                report.write_text('<testsuite ' + attributes + '/>')
                with self.assertRaises(RuntimeError):
                    verify(root)
            report.write_text('<testsuite tests="79" failures="0" errors="0" skipped="0"/>')
            self.assertEqual(79, verify(root)['tests'])


if __name__ == '__main__':
    unittest.main()
