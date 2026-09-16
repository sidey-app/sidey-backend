package app.sidey.server.common;

import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiErrors {
    @ExceptionHandler(org.springframework.web.servlet.resource.NoResourceFoundException.class)
    ResponseEntity<Map<String,String>> missing(Exception error){
        return ResponseEntity.status(404).body(Map.of("code","not_found"));
    }
    @ExceptionHandler(Exception.class)
    ResponseEntity<Map<String,String>> unexpected(Exception error){
        org.slf4j.LoggerFactory.getLogger(ApiErrors.class).error("request_failed exceptionType={}",error.getClass().getSimpleName());
        return ResponseEntity.internalServerError().body(Map.of("code","internal_error"));
    }
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
