package app.sidey.server.message;

import app.sidey.server.auth.AuthService;
import app.sidey.server.common.*;
import io.micrometer.core.instrument.MeterRegistry;
import java.time.OffsetDateTime;
import java.util.*;
import org.jooq.DSLContext;
import org.jooq.Record;
import org.springframework.stereotype.Service;

@Service
public class MessageService {
    private final DSLContext db;
    private final Transactions tx;
    private final AuthService auth;
    private final MeterRegistry metrics;
    private final RecoveryBoundary recovery;
    public record Message(UUID id,UUID roomId,UUID senderId,String body,String bubbleStyleId,OffsetDateTime createdAt) {}
    public record Cursor(OffsetDateTime createdAt,UUID id) {}
    public record Page(List<Message> messages,Cursor nextCursor) {}
    public MessageService(DSLContext db,Transactions tx,AuthService auth,MeterRegistry metrics,RecoveryBoundary recovery){this.db=db;this.tx=tx;this.auth=auth;this.metrics=metrics;this.recovery=recovery;}

    /** Returns only after commit. Publication is deliberately outside this method. */
    public Message send(UUID user,UUID room,UUID id,String body) {
        if(id==null || room==null || body==null || body.indexOf('\r')>=0 || body.split("\n",-1).length>3)
            throw new ApiException(400,"invalid_message");
        String normalized=body.strip();
        int length=normalized.codePointCount(0,normalized.length());
        if(length<1 || length>200)throw new ApiException(400,"invalid_message_body");
        try {
            Message result=recovery.sending(room,()->tx.run(()->{
                // Compatible across all senders and with structural NO KEY UPDATE.
                // Prevent a cascading room delete racing the membership row lock.
                if(db.fetchOne("select id from rooms where id=? for key share",room)==null)
                    throw new ApiException(403,"membership_required");
                if(db.fetchOne("select user_id from room_members where room_id=? and user_id=? for key share",room,user)==null)
                    throw new ApiException(403,"membership_required");
                auth.active(user);
                Transactions.lock(db,"message-id:"+id);
                Record saved=db.fetchOne("select * from messages where id=?",id);
                if(saved!=null)return canonical(saved,user,room,normalized);
                Transactions.lock(db,"message-rate:"+user);
                if(db.fetchOne("select count(*) from message_attempts where user_id=? and attempted_at>=clock_timestamp()-interval '10 seconds'",user).get(0,Integer.class)>=30)
                    throw new ApiException(429,"message_rate_limited");
                db.execute("insert into message_attempts(user_id,attempted_at) values (?,clock_timestamp())",user);
                Record equipment=db.fetchOne("select p.equipped_bubble_style_id from profiles p join commerce_products c on c.catalog_item_id=p.equipped_bubble_style_id and c.product_kind='bubble' and c.active join commerce_entitlements e on e.entitlement_key=c.entitlement_key and e.user_id=p.id and e.status='active' where p.id=?",user);
                String bubble=equipment==null?null:equipment.get(0,String.class);
                return map(db.fetchOne("insert into messages(id,room_id,sender_id,body,bubble_style_id,created_at) values (?,?,?,?,?,greatest(clock_timestamp(),(select max(created_at)+interval '1 microsecond' from messages where room_id=?))) returning *",id,room,user,normalized,bubble,room));
            }));
            metrics.counter("sidey.message.send","outcome","accepted").increment();
            return result;
        } catch(RuntimeException failure){metrics.counter("sidey.message.send","outcome","rejected").increment();throw failure;}
    }
    public Message get(UUID actor,UUID room,UUID id){return tx.run(()->{
        require(actor,room);
        Record r=db.fetchOne("select * from messages where room_id=? and id=? and created_at>=clock_timestamp()-interval '3 days'",room,id);
        if(r==null)throw new ApiException(404,"message_missing");return map(r);
    });}
    public Cursor checkpoint(UUID actor,UUID room){return recovery.checkpoint(room,()->tx.run(()->{
        require(actor,room);
        Record row=db.fetchOne("select created_at,id from messages where room_id=? order by created_at desc,id desc limit 1",room);
        return row==null?null:new Cursor(row.get("created_at",OffsetDateTime.class),row.get("id",UUID.class));
    }));}
    public Page history(UUID actor,UUID room,Cursor after,Cursor before,int limit){return history(actor,room,after,before,null,limit);}
    public Page history(UUID actor,UUID room,Cursor after,Cursor before,Cursor through,int limit){return tx.run(()->{
        require(actor,room);
        if(limit<1 || limit>200 || (after!=null && before!=null))throw new ApiException(400,"invalid_page");
        String comparison=after!=null?" and (created_at,id)>(?,?)":before!=null?" and (created_at,id)<(?,?)":"";
        Cursor cursor=after!=null?after:before;
        List<Object> args=new ArrayList<>(List.of(room));
        if(cursor!=null){args.add(java.sql.Timestamp.from(cursor.createdAt().toInstant()));args.add(cursor.id());}
        if(through!=null){comparison+=" and (created_at,id)<=(?,?)";args.add(java.sql.Timestamp.from(through.createdAt().toInstant()));args.add(through.id());}
        args.add(limit+1);
        // Default is oldest first for complete initial catch-up; before is history backwards.
        String direction=before!=null?"desc":"asc";
        List<Message> result=db.fetch("select * from messages where room_id=? and created_at>=clock_timestamp()-interval '3 days'"+comparison+" order by created_at "+direction+",id "+direction+" limit ?",args.toArray()).map(MessageService::map);
        List<Message> page=List.copyOf(result.subList(0,Math.min(limit,result.size())));
        Message last=page.isEmpty()?null:page.getLast();
        return new Page(page,result.size()>limit?new Cursor(last.createdAt(),last.id()):null);
    });}
    private void require(UUID actor,UUID room){auth.active(actor);if(db.fetchOne("select user_id from room_members where room_id=? and user_id=? for key share",room,actor)==null)throw new ApiException(403,"membership_required");}
    private Message canonical(Record saved,UUID actor,UUID room,String body){Message message=map(saved);if(!actor.equals(message.senderId()) || !room.equals(message.roomId()) || !body.equals(message.body()))throw new ApiException(409,"message_id_conflict");return message;}
    private static Message map(Record r){return new Message(r.get("id",UUID.class),r.get("room_id",UUID.class),r.get("sender_id",UUID.class),r.get("body",String.class),r.get("bubble_style_id",String.class),r.get("created_at",OffsetDateTime.class));}
}
