package app.sidey.server.common;

import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiErrors {
    @ExceptionHandler(ApiException.class)
    ResponseEntity<Map<String, String>> domain(ApiException error) {
        return ResponseEntity.status(error.status()).body(Map.of("code", error.code()));
    }

    @ExceptionHandler({IllegalArgumentException.class,
            org.springframework.web.bind.MethodArgumentNotValidException.class,
            org.springframework.http.converter.HttpMessageNotReadableException.class})
    ResponseEntity<Map<String, String>> invalid(Exception error) {
        return ResponseEntity.badRequest().body(Map.of("code", "invalid_request"));
    }

    @ExceptionHandler(org.springframework.web.method.annotation.MethodArgumentTypeMismatchException.class)
    ResponseEntity<Map<String, String>> invalidType(Exception error) {
        return ResponseEntity.badRequest().body(Map.of("code", "invalid_request"));
    }

    @ExceptionHandler(org.jooq.exception.DataAccessException.class)
    ResponseEntity<Map<String, String>> database(org.jooq.exception.DataAccessException error) {
        String state = error.sqlState();
        int status = "23505".equals(state) ? 409 : state != null && state.startsWith("23") ? 400 : 503;
        return ResponseEntity.status(status).body(Map.of("code", status == 503 ? "database_unavailable" : "integrity_conflict"));
    }
}
