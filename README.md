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
