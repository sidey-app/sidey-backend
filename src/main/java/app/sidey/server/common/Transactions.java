package app.sidey.server.common;

import java.util.function.Supplier;
import org.jooq.DSLContext;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

@Component
public class Transactions {
    private final TransactionTemplate tx;
    @org.springframework.beans.factory.annotation.Autowired
    public Transactions(PlatformTransactionManager manager) { tx = new TransactionTemplate(manager); }
    public Transactions(TransactionTemplate template) { tx = template; }
    public <T> T run(Supplier<T> body) { return tx.execute(status -> body.get()); }
    public static void lock(DSLContext db, String key) {
        db.fetch("select pg_advisory_xact_lock(hashtextextended(?,0))", key);
    }
}
