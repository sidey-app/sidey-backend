package app.sidey.server;

import static org.junit.jupiter.api.Assertions.assertEquals;
import app.sidey.server.common.ApiException;
import org.junit.jupiter.api.Test;

class BootstrapTest {
    @Test
    void domainErrorsExposeStableCodesOnly() {
        var error = new ApiException(409, "message_id_conflict");
        assertEquals(409, error.status());
        assertEquals("message_id_conflict", error.code());
        assertEquals(error.code(), error.getMessage());
    }
}
