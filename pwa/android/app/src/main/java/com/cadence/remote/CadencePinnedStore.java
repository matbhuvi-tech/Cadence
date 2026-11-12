package com.cadence.remote;

import android.net.Uri;
import java.net.InetAddress;
import java.net.URI;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.util.Locale;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import javax.net.ssl.HostnameVerifier;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLPeerUnverifiedException;
import javax.net.ssl.SSLSession;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;
import okhttp3.OkHttpClient;

/**
 * Stores the active Cadence desktop server profile and provides pinned TLS OkHttp clients.
 * Local http:// URLs are permitted strictly for private LAN / loopback / .local hosts.
 */
public final class CadencePinnedStore {

    public static final class ServerProfile {
        public final String baseUrl;
        public final String host;
        public final int port;
        public final String scheme;
        public final String token;
        public final String fingerprint; // lowercase 64-char hex SPKI SHA-256
        public final boolean trustInsecure;

        public ServerProfile(
            String baseUrl,
            String token,
            String fingerprint,
            boolean trustInsecure
        ) {
            String trimmed = baseUrl == null ? "" : baseUrl.trim().replaceAll("/+$", "");
            String parsedScheme = "https";
            String parsedHost = "";
            int parsedPort = 443;
            if (!trimmed.isEmpty()) {
                try {
                    URI uri = new URI(trimmed);
                    parsedScheme = uri.getScheme() == null ? "https" : uri.getScheme().toLowerCase(Locale.US);
                    parsedHost = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.US);
                    int p = uri.getPort();
                    parsedPort = p > 0 ? p : ("http".equals(parsedScheme) ? 80 : 443);
                } catch (Exception ignored) {
                    // Fallback to empty host
                }
            }
            this.baseUrl = trimmed;
            this.scheme = parsedScheme;
            this.host = parsedHost;
            this.port = parsedPort;
            this.token = token == null ? "" : token.trim();
            this.fingerprint = normalizeFingerprint(fingerprint);
            this.trustInsecure = trustInsecure;
        }
    }

    private static volatile ServerProfile activeProfile = new ServerProfile("", "", "", false);
    private static volatile OkHttpClient cachedClient = null;

    private CadencePinnedStore() {}

    public static synchronized void setActiveProfile(
        String baseUrl,
        String token,
        String fingerprint,
        boolean trustInsecure
    ) {
        activeProfile = new ServerProfile(baseUrl, token, fingerprint, trustInsecure);
        cachedClient = null;
    }

    public static ServerProfile getActiveProfile() {
        return activeProfile;
    }

    public static synchronized OkHttpClient getActiveClient() {
        if (cachedClient == null) {
            ServerProfile p = activeProfile;
            cachedClient = buildClient(p.fingerprint, p.trustInsecure, null, 8000);
        }
        return cachedClient;
    }

    public static String normalizeFingerprint(String fp) {
        if (fp == null) return "";
        return fp.replace(":", "").replace("-", "").trim().toLowerCase(Locale.US);
    }

    public static boolean isAllowedServerUri(Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.US);
        if (host.isEmpty()) return false;
        if ("https".equals(scheme)) return true;
        if ("http".equals(scheme)) {
            return isPrivateOrLocalHost(host);
        }
        return false;
    }

    public static boolean isPrivateOrLocalHost(String host) {
        if (host == null || host.isEmpty()) return false;
        String h = host.toLowerCase(Locale.US);
        if ("localhost".equals(h) || "127.0.0.1".equals(h) || "::1".equals(h) || h.endsWith(".local")) {
            return true;
        }
        try {
            // Only inspect numeric IP literals synchronously to avoid main-thread DNS lookups
            if (h.matches("^\\d{1,3}(\\.\\d{1,3}){3}$")) {
                InetAddress addr = InetAddress.getByName(h);
                return addr.isSiteLocalAddress() || addr.isLoopbackAddress() || addr.isLinkLocalAddress();
            }
        } catch (Exception ignored) {
            return false;
        }
        return false;
    }

    public static boolean matchesPairedHost(Uri uri) {
        ServerProfile p = activeProfile;
        if (uri == null || p.host.isEmpty()) return false;
        String uHost = uri.getHost() == null ? "" : uri.getHost().toLowerCase(Locale.US);
        String uScheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.US);
        int uPort = uri.getPort();
        if (uPort <= 0) {
            uPort = "http".equals(uScheme) ? 80 : 443;
        }
        return p.host.equals(uHost) && p.port == uPort && p.scheme.equals(uScheme);
    }

    public static boolean matchesPinnedCert(Uri uri, X509Certificate cert) {
        ServerProfile p = activeProfile;
        if (uri == null || cert == null || !matchesPairedHost(uri)) {
            return false;
        }
        if (p.trustInsecure) {
            return true;
        }
        if (p.fingerprint.isEmpty()) {
            return false;
        }
        String actual = computeSpkiSha256(cert);
        return p.fingerprint.equals(actual);
    }

    public static String computeSpkiSha256(X509Certificate cert) {
        if (cert == null || cert.getPublicKey() == null) return "";
        try {
            byte[] encoded = cert.getPublicKey().getEncoded();
            if (encoded == null) return "";
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(encoded);
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                sb.append(String.format(Locale.US, "%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    public static OkHttpClient buildClient(
        String expectedFingerprint,
        boolean allowTofu,
        AtomicReference<String> observedFingerprintOut,
        long timeoutMs
    ) {
        final String expected = normalizeFingerprint(expectedFingerprint);
        final X509TrustManager systemTm = loadSystemTrustManager();

        X509TrustManager pinnedTm = new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (systemTm != null) {
                    systemTm.checkClientTrusted(chain, authType);
                }
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
                if (chain == null || chain.length == 0) {
                    throw new CertificateException("Empty server certificate chain");
                }
                String observed = computeSpkiSha256(chain[0]);
                if (observedFingerprintOut != null && !observed.isEmpty()) {
                    observedFingerprintOut.set(observed);
                }
                if (systemTm != null) {
                    try {
                        systemTm.checkServerTrusted(chain, authType);
                        return;
                    } catch (CertificateException ignored) {
                        // Self-signed LAN cert: fall through to explicit SPKI fingerprint verification
                    }
                }
                if (!expected.isEmpty() && expected.equals(observed)) {
                    return;
                }
                if (allowTofu && expected.isEmpty()) {
                    return;
                }
                if (!expected.isEmpty()) {
                    throw new CertificateException("CADENCE_CERT_MISMATCH:" + observed);
                }
                throw new CertificateException("CADENCE_CERT_UNTRUSTED:" + observed);
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return systemTm != null ? systemTm.getAcceptedIssuers() : new X509Certificate[0];
            }
        };

        HostnameVerifier verifier = (String hostname, SSLSession session) -> {
            try {
                Certificate[] peer = session.getPeerCertificates();
                if (peer != null && peer.length > 0 && peer[0] instanceof X509Certificate) {
                    X509Certificate leaf = (X509Certificate) peer[0];
                    String observed = computeSpkiSha256(leaf);
                    if (observedFingerprintOut != null && !observed.isEmpty()) {
                        observedFingerprintOut.set(observed);
                    }
                    if (!expected.isEmpty() && expected.equals(observed)) {
                        return true;
                    }
                    if (allowTofu && expected.isEmpty()) {
                        return true;
                    }
                }
                return javax.net.ssl.HttpsURLConnection.getDefaultHostnameVerifier().verify(hostname, session);
            } catch (SSLPeerUnverifiedException e) {
                return false;
            }
        };

        try {
            SSLContext sslContext = SSLContext.getInstance("TLS");
            sslContext.init(null, new TrustManager[] { pinnedTm }, null);
            SSLSocketFactory sslSocketFactory = sslContext.getSocketFactory();

            long timeout = Math.max(1500L, timeoutMs);
            return new OkHttpClient.Builder()
                .sslSocketFactory(sslSocketFactory, pinnedTm)
                .hostnameVerifier(verifier)
                .connectTimeout(timeout, TimeUnit.MILLISECONDS)
                .readTimeout(timeout, TimeUnit.MILLISECONDS)
                .writeTimeout(timeout, TimeUnit.MILLISECONDS)
                .retryOnConnectionFailure(false)
                .build();
        } catch (Exception e) {
            return new OkHttpClient();
        }
    }

    private static X509TrustManager loadSystemTrustManager() {
        try {
            TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            tmf.init((KeyStore) null);
            for (TrustManager tm : tmf.getTrustManagers()) {
                if (tm instanceof X509TrustManager) {
                    return (X509TrustManager) tm;
                }
            }
        } catch (Exception ignored) {}
        return null;
    }
}
