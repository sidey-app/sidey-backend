package app.sidey.server.realtime;

import java.util.concurrent.*;
import org.springframework.context.annotation.*;

@Configuration("realtimeExecutorConfiguration")
public class RealtimeExecutor {
    @Bean(destroyMethod="shutdownNow") public ExecutorService realtimeExecutor() {
        return new ThreadPoolExecutor(64,64,30,TimeUnit.SECONDS,new ArrayBlockingQueue<>(4096),
            Thread.ofPlatform().name("ws-outbound-",0).factory(),new ThreadPoolExecutor.AbortPolicy());
    }
}
