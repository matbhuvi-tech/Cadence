package com.cadence.remote;

import android.net.Uri;
import android.net.http.SslCertificate;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Custom BridgeWebViewClient enforcing strict SPKI pinning for Cadence desktop LAN requests
 * (such as artwork <img> loads) while delegating bundled local assets to Capacitor.
 */
public class CadenceWebViewClient extends BridgeWebViewClient {

    private static final int MAX_IMAGE_BYTES = 4 * 1024 * 1024;

    public CadenceWebViewClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (uri != null && CadencePinnedStore.matchesPairedHost(uri)) {
            String method = request.getMethod() == null ? "GET" : request.getMethod().toUpperCase(Locale.US);
            if ("OPTIONS".equals(method)) {
                return buildCorsPreflightResponse();
            }
            if ("GET".equals(method) || "HEAD".equals(method)) {
                return proxyPinnedGet(uri, method, request.getRequestHeaders());
            }
        }
        return super.shouldInterceptRequest(view, request);
    }

    @Override
    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        if (error != null && error.getUrl() != null) {
            Uri uri = Uri.parse(error.getUrl());
            X509Certificate cert = extractX509Certificate(error.getCertificate());
            if (CadencePinnedStore.matchesPinnedCert(uri, cert)) {
                handler.proceed();
                return;
            }
        }
        handler.cancel();
    }

    private WebResourceResponse buildCorsPreflightResponse() {
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        headers.put("Access-Control-Allow-Headers", "*");
        headers.put("Access-Control-Allow-Private-Network", "true");
        return new WebResourceResponse(
            "text/plain",
            "utf-8",
            204,
            "No Content",
            headers,
            new ByteArrayInputStream(new byte[0])
        );
    }

    private WebResourceResponse proxyPinnedGet(
        Uri uri,
        String method,
        Map<String, String> reqHeaders
    ) {
        try {
            OkHttpClient client = CadencePinnedStore.getActiveClient();
            Request.Builder builder = new Request.Builder().url(uri.toString());
            if ("HEAD".equals(method)) {
                builder.head();
            } else {
                builder.get();
            }
            if (reqHeaders != null) {
                for (Map.Entry<String, String> entry : reqHeaders.entrySet()) {
                    String k = entry.getKey();
                    if (k != null && !k.equalsIgnoreCase("Host") && !k.equalsIgnoreCase("Connection")) {
                        builder.header(k, entry.getValue());
                    }
                }
            }
            try (Response resp = client.newCall(builder.build()).execute()) {
                int code = resp.code();
                String message = resp.message().isEmpty() ? "OK" : resp.message();
                String contentType = resp.header("Content-Type", "application/octet-stream");
                String mime = contentType;
                String encoding = "utf-8";
                if (contentType != null && contentType.contains(";")) {
                    String[] parts = contentType.split(";");
                    mime = parts[0].trim();
                    for (int i = 1; i < parts.length; i++) {
                        String p = parts[i].trim().toLowerCase(Locale.US);
                        if (p.startsWith("charset=")) {
                            encoding = p.substring("charset=".length()).trim();
                        }
                    }
                }

                Map<String, String> headers = new HashMap<>();
                headers.put("Access-Control-Allow-Origin", "*");
                headers.put("Access-Control-Allow-Private-Network", "true");
                String cacheControl = resp.header("Cache-Control");
                if (cacheControl != null) {
                    headers.put("Cache-Control", cacheControl);
                }

                byte[] bytes = new byte[0];
                ResponseBody body = resp.body();
                if (body != null && code != 204 && !"HEAD".equals(method)) {
                    bytes = readBoundedBytes(body.byteStream(), MAX_IMAGE_BYTES);
                }
                return new WebResourceResponse(
                    mime == null || mime.isEmpty() ? "application/octet-stream" : mime,
                    encoding,
                    code,
                    message,
                    headers,
                    new ByteArrayInputStream(bytes)
                );
            }
        } catch (Exception e) {
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            return new WebResourceResponse(
                "text/plain",
                "utf-8",
                502,
                "Bad Gateway",
                headers,
                new ByteArrayInputStream(new byte[0])
            );
        }
    }

    private static byte[] readBoundedBytes(InputStream is, int maxBytes) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int total = 0;
        int n;
        while ((n = is.read(buf)) != -1) {
            total += n;
            if (total > maxBytes) {
                throw new IllegalStateException("Response exceeded max buffer limit");
            }
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }

    private static X509Certificate extractX509Certificate(SslCertificate sslCert) {
        if (sslCert == null) return null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return sslCert.getX509Certificate();
        }
        try {
            Bundle bundle = SslCertificate.saveState(sslCert);
            byte[] bytes = bundle != null ? bundle.getByteArray("x509-certificate") : null;
            if (bytes != null) {
                CertificateFactory cf = CertificateFactory.getInstance("X.509");
                return (X509Certificate) cf.generateCertificate(new ByteArrayInputStream(bytes));
            }
        } catch (Exception ignored) {}
        return null;
    }
}

