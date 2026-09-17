package app.sidey.server.common;

import java.io.*;
import java.net.http.*;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.Flow;

/** Deadline covers response body as well as headers; provider bodies are bounded. */
public final class ProviderHttp {
    private ProviderHttp(){}
    public static HttpResponse<byte[]> send(HttpClient client,HttpRequest request,int maximum,Duration timeout)throws IOException,InterruptedException{
        var future=client.sendAsync(request,info->new Body(maximum));
        try{return future.get(timeout.toMillis(),TimeUnit.MILLISECONDS);}
        catch(TimeoutException timeoutFailure){future.cancel(true);throw new IOException("provider_timeout");}
        catch(ExecutionException failed){throw new IOException("provider_request_failed");}
        catch(InterruptedException interrupted){future.cancel(true);throw interrupted;}
    }
    private static final class Body implements HttpResponse.BodySubscriber<byte[]> {
        private final int maximum;private final ByteArrayOutputStream data=new ByteArrayOutputStream();
        private final CompletableFuture<byte[]> body=new CompletableFuture<>();private Flow.Subscription subscription;
        Body(int maximum){this.maximum=maximum;}
        public CompletionStage<byte[]> getBody(){return body;}
        public void onSubscribe(Flow.Subscription s){subscription=s;s.request(1);}
        public void onNext(List<ByteBuffer> chunks){
            for(ByteBuffer chunk:chunks){if(chunk.remaining()>maximum-data.size()){subscription.cancel();body.completeExceptionally(new IOException("provider_body_too_large"));return;}byte[] bytes=new byte[chunk.remaining()];chunk.get(bytes);data.writeBytes(bytes);}subscription.request(1);
        }
        public void onError(Throwable error){body.completeExceptionally(error);}
        public void onComplete(){body.complete(data.toByteArray());}
    }
}
