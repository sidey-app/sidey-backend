package app.sidey.server.realtime;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.Objects;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.BooleanSupplier;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

/** One writer per socket; byte and event limits include a frame currently being written. */
public final class OutboundConnection {
    private static final int MAX_EVENTS = 256;
    private record Delivery(String json, int bytes, BooleanSupplier authorized) {}
    private final WebSocketSession session;
    private final Executor executor;
    private final int maxQueuedBytes;
    private final Runnable onClosed;
    private final Object monitor = new Object();
    private final ArrayDeque<Delivery> queue = new ArrayDeque<>();
    private volatile boolean open = true;
    private boolean writerScheduled;
    private int bytes;
    private int events;

    public OutboundConnection(WebSocketSession session, Executor executor, int maxQueuedBytes, Runnable onClosed) {
        this.session = Objects.requireNonNull(session);
        this.executor = Objects.requireNonNull(executor);
        if (maxQueuedBytes < 1) throw new IllegalArgumentException("Positive queue byte limit required");
        this.maxQueuedBytes = maxQueuedBytes;
        this.onClosed = Objects.requireNonNull(onClosed);
    }

    public boolean enqueue(String json, boolean durable, BooleanSupplier stillAuthorized) {
        Objects.requireNonNull(json);
        Objects.requireNonNull(stillAuthorized);
        int frameBytes = json.getBytes(StandardCharsets.UTF_8).length;
        boolean schedule = false;
        boolean overflow = false;
        synchronized (monitor) {
            if (!open) return false;
            if (frameBytes > maxQueuedBytes - bytes || events >= MAX_EVENTS) {
                if (!durable) return false;
                overflow = true;
            } else {
                queue.addLast(new Delivery(json, frameBytes, stillAuthorized));
                bytes += frameBytes;
                events++;
                if (!writerScheduled) { writerScheduled = true; schedule = true; }
            }
        }
        if (overflow) { close(CloseStatus.SERVICE_OVERLOAD); return false; }
        if (schedule) {
            try { executor.execute(this::drain); }
            catch (RejectedExecutionException rejected) { close(CloseStatus.SERVICE_OVERLOAD); return false; }
        }
        return open;
    }

    private void drain() {
        while (true) {
            Delivery delivery;
            synchronized (monitor) {
                if (!open) { writerScheduled = false; return; }
                delivery = queue.pollFirst();
                if (delivery == null) { writerScheduled = false; return; }
            }
            try {
                // Never retain the queue monitor during authorization or network I/O.
                if (open && delivery.authorized().getAsBoolean() && open) {
                    if (!session.isOpen()) { close(CloseStatus.GOING_AWAY); return; }
                    session.sendMessage(new TextMessage(delivery.json()));
                }
            } catch (IOException | RuntimeException failure) {
                close(CloseStatus.SERVER_ERROR);
                return;
            } finally {
                synchronized (monitor) {
                    if (open) { bytes -= delivery.bytes(); events--; }
                }
            }
        }
    }

    public void close(CloseStatus status) {
        synchronized (monitor) {
            if (!open) return;
            open = false;
            queue.clear();
            bytes = 0;
            events = 0;
        }
        // Detach promptly even if closing the underlying socket blocks or fails.
        try { onClosed.run(); }
        finally {
            try { session.close(status); }
            catch (IOException | RuntimeException ignored) { /* Already detached and closed locally. */ }
        }
    }

    public int queuedBytes() { synchronized (monitor) { return bytes; } }
    public boolean isOpen() { return open && session.isOpen(); }
}
