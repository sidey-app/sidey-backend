#!/usr/bin/env python3
"""Reject an empty or skipped Maven suite; record counts without test payloads."""
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile


def verify(root=Path('.')):
    reports = list((root / 'target/surefire-reports').glob('TEST-*.xml'))
    totals = dict(tests=0, failures=0, errors=0, skipped=0)
    for report in reports:
        suite = ET.parse(report).getroot()
        for key in totals:
            totals[key] += int(suite.get(key, '0'))
    if not reports or totals['tests'] == 0 or any(totals[key] for key in ('failures', 'errors', 'skipped')):
        raise RuntimeError(f'Full test suite required: {totals}')
    with zipfile.ZipFile(root / 'target/sidey-server-0.1.0-SNAPSHOT.jar') as jar:
        manifest = jar.read('META-INF/MANIFEST.MF').decode()
        if 'Main-Class: org.springframework.boot.loader.launch.JarLauncher' not in manifest:
            raise RuntimeError('Executable Spring Boot JAR required')
    print(f'Maven verification PASS: {totals}')
    return totals


if __name__ == '__main__':
    verify()
