package app.sidey.server.common;

import jakarta.servlet.*;
import jakarta.servlet.http.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestSizeFilter extends OncePerRequestFilter {
    private static final int LIMIT=262144;
    @Override protected void doFilterInternal(HttpServletRequest request,HttpServletResponse response,FilterChain chain)throws ServletException,IOException{
        if(request.getContentLengthLong()>LIMIT){response.setStatus(413);response.setContentType("application/json");response.getWriter().write("{\"code\":\"request_too_large\"}");return;}
        chain.doFilter(new HttpServletRequestWrapper(request){
            private ServletInputStream bounded;
            @Override public ServletInputStream getInputStream()throws IOException{
                if(bounded==null){var original=super.getInputStream();bounded=new ServletInputStream(){
                    int read;
                    public int read()throws IOException{int value=original.read();if(value>=0 && ++read>LIMIT)throw new IOException("request_too_large");return value;}
                    public int read(byte[] bytes,int offset,int length)throws IOException{int n=original.read(bytes,offset,Math.min(length,LIMIT-read+1));if(n>0 && (read+=n)>LIMIT)throw new IOException("request_too_large");return n;}
                    public boolean isFinished(){return original.isFinished();}public boolean isReady(){return original.isReady();}public void setReadListener(ReadListener listener){original.setReadListener(listener);}
                };}return bounded;
            }
            @Override public BufferedReader getReader()throws IOException{return new BufferedReader(new InputStreamReader(getInputStream(),StandardCharsets.UTF_8));}
        },response);
    }
}
