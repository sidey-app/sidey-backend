package app.sidey.server.apple;

public interface AppleAuthorization {
    boolean revoke(String authorizationCode,String expectedSubject);
}
