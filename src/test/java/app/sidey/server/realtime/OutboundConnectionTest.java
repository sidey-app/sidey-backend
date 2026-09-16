package app.sidey.server.realtime;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.web.socket.*;

class OutboundConnectionTest {
    private static final class ManualExecutor implements Executor {
        final ArrayDeque<Runnable> tasks = new ArrayDeque<>();
        public void execute(Runnable command) { tasks.add(command); }
        void run() { tasks.removeFirst().run(); }
    }
    private WebSocketSession session() {
        var session = mock(WebSocketSession.class);
        when(session.isOpen()).thenReturn(true);
        return session;
    }

    @Test void orderedSingleWriterCountsUtf8AndReclaimsBytes() throws Exception {
        var executor = new ManualExecutor();
        var session = session();
        var written = new ArrayList<String>();
        doAnswer(call -> { written.add(((TextMessage) call.getArgument(0)).getPayload()); return null; }).when(session).sendMessage(any());
        var connection = new OutboundConnection(session, executor, 128, () -> {});
        assertTrue(connection.enqueue("가", true, () -> true));
        assertTrue(connection.enqueue("second", true, () -> true));
        assertEquals(9, connection.queuedBytes());
        assertEquals(1, executor.tasks.size());
        executor.run();
        assertEquals(List.of("가", "second"), written);
        assertEquals(0, connection.queuedBytes());
        assertTrue(connection.enqueue("third", true, () -> true));
        assertEquals(1, executor.tasks.size());
        executor.run();
        assertEquals(List.of("가", "second", "third"), written);
    }

    @Test void durableOverflowClosesAndClearsQueuedFramesExactlyOnce() throws Exception {
        var executor = new ManualExecutor();
        var session = session();
        var closed = new AtomicInteger();
        var connection = new OutboundConnection(session, executor, 4, closed::incrementAndGet);
        assertTrue(connection.enqueue("1234", true, () -> true));
        assertFalse(connection.enqueue("5", true, () -> true));
        assertFalse(connection.isOpen());
        assertEquals(0, connection.queuedBytes());
        assertEquals(1, closed.get());
        executor.run();
        verify(session, never()).sendMessage(any());
        verify(session).close(CloseStatus.SERVICE_OVERLOAD);
        connection.close(CloseStatus.NORMAL);
        assertEquals(1, closed.get());
    }

    @Test void ephemeralOverflowDropsOnlyOverflowFrame() throws Exception {
        var executor = new ManualExecutor();
        var session = session();
        var connection = new OutboundConnection(session, executor, 4, () -> {});
        assertTrue(connection.enqueue("1234", false, () -> true));
        assertFalse(connection.enqueue("5", false, () -> true));
        assertTrue(connection.isOpen());
        assertEquals(4, connection.queuedBytes());
        executor.run();
        verify(session).sendMessage(any(TextMessage.class));
        verify(session, never()).close(any());
        assertEquals(0, connection.queuedBytes());
    }

    @Test void revokedAuthorizationIsCheckedAtWriterAndSkipped() throws Exception {
        var executor = new ManualExecutor();
        var session = session();
        var authorized = new java.util.concurrent.atomic.AtomicBoolean(true);
        var connection = new OutboundConnection(session, executor, 128, () -> {});
        connection.enqueue("secret", true, authorized::get);
        authorized.set(false);
        executor.run();
        verify(session, never()).sendMessage(any());
        assertEquals(0, connection.queuedBytes());
        assertTrue(connection.isOpen());
    }

    @Test void eventCountIsBoundedEvenForEmptyFrames() throws Exception {
        var executor = new ManualExecutor();
        var session = session();
        var connection = new OutboundConnection(session, executor, 128, () -> {});
        for (int i = 0; i < 256; i++) assertTrue(connection.enqueue("", false, () -> true));
        assertFalse(connection.enqueue("", false, () -> true));
        assertFalse(connection.enqueue("", true, () -> true));
        verify(session).close(CloseStatus.SERVICE_OVERLOAD);
    }

    @Test void executorRejectionClosesAndReclaimsQueue() throws Exception {
        var session = session();
        var closed = new AtomicInteger();
        Executor rejecting = task -> { throw new RejectedExecutionException(); };
        var connection = new OutboundConnection(session, rejecting, 128, closed::incrementAndGet);
        assertFalse(connection.enqueue("committed", true, () -> true));
        assertEquals(0, connection.queuedBytes());
        assertFalse(connection.isOpen());
        assertEquals(1, closed.get());
        verify(session).close(CloseStatus.SERVICE_OVERLOAD);
    }

    @Test void blockedWriterDoesNotHoldQueueMonitorAndInflightBytesRemainBounded() throws Exception {
        var session = session();
        var started = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        doAnswer(call -> {
            started.countDown();
            assertTrue(release.await(5, TimeUnit.SECONDS));
            return null;
        }).when(session).sendMessage(any());
        try (var executor = Executors.newSingleThreadExecutor()) {
            var connection = new OutboundConnection(session, executor, 4, () -> {});
            try {
                assertTrue(connection.enqueue("1234", true, () -> true));
                assertTrue(started.await(5, TimeUnit.SECONDS));
                assertEquals(4, connection.queuedBytes());
                assertTimeoutPreemptively(java.time.Duration.ofSeconds(1), () -> {
                    assertFalse(connection.enqueue("5", false, () -> true));
                    connection.close(CloseStatus.NORMAL);
                });
                assertEquals(0, connection.queuedBytes());
            } finally { release.countDown(); }
        }
    }

    @Test void failedSendDetachesAndDiscardsRemainingFrames() throws Exception {
        var executor = new ManualExecutor();
        var session = session();
        doThrow(new IOException("broken socket")).when(session).sendMessage(any());
        var closed = new AtomicInteger();
        var connection = new OutboundConnection(session, executor, 128, closed::incrementAndGet);
        connection.enqueue("first", true, () -> true);
        connection.enqueue("second", true, () -> true);
        executor.run();
        verify(session, times(1)).sendMessage(any());
        verify(session).close(CloseStatus.SERVER_ERROR);
        assertEquals(1, closed.get());
        assertEquals(0, connection.queuedBytes());
    }
}
