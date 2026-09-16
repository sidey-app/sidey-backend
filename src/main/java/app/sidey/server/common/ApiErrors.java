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
}
