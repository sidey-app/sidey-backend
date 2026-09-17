package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import org.junit.jupiter.api.Test;

class CommerceSchemaTest extends PostgresTest {
    @Test
    void catalogAndCurrentOffersAreComplete() {
        assertEquals(33L, db.fetchOne("select count(*) from commerce_products").get(0, Long.class));
        assertEquals(33L, db.fetchOne("select count(*) from commerce_prices where active").get(0, Long.class));
        assertEquals("character_monkey_solo_4", db.fetchOne(
                "select store_product_id from app_store_product_offers where product_id='character_monkey' and current_offer").get(0, String.class));
        assertEquals(2200, db.fetchOne(
                "select amount_krw from commerce_prices where product_id='character_starlight_upalupa' and active").get(0, Integer.class));
        assertThrows(Exception.class, () -> db.execute(
                "insert into commerce_prices(product_id,amount_krw) values ('character_monkey',1000)"));
    }

    @Test
    void signedMoneyMustHaveCurrencyAndNeverBecomeNegative() {
        assertThrows(Exception.class, () -> db.execute("insert into app_store_transactions(environment,transaction_id,original_transaction_id,product_id,store_product_id,status,binding_state,purchased_at,signed_at,signed_data_sha256,price_milliunits) values ('Sandbox','test','test','character_monkey','character_monkey_solo_4','active','unbound',now(),now(),decode(repeat('00',32),'hex'),-1)"));
    }
}
