#!/usr/bin/env python3
"""Publish only a tested commit tag, then verify registry content by digest."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from image_smoke import docker, inspect_image

REPOSITORY = 'ghcr.io/sidey-app/sidey-backend'


def validate_reference(image, revision):
    if not re.fullmatch(r'[0-9a-f]{40}', revision) or image != f'{REPOSITORY}:sha-{revision}':
        raise ValueError('Only full commit SHA image tags are allowed')


def manifest(image, allow_missing=False):
    result = subprocess.run(['docker', 'buildx', 'imagetools', 'inspect', image,
                             '--format', '{{json .Manifest}}'], capture_output=True, text=True)
    if result.returncode:
        error = result.stderr.lower()
        if allow_missing and any(value in error for value in ('manifest unknown', 'manifest_unknown', 'not found')):
            return None
        if any(value in error for value in ('denied', 'unauthorized', '403 forbidden')):
            raise RuntimeError('BLOCKED_BY_GHCR_PACKAGE_PERMISSION: GITHUB_TOKEN cannot access this package')
        raise RuntimeError('Registry manifest lookup failed: ' + result.stderr.strip())
    value = json.loads(result.stdout)
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', value.get('digest', '')):
        raise RuntimeError('Registry returned no valid immutable digest')
    return value


def publish(image, revision):
    validate_reference(image, revision)
    tested_id = inspect_image(image, revision)
    existing = manifest(image, allow_missing=True)
    if existing is None:
        result = subprocess.run(['docker', 'push', image], capture_output=True, text=True)
        if result.returncode:
            if any(value in (result.stdout + result.stderr).lower() for value in ('denied', 'unauthorized', '403 forbidden')):
                raise RuntimeError('BLOCKED_BY_GHCR_PACKAGE_PERMISSION: GITHUB_TOKEN package write was rejected')
            raise RuntimeError('Registry push failed: ' + result.stderr.strip())
        print(result.stdout)
    else:
        print('Commit tag already exists; verify it without overwriting')
    remote = manifest(image)
    pinned = f"{REPOSITORY}@{remote['digest']}"
    # A registry read/pull by digest proves the remotely stored image is the
    # exact locally smoked config and layers, not merely a successful tag push.
    docker('pull', '--platform', 'linux/amd64', pinned)
    if inspect_image(pinned, revision) != tested_id:
        raise RuntimeError('Remote image differs from the locally tested image; existing tag was not overwritten')
    if manifest(pinned)['digest'] != remote['digest']:
        raise RuntimeError('Pinned manifest verification failed')
    report = (f'Commit:\n{revision}\n\nImage tag:\n{image}\n\n'
              f"Image digest:\n{remote['digest']}\n\nPinned image:\n{pinned}\n\n"
              'Platform:\nlinux/amd64\n\nValidation:\nPASS\n\n'
              'Image smoke:\nPASS\n\nRegistry push:\nPASS\n')
    Path('image-reference.txt').write_text(report)
    if summary := os.getenv('GITHUB_STEP_SUMMARY'):
        with open(summary, 'a') as file:
            file.write('```text\n' + report + '```\n')
    print(report)


if __name__ == '__main__':
    publish(*sys.argv[1:])
