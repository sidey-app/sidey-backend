package app.sidey.server.room;

import app.sidey.server.common.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public final class InviteCodes {
    private final byte[] pepper;
    private final SecureRandom random=new SecureRandom();
    public InviteCodes(@Value("${sidey.room.invite-pepper}") String encodedPepper) {
        pepper=Base64.getDecoder().decode(encodedPepper);
        if(pepper.length<32) throw new IllegalArgumentException("invite_pepper_must_be_at_least_256_bits");
    }
    public String generate() {
        byte[] bytes=new byte[16];random.nextBytes(bytes);
        String hex=HexFormat.of().withUpperCase().formatHex(bytes);
        return hex.substring(0,8)+"-"+hex.substring(8,16)+"-"+hex.substring(16,24)+"-"+hex.substring(24);
    }
    public byte[] hash(String code) {
        String normalized=code==null?"":code.strip().replace("-","").toUpperCase(java.util.Locale.ROOT);
        if(!normalized.matches("[A-F0-9]{32}")) throw new ApiException(400,"invalid_invite_code");
        try {
            Mac mac=Mac.getInstance("HmacSHA256");mac.init(new SecretKeySpec(pepper,"HmacSHA256"));
            return mac.doFinal(normalized.getBytes(StandardCharsets.UTF_8));
        } catch(java.security.GeneralSecurityException impossible) { throw new IllegalStateException(impossible); }
    }
    public String hint(String code) { String clean=code.replace("-","");return clean.substring(0,4)+"…"+clean.substring(28); }
}
