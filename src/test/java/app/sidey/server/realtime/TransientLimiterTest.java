package app.sidey.server.realtime;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.common.ApiException;
import java.time.*;
import java.util.*;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class TransientLimiterTest {
    private static class Time extends Clock {
        long now=1_000_000;
        public ZoneId getZone(){return ZoneOffset.UTC;}
        public Clock withZone(ZoneId zone){return this;}
        public Instant instant(){return Instant.ofEpochMilli(now);}
    }
    @Test void matchesRollingWindowReferenceIncludingRejectedCallsAndDifferentUsers(){
        var time=new Time();var limiter=new TransientLimiter(time);var random=new Random(193);
        var reference=new HashMap<UUID,ArrayDeque<Long>>();
        for(int i=0;i<100_000;i++){
            time.now+=random.nextInt(6);UUID user=new UUID(0,random.nextInt(100));
            var queue=reference.computeIfAbsent(user,key->new ArrayDeque<>());
            while(!queue.isEmpty() && queue.peekFirst()<=time.now-10_000)queue.removeFirst();
            if(queue.size()>=30){assertEquals("transient_rate_limited",assertThrows(ApiException.class,()->limiter.take(user,"typing",30)).code());}
            else {limiter.take(user,"typing",30);queue.addLast(time.now);}
        }
    }
    @Test void expiredCapacityIsReclaimedWithoutDroppingLiveWindows(){
        var time=new Time();var limiter=new TransientLimiter(time);
        for(int i=0;i<20_000;i++)limiter.take(new UUID(0,i),"typing",30);
        time.now+=9999;
        assertEquals("transient_capacity",assertThrows(ApiException.class,()->limiter.take(new UUID(0,20_000),"typing",30)).code());
        // Move one old key to the tail; all other expired keys can be reclaimed.
        limiter.take(new UUID(0,0),"typing",30);
        time.now++;
        for(int i=1;i<=19_999;i++)limiter.take(new UUID(1,i),"typing",30);
        assertEquals("transient_capacity",assertThrows(ApiException.class,()->limiter.take(new UUID(2,0),"typing",30)).code());
        for(int i=0;i<29;i++)limiter.take(new UUID(0,0),"typing",30);
        assertEquals("transient_rate_limited",assertThrows(ApiException.class,()->limiter.take(new UUID(0,0),"typing",30)).code());
    }
    @Test void concurrentCallsCannotExceedLimitAndClockRollbackCannotReopenWindow()throws Exception{
        var time=new Time();var limiter=new TransientLimiter(time);UUID user=UUID.randomUUID();
        try(var pool=Executors.newVirtualThreadPerTaskExecutor()){
            var jobs=new ArrayList<Future<Boolean>>();
            for(int i=0;i<100;i++)jobs.add(pool.submit(()->{try{limiter.take(user,"typing",30);return true;}catch(ApiException limited){return false;}}));
            int accepted=0;for(var job:jobs)if(job.get())accepted++;
            assertEquals(30,accepted);
        }
        time.now-=60_000;
        assertThrows(ApiException.class,()->limiter.take(user,"typing",30));
        time.now+=70_000;
        assertDoesNotThrow(()->limiter.take(user,"typing",30));
    }
}
