package app.sidey.server;

import static org.junit.jupiter.api.Assertions.*;
import app.sidey.server.common.ProviderHttp;
import com.sun.net.httpserver.HttpServer;
import java.net.*;
import java.net.http.*;
import java.time.Duration;
import java.util.concurrent.*;
import org.junit.jupiter.api.Test;

class ProviderHttpTest {
    @Test void limitsBodyAndCancelsResponseThatStallsAfterHeaders()throws Exception{
        var server=HttpServer.create(new InetSocketAddress("127.0.0.1",0),0);var release=new CountDownLatch(1);var pool=Executors.newCachedThreadPool();server.setExecutor(pool);
        server.createContext("/large",e->{e.sendResponseHeaders(200,2048);try(var out=e.getResponseBody()){out.write(new byte[2048]);}});
        server.createContext("/stall",e->{e.sendResponseHeaders(200,0);e.getResponseBody().flush();try{release.await(5,TimeUnit.SECONDS);}catch(InterruptedException ignored){Thread.currentThread().interrupt();}e.close();});server.start();
        try(var client=HttpClient.newHttpClient()){
            String base="http://127.0.0.1:"+server.getAddress().getPort();
            assertThrows(java.io.IOException.class,()->ProviderHttp.send(client,HttpRequest.newBuilder(URI.create(base+"/large")).build(),1024,Duration.ofSeconds(2)));
            long start=System.nanoTime();assertThrows(java.io.IOException.class,()->ProviderHttp.send(client,HttpRequest.newBuilder(URI.create(base+"/stall")).build(),1024,Duration.ofMillis(100)));assertTrue(System.nanoTime()-start<TimeUnit.SECONDS.toNanos(2));
        }finally{release.countDown();server.stop(0);pool.shutdownNow();}
    }
}
