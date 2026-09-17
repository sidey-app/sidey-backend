package app.sidey.server;

import org.flywaydb.core.Flyway;
import org.jooq.DSLContext;
import org.jooq.SQLDialect;
import org.jooq.impl.DSL;
import org.junit.jupiter.api.BeforeAll;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

public abstract class PostgresTest {
    protected static DSLContext db;
    protected static TransactionTemplate tx;
    protected static String schema;

    @BeforeAll
    static void database() {
        String url = System.getenv().getOrDefault("SIDEY_TEST_DATABASE_URL", "jdbc:postgresql://127.0.0.1:55432/sidey");
        var ds = new DriverManagerDataSource(url,
                System.getenv().getOrDefault("SIDEY_TEST_DATABASE_USER", "sidey"),
                System.getenv().getOrDefault("SIDEY_TEST_DATABASE_PASSWORD", ""));
        schema = "test_" + java.util.UUID.randomUUID().toString().replace("-", "");
        Flyway.configure().dataSource(ds).schemas(schema).defaultSchema(schema).load().migrate();
        ds.setUrl(url + (url.contains("?") ? "&" : "?") + "currentSchema=" + schema);
        var aware = new org.springframework.jdbc.datasource.TransactionAwareDataSourceProxy(ds);
        db = DSL.using(aware, SQLDialect.POSTGRES);
        tx = new TransactionTemplate(new DataSourceTransactionManager(ds));
    }

    @org.junit.jupiter.api.AfterAll
    static void cleanup() {
        if (db != null) db.execute("drop schema " + schema + " cascade");
    }
}
