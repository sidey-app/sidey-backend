# SIDEY server

Java 21, Spring Boot 4.1, PostgreSQL 17, Flyway and jOOQ modular monolith.
Production runs one active instance behind Nginx and Cloudflare Tunnel.

Local PostgreSQL (isolated loopback-only task cluster):

```sh
sh scripts/local-postgres.sh
./mvnw verify
```

Set `JAVA_HOME` to a Java 21 JDK. Production configuration requires an explicit
database credential. Local development defaults are not deployment secrets.
Management endpoints bind to loopback on port 9090.

Dependency references: [Spring Boot build systems](https://docs.spring.io/spring-boot/reference/using/build-systems.html),
[jOOQ code generation](https://www.jooq.org/doc/latest/manual/code-generation/codegen-configuration/).

Room invitations require `SIDEY_INVITE_PEPPER` (base64, at least 32 random bytes).
For cutover, export the existing `sidey_invite_pepper_v2` bytes through the secret
management channel and encode those same bytes as base64; otherwise retained
invite hashes cannot validate existing invitations. Never include this secret
in a migration report. Invalid join attempts consume the durable 10/10-minute
per-account budget. Structural room transactions use reference-counted room
boundaries; observers update reconstructible state after commit inside that
boundary, and invalidate it on an update failure. Socket writes run after release.
