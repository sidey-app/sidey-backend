package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.common.Crypto;
import app.sidey.server.migration.LegacyMigration;
import java.sql.*;
import java.util.*;
import org.junit.jupiter.api.Test;

class LegacyMigrationTest extends PostgresTest {
    private Connection connect()throws SQLException{
        String url=System.getenv().getOrDefault("SIDEY_TEST_DATABASE_URL","jdbc:postgresql://127.0.0.1:55432/sidey");
        var c=DriverManager.getConnection(url,System.getenv().getOrDefault("SIDEY_TEST_DATABASE_USER","sidey"),System.getenv().getOrDefault("SIDEY_TEST_DATABASE_PASSWORD",""));
        c.setSchema(schema);return c;
    }
    @Test void migratesLegacyShapeAtomicallyPreservingIdsProvenanceAndRerun()throws Exception{
        String a="legacy_auth_"+UUID.randomUUID().toString().replace("-","");String p=a+"p",q=a+"q";
        UUID google=UUID.randomUUID(),anon=UUID.randomUUID(),room=UUID.randomUUID(),parent=UUID.randomUUID(),child=UUID.randomUUID();
        try {
            db.execute("create schema "+a);db.execute("create schema "+p);db.execute("create schema "+q);
            db.execute("create table "+a+".users(id uuid,is_anonymous boolean,created_at timestamptz default now(),updated_at timestamptz default now())");
            db.execute("create table "+a+".identities(user_id uuid,provider text,provider_id text,created_at timestamptz default now())");
            db.execute("insert into "+a+".users(id,is_anonymous) values (?,false),(?,true)",google,anon);
            db.execute("insert into "+a+".identities(user_id,provider,provider_id) values (?,'google','external-subject')",google);
            for(String table:List.of("profiles","rooms","room_members","messages","commerce_products","commerce_prices","commerce_orders","commerce_entitlements"))
                db.execute("create table "+p+"."+table+" as select * from "+table+" where "+(table.equals("commerce_products") || table.equals("commerce_prices")?"true":"false"));
            for(String table:List.of("room_invites","invite_attempts","message_attempts","commerce_payments","commerce_webhook_events","commerce_refund_operations","commerce_grants","app_store_product_offers","app_store_transactions","app_store_notification_events","commerce_runtime_settings","character_item_transition","download_metric_snapshots"))
                db.execute("create table "+q+"."+table+" as select * from "+table+" where "+(table.equals("app_store_product_offers")?"true":"false"));
            // Final legacy column names, including fields absent from the target.
            db.execute("alter table "+p+".rooms add invite_code_hint text");db.execute("alter table "+q+".room_invites drop code_hint");
            db.execute("alter table "+p+".commerce_orders drop payment_environment");
            db.execute("alter table "+q+".commerce_grants drop legacy_source_reference");
            db.execute("alter table "+q+".commerce_webhook_events drop provider");
            for(var names:Map.of("provider_payment_id","portone_payment_id","provider_transaction_id","provider_transaction_key","store_id","portone_store_id","channel_key","portone_channel_key","provider_version","portone_version","channel_type","portone_channel_type").entrySet())db.execute("alter table "+q+".commerce_payments rename column "+names.getKey()+" to "+names.getValue());
            db.execute("alter table "+q+".commerce_payments add payment_key text");
            db.execute("insert into "+p+".profiles(id,nickname,character_id,tree_movement_paused,tree_movement_revision,created_at,updated_at) values (?,'구글친구','pixel_cat',false,0,now(),now()),(?,'기존친구','minty_pup',true,7,now(),now())",google,anon);
            db.execute("insert into "+p+".rooms values (?,'이관방',?,now(),'ABCD…1234')",room,anon);
            db.execute("insert into "+p+".room_members values (?,?,now()),(?,?,now())",room,anon,room,google);
            db.execute("insert into "+q+".room_invites values (?,?,2,now(),now())",room,Crypto.hash("invite"));
            db.execute("insert into "+p+".messages(id,room_id,sender_id,body,created_at) values (?,?,?,'retained',now()),(?,?,?,'expired',now()-interval '4 days')",UUID.randomUUID(),room,anon,UUID.randomUUID(),room,google);
            db.execute("insert into "+q+".commerce_grants(id,user_id,entitlement_key,source_kind,source_reference,status,granted_at,updated_at,included_entitlement_key) values (?,?,'character:pixel_pig','app_store','transaction:apple-old','active',now(),now(),'throwable:throwable_pork')",parent,google);
            db.execute("insert into "+q+".commerce_grants(id,user_id,entitlement_key,source_kind,source_reference,status,granted_at,updated_at,parent_grant_id) values (?,?,'throwable:throwable_pork','complimentary',?,'active',now(),now(),?)",child,google,"included:"+parent,parent);
            db.execute("insert into "+p+".commerce_entitlements(user_id,entitlement_key,status,granted_at,updated_at) values (?,'character:pixel_pig','active',now(),now()),(?,'throwable:throwable_pork','active',now(),now())",google,google);
            db.execute("insert into "+q+".app_store_transactions(environment,transaction_id,original_transaction_id,product_id,store_product_id,user_id,app_account_token,status,binding_state,purchased_at,signed_at,signed_data_sha256,created_at,updated_at,price_milliunits,currency,price_signed_at) values ('Sandbox','apple-old','apple-old','character_pig','character_pig',?,?,'active','bound',now(),now(),?,now(),now(),990000,'KRW',now())",google,google,Crypto.hash("signed"));
            db.execute("insert into "+q+".character_item_transition values (true,now()-interval '10 days')");
            db.execute("insert into "+q+".commerce_runtime_settings values (true,false,'test','legacy-policy',repeat('notice ',20),now())");
            UUID order=UUID.randomUUID();
            db.execute("insert into "+p+".commerce_orders(id,user_id,product_id,price_id,provider_order_id,amount_krw,currency,status,checkout_token_hash,checkout_token_expires_at,policy_version,policy_notice,policy_consented_at,created_at,approved_at,refunded_at,updated_at) select ?,?,'character_tree',id,'provider-old',amount_krw,'KRW','refunded',?,now(),'old-policy',repeat('disclosed ',20),now(),now(),now(),now(),now() from "+p+".commerce_prices where product_id='character_tree' and active",order,google,Crypto.hash("checkout"));
            db.execute("insert into "+q+".commerce_payments(order_id,provider,portone_payment_id,provider_status,portone_store_id,portone_channel_key,portone_version,portone_channel_type,payment_method_type,amount_krw,balance_amount_krw,currency,last_verified_at,created_at,updated_at) select id,'portone','provider-old','CANCELLED','store-test','channel-test','V2','TEST','EASY_PAY',amount_krw,0,'KRW',now(),now(),now() from "+p+".commerce_orders where id=?",order);
            db.execute("insert into "+q+".commerce_grants(id,user_id,entitlement_key,source_kind,source_reference,status,granted_at,revoked_at,updated_at) values (?,?,'character:pixel_tree','portone',?,'refunded',now(),now(),now()),(?,?,'character:pixel_tree','complimentary','another-active-source','active',now(),null,now())",UUID.randomUUID(),google,"order:"+order,UUID.randomUUID(),google);
            db.execute("insert into "+p+".commerce_entitlements values (?,'character:pixel_tree','active',now(),null,now())",google);
            db.execute("insert into "+q+".commerce_webhook_events(event_id,event_type,payload_sha256,order_id,processing_status,received_at,processed_at) values ('historical-event','Transaction.Cancelled',?,?,'processed',now(),now())",Crypto.hash("webhook"),order);
            db.execute("insert into "+q+".commerce_refund_operations(order_id,request_id,reason_code,requested_by,processing_status,requested_at,processed_at,updated_at) values (?,?,'duplicate_payment','operations','completed',now(),now(),now())",order,UUID.randomUUID());
            // Invalid projection must roll back every copied row and preserve seed catalog.
            db.execute("update "+p+".commerce_entitlements set status='revoked',revoked_at=now() where entitlement_key='character:pixel_pig'");
            try(var source=connect();var target=connect()){
                var failure=assertThrows(SQLException.class,()->new LegacyMigration(source,target,a,p,q).migrate(UUID.randomUUID()));
                assertTrue(failure.getMessage().contains("entitlement_projection_inconsistent"),failure.getMessage());
            }
            assertEquals(0,db.fetchOne("select count(*) from users").get(0,Integer.class));assertEquals(33,db.fetchOne("select count(*) from commerce_products").get(0,Integer.class));
            db.execute("update "+p+".commerce_entitlements set status='active',revoked_at=null");
            UUID run=UUID.randomUUID();Map<String,Long> report;
            try(var source=connect();var target=connect()){report=new LegacyMigration(source,target,a,p,q).migrate(run);}
            assertEquals(2L,report.get("source_users"));assertEquals(1L,report.get("legacy_unclaimed_count"));assertEquals(1L,report.get("source_messages"));
            assertEquals(0L,report.get("invalid_active_user_identity"));
            assertEquals(0L,report.get("orphan_fk"));
            assertTrue(report.get("foreign_keys_checked")>0);
            assertEquals("LEGACY_ANONYMOUS_UNCLAIMED",db.fetchOne("select status from users where id=?",anon).get(0));
            assertEquals(google,db.fetchOne("select user_id from user_identities where provider_subject='external-subject'").get(0));
            assertEquals(anon,db.fetchOne("select owner_id from rooms where id=?",room).get(0));
            assertEquals(7L,db.fetchOne("select tree_movement_revision from profiles where id=?",anon).get(0));
            assertEquals("transaction:Sandbox:apple-old",db.fetchOne("select source_reference from commerce_grants where id=?",parent).get(0));
            assertEquals("transaction:apple-old",db.fetchOne("select legacy_source_reference from commerce_grants where id=?",parent).get(0));
            assertEquals(parent,db.fetchOne("select parent_grant_id from commerce_grants where id=?",child).get(0));
            assertEquals(990000L,db.fetchOne("select price_milliunits from app_store_transactions").get(0));
            assertEquals("test",db.fetchOne("select payment_environment from commerce_orders where id=?",order).get(0));
            assertEquals("provider-old",db.fetchOne("select provider_payment_id from commerce_payments where order_id=?",order).get(0));
            assertEquals("active",db.fetchOne("select status from commerce_entitlements where entitlement_key='character:pixel_tree'").get(0));
            assertEquals(1L,report.get("target_commerce_refund_operations"));assertEquals(1L,report.get("target_commerce_webhook_events"));
            try(var source=connect();var target=connect()){assertEquals(report,new LegacyMigration(source,target,a,p,q).migrate(run));}
            try(var source=connect();var target=connect()){assertThrows(SQLException.class,()->new LegacyMigration(source,target,a,p,q).migrate(UUID.randomUUID()));}
        } finally {db.execute("drop schema if exists "+a+" cascade");db.execute("drop schema if exists "+p+" cascade");db.execute("drop schema if exists "+q+" cascade");}
    }
}
