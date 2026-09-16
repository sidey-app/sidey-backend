package app.sidey.server.message;

import app.sidey.server.common.Transactions;
import app.sidey.server.realtime.RoomEventPublisher;
import java.util.*;
import org.jooq.DSLContext;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class Retention {
    private final DSLContext db;
    private final Transactions tx;
    private final RoomEventPublisher publisher;
    public Retention(DSLContext db,Transactions tx,RoomEventPublisher publisher){this.db=db;this.tx=tx;this.publisher=publisher;}
    @Scheduled(fixedDelay=60000,initialDelay=60000)
    public void prune(){
        Set<UUID> rooms=tx.run(()->{
            Set<UUID> changed=new HashSet<>(db.fetch("delete from messages where id in (select id from messages where created_at<clock_timestamp()-interval '3 days' order by created_at limit 10000) returning room_id").getValues("room_id",UUID.class));
            db.execute("delete from message_attempts where attempted_at<now()-interval '1 day'");
            db.execute("delete from invite_attempts where attempted_at<now()-interval '1 day'");
            db.execute("delete from used_refresh_tokens where expires_at<now()");
            return changed;
        });
        for(UUID room:rooms)publisher.publish(new RoomEventPublisher.RoomEvent(room,Map.of("type","messages.pruned","roomId",room),false));
    }
}
