package app.sidey.server.auth;

import app.sidey.server.auth.verifier.IdentityVerifier;
import app.sidey.server.auth.verifier.LegacyCredentialVerifier;
import app.sidey.server.common.*;
import java.time.*;
import java.util.UUID;
import org.jooq.DSLContext;
import org.jooq.Record;
import org.springframework.context.ApplicationEventPublisher;
import org.springframework.stereotype.Service;

@Service
public class AuthService {
    private final DSLContext db;
    private final Transactions tx;
    private final IdentityVerifier identities;
    private final LegacyCredentialVerifier legacy;
    private final AccessTokens tokens;
    private final Clock clock;
    private final ApplicationEventPublisher events;
    public record Session(String accessToken, String refreshToken, UUID userId, UUID sessionId, Instant accessExpiresAt) {}
    public AuthService(DSLContext db, Transactions tx, IdentityVerifier identities,
            LegacyCredentialVerifier legacy, AccessTokens tokens, Clock clock, ApplicationEventPublisher events) {
        this.db=db;this.tx=tx;this.identities=identities;this.legacy=legacy;
        this.tokens=tokens;this.clock=clock;this.events=events;
    }
    public Session login(String provider,String credential,String nonce,String platform,String name) {
        var identity=identities.verify(provider,credential,nonce);
        return tx.run(() -> {
            Transactions.lock(db,"identity:"+identity.provider()+":"+identity.subject());
            var row=db.fetchOne("select user_id from user_identities where provider=? and provider_subject=?",identity.provider(),identity.subject());
            UUID user=row == null ? UUID.randomUUID() : row.get("user_id",UUID.class);
            if(row == null) {
                db.execute("insert into users(id,status) values (?,'ACTIVE')",user);
                db.execute("insert into user_identities(user_id,provider,provider_subject) values (?,?,?)",user,identity.provider(),identity.subject());
            }
            active(user);
            return createSession(user,platform,name);
        });
    }
    public Session claim(String oldCredential,String provider,String credential,String nonce,String platform,String name) {
        UUID user=legacy.verify(oldCredential);
        var identity=identities.verify(provider,credential,nonce);
        return tx.run(() -> {
            Transactions.lock(db,"identity:"+identity.provider()+":"+identity.subject());
            var row=db.fetchOne("select status from users where id=? for update",user);
            if(row == null) throw new ApiException(403,"legacy_account_not_imported");
            if(!"LEGACY_ANONYMOUS_UNCLAIMED".equals(row.get("status"))) throw new ApiException(409,"legacy_account_already_claimed");
            bind(user,identity.provider(),identity.subject());
            db.execute("update users set status='ACTIVE',updated_at=now() where id=?",user);
            return createSession(user,platform,name);
        });
    }
    public void link(UUID user,String provider,String credential,String nonce) {
        var identity=identities.verify(provider,credential,nonce);
        tx.run(() -> {
            Transactions.lock(db,"identity:"+identity.provider()+":"+identity.subject());
            lockUser(user);bind(user,identity.provider(),identity.subject());return null;
        });
    }
    public void unlink(UUID user,String provider,String credential,String nonce) {
        var proof=identities.verify(provider,credential,nonce);
        tx.run(() -> {
            lockUser(user);
            var row=db.fetchOne("select provider_subject from user_identities where user_id=? and provider=?",user,proof.provider());
            if(row == null || !proof.subject().equals(row.get("provider_subject"))) throw new ApiException(403,"identity_proof_mismatch");
            if(db.fetchOne("select count(*) from user_identities where user_id=?",user).get(0,Integer.class)<=1)
                throw new ApiException(409,"last_identity_unlink_forbidden");
            db.execute("delete from user_identities where user_id=? and provider=?",user,proof.provider());return null;
        });
    }
    private void bind(UUID user,String provider,String subject) {
        var owner=db.fetchOne("select user_id from user_identities where provider=? and provider_subject=?",provider,subject);
        if(owner!=null && !user.equals(owner.get("user_id",UUID.class))) throw new ApiException(409,"identity_already_linked");
        var existing=db.fetchOne("select provider_subject from user_identities where user_id=? and provider=?",user,provider);
        if(existing!=null) {
            if(!subject.equals(existing.get("provider_subject"))) throw new ApiException(409,"provider_already_linked");
            return;
        }
        db.execute("insert into user_identities(user_id,provider,provider_subject) values (?,?,?)",user,provider,subject);
    }
    public Session refresh(String raw) {
        if(raw==null || !raw.matches("[A-Za-z0-9_-]{43}")) throw new ApiException(401,"invalid_refresh_token");
        byte[] hash=Crypto.hash(raw);
        Session result=tx.run(() -> {
            var row=db.fetchOne("select * from user_sessions where refresh_token_hash=? for update",hash);
            if(row==null) {
                var used=db.fetchOne("select session_id from used_refresh_tokens where token_hash=?",hash);
                if(used!=null) revokeInTransaction(used.get("session_id",UUID.class));
                return null;
            }
            UUID sid=row.get("id",UUID.class);UUID user=row.get("user_id",UUID.class);
            Instant now=clock.instant();
            if(row.get("revoked_at")!=null || !now.isBefore(instant(row,"expires_at")) || !now.isBefore(instant(row,"absolute_expires_at"))) return null;
            active(user);
            String next=Crypto.token();Instant absolute=instant(row,"absolute_expires_at");
            db.execute("insert into used_refresh_tokens(token_hash,session_id,expires_at) values (?,?,?)",hash,sid,utc(absolute));
            db.execute("update user_sessions set refresh_token_hash=?,last_refreshed_at=?,expires_at=? where id=?",Crypto.hash(next),utc(now),utc(min(now.plus(Duration.ofDays(30)),absolute)),sid);
            return response(user,sid,next,now);
        });
        if(result==null) throw new ApiException(401,"refresh_rejected");
        return result;
    }
    public void logout(UUID sid) { tx.run(() -> {revokeInTransaction(sid);return null;}); }
    public void logoutAll(UUID user) {
        tx.run(() -> {lockUser(user);for(var row:db.fetch("select id from user_sessions where user_id=? for update",user)) revokeInTransaction(row.get("id",UUID.class));return null;});
    }
    private void revokeInTransaction(UUID sid) {
        var row=db.fetchOne("update user_sessions set revoked_at=coalesce(revoked_at,now()) where id=? returning user_id",sid);
        if(row!=null) events.publishEvent(new SessionEvents(sid,row.get("user_id",UUID.class)));
    }
    public void authorize(UUID user,UUID sid) {
        active(user);
        if(db.fetchOne("select 1 from user_sessions where id=? and user_id=? and revoked_at is null and expires_at>? and absolute_expires_at>?",sid,user,utc(clock.instant()),utc(clock.instant()))==null)
            throw new ApiException(401,"session_revoked");
    }
    public void active(UUID user) {
        if(db.fetchOne("select 1 from users where id=? and status='ACTIVE'",user)==null) throw new ApiException(403,"account_not_active");
    }
    private void lockUser(UUID user) { if(db.fetchOne("select id from users where id=? for update",user)==null) throw new ApiException(401,"account_missing");active(user); }
    private Session createSession(UUID user,String platform,String name) {
        lockUser(user); UUID sid=UUID.randomUUID();String raw=Crypto.token();Instant now=clock.instant();
        if(!java.util.Set.of("MACOS","WINDOWS","WEB","OTHER").contains(platform)) throw new ApiException(400,"invalid_platform");
        db.execute("insert into user_sessions(id,user_id,refresh_token_hash,created_at,last_refreshed_at,expires_at,absolute_expires_at,device_platform,device_name) values (?,?,?,?,?,?,?,?,?)",sid,user,Crypto.hash(raw),utc(now),utc(now),utc(now.plus(Duration.ofDays(30))),utc(now.plus(Duration.ofDays(180))),platform,name);
        return response(user,sid,raw,now);
    }
    private Session response(UUID user,UUID sid,String refresh,Instant now) {return new Session(tokens.issue(user,sid,now),refresh,user,sid,now.plus(Duration.ofMinutes(15)));}
    private static Instant instant(Record row,String column){return row.get(column,OffsetDateTime.class).toInstant();}
    private static java.sql.Timestamp utc(Instant time){return java.sql.Timestamp.from(time);}
    private static Instant min(Instant a,Instant b){return a.isBefore(b)?a:b;}
}
