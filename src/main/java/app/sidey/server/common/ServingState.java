package app.sidey.server.common;

import io.micrometer.core.instrument.MeterRegistry;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** Local admission only. The deployment operator must quiesce the old JVM first. */
@Component
public final class ServingState {
    private boolean accepting;
    private int inFlight;

    public ServingState(@Value("${sidey.serving.enabled:true}") boolean enabled, MeterRegistry metrics) {
        accepting = enabled;
        metrics.gauge("sidey.serving.accepting", this, state -> state.accepting() ? 1 : 0);
        metrics.gauge("sidey.serving.inflight", this, ServingState::inFlight);
    }

    public synchronized Lease enter() {
        if (!accepting) return null;
        inFlight++;
        return new Lease();
    }
    public synchronized boolean accepting() { return accepting; }
    public synchronized int inFlight() { return inFlight; }
    public synchronized void stopAccepting() { accepting = false; }
    public synchronized void activate() {
        if (inFlight != 0) throw new ApiException(409, "deployment_not_quiescent");
        accepting = true;
    }
    public synchronized boolean awaitQuiescence(Duration timeout) throws InterruptedException {
        long remaining = timeout.toNanos(), end = System.nanoTime() + remaining;
        while (inFlight != 0 && remaining > 0) {
            java.util.concurrent.TimeUnit.NANOSECONDS.timedWait(this, remaining);
            remaining = end - System.nanoTime();
        }
        return inFlight == 0;
    }
    public final class Lease implements AutoCloseable {
        private boolean closed;
        private Lease() {}
        @Override public void close() {
            synchronized (ServingState.this) {
                if (closed) return;
                closed = true;
                inFlight--;
                ServingState.this.notifyAll();
            }
        }
    }
}
