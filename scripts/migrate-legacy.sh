#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
./mvnw -q dependency:build-classpath -Dmdep.outputFile=target/migration-classpath
exec java -cp "target/classes:$(cat target/migration-classpath)" app.sidey.server.migration.LegacyMigration
