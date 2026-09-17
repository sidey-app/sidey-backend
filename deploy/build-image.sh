#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
: "${SIDEY_IMAGE:?Set an immutable SIDEY_IMAGE tag for this release}"
: "${SIDEY_JAVA_IMAGE:?Set an approved Java 21 JRE image pinned by sha256 digest}"
case "$SIDEY_JAVA_IMAGE" in *@sha256:*) ;; *) echo 'Java base image must be digest pinned' >&2; exit 1;; esac
command -v nerdctl >/dev/null
python3 scripts/check-source.py
./mvnw -q clean verify
nerdctl build --file deploy/Containerfile --build-arg "JAVA_IMAGE=$SIDEY_JAVA_IMAGE" --tag "$SIDEY_IMAGE" .
