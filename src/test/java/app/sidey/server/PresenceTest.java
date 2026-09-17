package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import app.sidey.server.common.*;
import app.sidey.server.realtime.*;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.time.*;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.*;
import tools.jackson.databind.ObjectMapper;

class PresenceTest extends PostgresTest {
    static class Time extends Clock {
        Instant now=Instant.parse("2026-09-17T00:00:00Z");
        public ZoneId getZone(){return ZoneOffset.UTC;}public Clock withZone(ZoneId zone){return this;}public Instant instant(){return now;}
    }
    @Test void devicesAggregateFocusActivityAndHeartbeatWithoutRemoteReconnecting() throws Exception {
        var f=new CoreFixture(db,tx);UUID user=f.user(),peer=f.user();var one=f.rooms.create(user,"하나방");var two=f.rooms.create(user,"둘째방");f.rooms.join(peer,one.inviteCode());
        var members=new MembershipRegistry(db,f.boundary);var registry=mock(ConnectionRegistry.class);var time=new Time();
        when(registry.user("mac")).thenReturn(user);when(registry.user("win")).thenReturn(user);
        var presence=new PresenceService(registry,members,f.boundary,time,new SimpleMeterRegistry());
        presence.opened("mac",user,UUID.randomUUID());presence.opened("win",user,UUID.randomUUID());
        presence.focus("mac",one.room().id(),PresenceService.Activity.ONLINE);presence.focus("win",two.room().id(),PresenceService.Activity.ONLINE);
        assertEquals("ONLINE",presence.snapshot(one.room().id(),peer).get(user));assertEquals("ONLINE",presence.snapshot(two.room().id(),user).get(user));
        presence.focus("mac",one.room().id(),PresenceService.Activity.AWAY);presence.focus("win",one.room().id(),PresenceService.Activity.ONLINE);
        assertEquals("ONLINE",presence.snapshot(one.room().id(),peer).get(user));assertEquals("OFFLINE",presence.snapshot(two.room().id(),user).get(user));
        presence.focus("win",one.room().id(),PresenceService.Activity.AWAY);assertEquals("AWAY",presence.snapshot(one.room().id(),peer).get(user));
        time.now=time.now.plusSeconds(59);presence.heartbeat("mac");presence.tick();assertEquals(2,presence.size());
        time.now=time.now.plusSeconds(1);presence.tick();verify(registry).close("win");assertEquals(1,presence.size());
        presence.closed("mac");assertEquals("OFFLINE",presence.snapshot(one.room().id(),peer).get(user));assertEquals(0,presence.size());
    }
    @Test void revocationClearsFocusAndRejectsActorOrTargetBeforeFanout() throws Exception {
        var f=new CoreFixture(db,tx);UUID owner=f.user(),peer=f.user();var created=f.rooms.create(owner,"권한방");UUID room=created.room().id();f.rooms.join(peer,created.inviteCode());
        var members=new MembershipRegistry(db,f.boundary);var auth=mock(app.sidey.server.auth.AuthService.class);var metrics=new SimpleMeterRegistry();var json=new ObjectMapper();
        var registry=new ConnectionRegistry(members,f.boundary,auth,json,Runnable::run,new CoordinationLocks(),metrics);
        var time=new Time();var presence=new PresenceService(registry,members,f.boundary,time,metrics);
        var socket=mock(WebSocketSession.class);when(socket.getId()).thenReturn("peer");when(socket.isOpen()).thenReturn(true);
        var frames=new CopyOnWriteArrayList<String>();doAnswer(i->{frames.add(((TextMessage)i.getArgument(0)).getPayload());return null;}).when(socket).sendMessage(any());
        registry.open(socket,peer,UUID.randomUUID());registry.subscribe("peer",room);presence.focus("peer",room,PresenceService.Activity.ONLINE);
        registry.publishFrom(room,owner,peer,Map.of("type","character.throw"));assertEquals(1,frames.size());
        f.rooms.kick(owner,room,peer);assertEquals("OFFLINE",presence.snapshot(room,owner).getOrDefault(peer,"OFFLINE"));
        assertThrows(ApiException.class,()->registry.publishFrom(room,peer,null,Map.of("type","typing")));
        assertThrows(ApiException.class,()->registry.publishFrom(room,owner,peer,Map.of("type","character.throw")));
        assertThrows(ApiException.class,()->presence.focus("peer",room,PresenceService.Activity.ONLINE));assertEquals(1,frames.size());
        registry.close("peer");assertEquals(0,presence.size());
    }
    @Test void limiterIsPerUserAcrossDevicesAndResetsOnlyAfterWindow(){
        var time=new Time();var limiter=new TransientLimiter(time);UUID user=UUID.randomUUID();
        for(int i=0;i<20;i++)limiter.take(user,"character.throw",20);
        assertEquals("transient_rate_limited",assertThrows(ApiException.class,()->limiter.take(user,"character.throw",20)).code());
        limiter.take(UUID.randomUUID(),"character.throw",20);time.now=time.now.plusSeconds(10);limiter.take(user,"character.throw",20);
    }
}
