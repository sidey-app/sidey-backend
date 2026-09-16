package app.sidey.server.migration;

import java.sql.*;
import java.util.*;
import tools.jackson.databind.ObjectMapper;

/** Offline, one-shot importer. Source is read-only; target changes commit atomically. */
public final class LegacyMigration {
    private final Connection source,target;
    private final String auth,pub,priv;
    private final Map<String,Long> report=new LinkedHashMap<>();
    public Map<String,Long> report(){return Map.copyOf(report);}
    public LegacyMigration(Connection source,Connection target,String authSchema,String publicSchema,String privateSchema){
        this.source=source;this.target=target;auth=identifier(authSchema);pub=identifier(publicSchema);priv=identifier(privateSchema);
    }
    private static String identifier(String name){if(name==null || !name.matches("[a-z][a-z0-9_]*"))throw new IllegalArgumentException("invalid_schema");return name;}
    public Map<String,Long> migrate(UUID runId) throws SQLException {
        source.setAutoCommit(false);source.setReadOnly(true);source.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
        target.setAutoCommit(false);
        try {
            execute(target,"select pg_advisory_xact_lock(839271046)");
            try(var statement=target.prepareStatement("select report::text from migration_runs where id=?")){
                statement.setObject(1,runId);try(var rows=statement.executeQuery()){if(rows.next()){
                    Map<String,Long> previous=new LinkedHashMap<>();new ObjectMapper().readTree(rows.getString(1)).properties().forEach(e->previous.put(e.getKey(),e.getValue().asLong()));target.rollback();source.rollback();return previous;
                }}
            }
            if(scalar(target,"select count(*) from migration_runs")!=0)throw new SQLException("target_already_migrated");
            // Offline target only. Lock all application tables to fence accidental writers.
            List<String> tables=new ArrayList<>();try(var s=target.createStatement();var r=s.executeQuery("select tablename from pg_tables where schemaname=current_schema() and tablename <> 'flyway_schema_history' order by tablename")){while(r.next())tables.add(identifier(r.getString(1)));}
            execute(target,"lock table "+String.join(",",tables)+" in access exclusive mode");
            for(String table:List.of("users","rooms","messages","commerce_orders","commerce_grants","app_store_transactions","commerce_entitlements"))
                if(scalar(target,"select count(*) from "+table)!=0)throw new SQLException("target_not_empty:"+table);
            zeroSource("unsupported_identity", "select count(*) from "+auth+".identities where provider not in ('google','apple')");
            zeroSource("nonanonymous_without_provider", "select count(*) from "+auth+".users u where not coalesce(u.is_anonymous,false) and not exists(select 1 from "+auth+".identities i where i.user_id=u.id and i.provider in ('google','apple'))");
            copy("users",auth+".users r",Map.of("status","case when exists(select 1 from "+auth+".identities i where i.user_id=r.id and i.provider in ('google','apple')) then 'ACTIVE' else 'LEGACY_ANONYMOUS_UNCLAIMED' end"),"");
            copy("user_identities",auth+".identities r",Map.of("provider","upper(r.provider)","provider_subject","r.provider_id"),"where r.provider in ('google','apple')");
            copy("profiles",pub+".profiles r",Map.of("character_id","case r.character_id when 'minty_pup' then 'pixel_hamster' when 'pixel_koala' then 'pixel_chinchilla' else r.character_id end"),"");
            copy("rooms",pub+".rooms r",Map.of(),"");copy("room_members",pub+".room_members r",Map.of(),"");
            copy("room_invites",priv+".room_invites r join "+pub+".rooms room on room.id=r.room_id",Map.of("code_hint","room.invite_code_hint"),"");
            copy("messages",pub+".messages r",Map.of(),"where r.created_at >= current_timestamp-interval '3 days'");
            copy("invite_attempts",priv+".invite_attempts r",Map.of(),"where r.attempted_at >= current_timestamp-interval '1 day'",Set.of("id"));
            copy("message_attempts",priv+".message_attempts r",Map.of(),"where r.attempted_at >= current_timestamp-interval '1 day'",Set.of("id"));
            // Replace bootstrap seed catalog only inside this still-empty target transaction.
            execute(target,"delete from app_store_product_offers");execute(target,"delete from commerce_prices");execute(target,"delete from commerce_products");
            copy("commerce_products",pub+".commerce_products r",Map.of(),"order by r.related_character_product_id nulls first");
            copy("commerce_prices",pub+".commerce_prices r",Map.of(),"");
            copy("app_store_product_offers",priv+".app_store_product_offers r",Map.of(),"");
            copy("commerce_orders",pub+".commerce_orders r",Map.of("payment_environment","(select case p.portone_channel_type when 'TEST' then 'test' when 'LIVE' then 'live' end from "+priv+".commerce_payments p where p.order_id=r.id)"),"");
            copy("commerce_payments",priv+".commerce_payments r",Map.of("provider_payment_id","case r.provider when 'portone' then r.portone_payment_id else r.payment_key end","provider_transaction_id","r.provider_transaction_key","store_id","r.portone_store_id","channel_key","r.portone_channel_key","provider_version","r.portone_version","channel_type","r.portone_channel_type"),"");
            copy("commerce_webhook_events",priv+".commerce_webhook_events r",Map.of("provider","coalesce((select p.provider from "+priv+".commerce_payments p where p.order_id=r.order_id),'legacy_unknown')"),"");
            copy("commerce_refund_operations",priv+".commerce_refund_operations r",Map.of(),"");
            copy("commerce_grants",priv+".commerce_grants r",Map.of("legacy_source_reference","case when r.source_kind='app_store' then r.source_reference end","source_reference","case when r.source_kind='app_store' then (select 'transaction:'||t.environment||':'||t.transaction_id from "+priv+".app_store_transactions t where r.source_reference='transaction:'||t.transaction_id) else r.source_reference end"),"order by r.parent_grant_id nulls first");
            copy("commerce_entitlements",pub+".commerce_entitlements r",Map.of(),"");
            copy("app_store_transactions",priv+".app_store_transactions r",Map.of(),"");
            copy("app_store_notification_events",priv+".app_store_notification_events r",Map.of(),"");
            copy("commerce_runtime_settings",priv+".commerce_runtime_settings r",Map.of(),"");
            copy("character_item_transition",priv+".character_item_transition r",Map.of(),"");
            copy("download_metric_snapshots",priv+".download_metric_snapshots r",Map.of(),"");
            validate();execute(target,"set constraints all immediate");
            try(var s=target.prepareStatement("insert into migration_runs(id,report) values (?,?::jsonb)")){s.setObject(1,runId);s.setString(2,new ObjectMapper().writeValueAsString(report));s.executeUpdate();}
            target.commit();source.rollback();return Map.copyOf(report);
        } catch(SQLException|RuntimeException failed){target.rollback();source.rollback();throw failed;}
    }
    private void copy(String table,String from,Map<String,String> overrides,String suffix)throws SQLException{copy(table,from,overrides,suffix,Set.of());}
    private void copy(String table,String from,Map<String,String> overrides,String suffix,Set<String> omitted)throws SQLException{
        List<String> columns=new ArrayList<>();try(var s=target.createStatement();var r=s.executeQuery("select * from "+table+" where false")){var m=r.getMetaData();for(int i=1;i<=m.getColumnCount();i++)if(!omitted.contains(m.getColumnName(i)))columns.add(m.getColumnName(i));}
        String query="select "+String.join(",",columns.stream().map(c->overrides.getOrDefault(c,"r."+c)).toList())+" from "+from+" "+suffix;
        long count=0;
        try(var read=source.prepareStatement(query);var write=target.prepareStatement("insert into "+table+" ("+String.join(",",columns)+") values ("+String.join(",",Collections.nCopies(columns.size(),"?"))+")")){
            read.setFetchSize(500);try(var rows=read.executeQuery()){
                while(rows.next()){for(int i=1;i<=columns.size();i++)write.setObject(i,rows.getObject(i));write.addBatch();if(++count%500==0)write.executeBatch();}write.executeBatch();
            }
        }
        report.put("source_"+table,count);long actual=scalar(target,"select count(*) from "+table);report.put("target_"+table,actual);
        if(count!=actual)throw new SQLException("count_mismatch:"+table);
    }
    private void validate()throws SQLException{
        report.put("authenticated_identity_count",scalar(target,"select count(*) from user_identities"));
        report.put("legacy_unclaimed_count",scalar(target,"select count(*) from users where status='LEGACY_ANONYMOUS_UNCLAIMED'"));
        report.put("historical_unknown_payment_environment",scalar(target,"select count(*) from commerce_orders where payment_environment is null"));
        zero("room_without_owner","select count(*) from rooms where owner_id is null");
        zero("owner_not_member","select count(*) from rooms r where not exists(select 1 from room_members m where m.room_id=r.id and m.user_id=r.owner_id)");
        zero("orphan_membership","select count(*) from room_members m left join rooms r on r.id=m.room_id left join users u on u.id=m.user_id where r.id is null or u.id is null");
        zero("message_orphan","select count(*) from messages m left join rooms r on r.id=m.room_id left join users u on u.id=m.sender_id where r.id is null or u.id is null");
        zero("duplicate_provider_identity","select count(*) from (select provider,provider_subject from user_identities group by 1,2 having count(*)>1) x");
        zero("room_over_capacity","select count(*) from (select room_id from room_members group by 1 having count(*)>12) x");
        zero("user_over_room_limit","select count(*) from (select user_id from room_members group by 1 having count(*)>5) x");
        zero("grant_inclusion_inconsistent","select count(*) from commerce_grants child join commerce_grants parent on parent.id=child.parent_grant_id where child.entitlement_key is distinct from parent.included_entitlement_key or child.user_id is distinct from parent.user_id");
        zero("order_grant_inconsistent","select count(*) from commerce_grants g left join commerce_orders o on g.source_reference='order:'||o.id left join commerce_products p on p.id=o.product_id where g.source_kind in ('portone','toss') and (o.id is null or g.user_id is distinct from o.user_id or g.entitlement_key is distinct from p.entitlement_key or (g.status='active' and o.status<>'approved'))");
        zero("entitlement_projection_inconsistent","with expected as (select user_id,entitlement_key,case when bool_or(status='active') then 'active' when bool_or(status='refunded') then 'refunded' else 'revoked' end status from commerce_grants where user_id is not null group by 1,2) select count(*) from expected x full join commerce_entitlements e using(user_id,entitlement_key) where x.status is distinct from e.status");
        zero("apple_binding_inconsistent","select count(*) from app_store_transactions t left join commerce_products p on p.id=t.product_id left join commerce_grants g on g.source_kind='app_store' and g.source_reference='transaction:'||t.environment||':'||t.transaction_id where t.binding_state='bound' and (g.id is null or g.user_id is distinct from t.user_id or g.status is distinct from t.status or g.entitlement_key is distinct from p.entitlement_key)");
    }
    private void zero(String name,String query)throws SQLException{long n=scalar(target,query);report.put(name,n);if(n!=0)throw new SQLException("migration_validation_failed:"+name+":"+n);}
    private void zeroSource(String name,String query)throws SQLException{long n=scalar(source,query);report.put(name,n);if(n!=0)throw new SQLException("migration_source_validation_failed:"+name+":"+n);}
    private static long scalar(Connection c,String sql)throws SQLException{try(var s=c.createStatement();var r=s.executeQuery(sql)){r.next();return r.getLong(1);}}
    private static void execute(Connection c,String sql)throws SQLException{try(var s=c.createStatement()){s.execute(sql);}}
    public static void main(String[] args)throws Exception{
        if(!"true".equals(System.getenv("SIDEY_MIGRATION_OFFLINE")))throw new IllegalStateException("stop_source_and_target_writers_before_migration");
        UUID run=UUID.fromString(required("SIDEY_MIGRATION_RUN_ID"));
        LegacyMigration migration=null;
        try(var source=DriverManager.getConnection(required("SIDEY_MIGRATION_SOURCE_URL"),required("SIDEY_MIGRATION_SOURCE_USER"),required("SIDEY_MIGRATION_SOURCE_PASSWORD"));
            var target=DriverManager.getConnection(required("SIDEY_MIGRATION_TARGET_URL"),required("SIDEY_MIGRATION_TARGET_USER"),required("SIDEY_MIGRATION_TARGET_PASSWORD"))){
            byte[] expected=Base64.getDecoder().decode(required("SIDEY_INVITE_PEPPER"));
            try(var s=source.createStatement();var r=s.executeQuery("select decode(decrypted_secret,'hex') from vault.decrypted_secrets where name='sidey_invite_pepper_v2'")){
                if(!r.next() || !java.security.MessageDigest.isEqual(expected,r.getBytes(1)))throw new IllegalStateException("invite_pepper_mismatch");
            }
            migration=new LegacyMigration(source,target,"auth","public","private");var result=migration.migrate(run);
            System.out.println(new ObjectMapper().writeValueAsString(result));
        } catch(Exception failure){
            System.out.println(new ObjectMapper().writeValueAsString(Map.of("status","FAILED","checks",migration==null?Map.of():migration.report())));
            System.err.println("Migration failed; target transaction rolled back. SQLState="+(failure instanceof SQLException sql?sql.getSQLState():"configuration"));System.exit(1);
        }
    }
    private static String required(String key){String value=System.getenv(key);if(value==null)throw new IllegalStateException("missing_"+key);return value;}
}
