package com.cadence.remote;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "CadenceRemote",
    permissions = {
        @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications")
    }
)
public class CadenceRemotePlugin extends Plugin {

    private static final String MDNS_SERVICE_TYPE = "_cadence._tcp.";
    private static final MediaType JSON_MEDIA_TYPE = MediaType.get("application/json; charset=utf-8");
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        CadenceRemoteStateHolder.initContext(getContext());
        CadenceRemoteStateHolder.setSocketObserver(new CadenceRemoteStateHolder.SocketObserver() {
            @Override
            public void onOpen() {
                notifyListeners("socketOpen", new JSObject());
            }

            @Override
            public void onEvent(String rawJson) {
                JSObject data = new JSObject();
                data.put("raw", rawJson);
                notifyListeners("socketEvent", data);
            }

            @Override
            public void onClosed(int code, String reason) {
                JSObject data = new JSObject();
                data.put("code", code);
                data.put("reason", reason == null ? "" : reason);
                notifyListeners("socketClosed", data);
            }

            @Override
            public void onFailure(int httpStatus, String errorKind, String message, String observedFingerprint) {
                JSObject data = new JSObject();
                data.put("httpStatus", httpStatus);
                data.put("errorKind", errorKind);
                data.put("message", message);
                data.put("observedFingerprint", observedFingerprint);
                notifyListeners("socketFailure", data);
            }
        });
    }

    @PluginMethod
    public void setServerProfile(PluginCall call) {
        String baseUrl = call.getString("baseUrl", "");
        String token = call.getString("token", "");
        String fingerprint = call.getString("fingerprint", "");
        boolean trustInsecure = Boolean.TRUE.equals(call.getBoolean("trustInsecure", false));

        if (baseUrl != null && !baseUrl.trim().isEmpty()) {
            Uri uri = Uri.parse(baseUrl.trim());
            if (!CadencePinnedStore.isAllowedServerUri(uri)) {
                call.reject("Only https:// or private local-network http:// URLs are permitted.");
                return;
            }
        }
        CadencePinnedStore.setActiveProfile(baseUrl, token, fingerprint, trustInsecure);
        call.resolve();
    }

    @PluginMethod
    public void probeServer(PluginCall call) {
        String baseUrl = call.getString("baseUrl", "");
        String token = call.getString("token", "");
        String expectedFp = call.getString("fingerprint", "");
        boolean trustInsecure = Boolean.TRUE.equals(call.getBoolean("trustInsecure", false));
        int timeoutMs = call.getInt("timeoutMs", 3500);

        if (baseUrl == null || baseUrl.trim().isEmpty()) {
            call.reject("baseUrl is required");
            return;
        }
        String normalizedBase = baseUrl.trim().replaceAll("/+$", "");
        Uri parsed = Uri.parse(normalizedBase);
        if (!CadencePinnedStore.isAllowedServerUri(parsed)) {
            call.reject("Only https:// or private local-network http:// URLs are permitted.");
            return;
        }

        executor.execute(() -> {
            long t0 = System.currentTimeMillis();
            AtomicReference<String> observedFp = new AtomicReference<>("");
            // First inspect TLS + /ping using pinned verifier (unless trustInsecure), capturing observed SPKI
            String pinForProbe = trustInsecure ? "" : expectedFp;
            OkHttpClient client = CadencePinnedStore.buildClient(
                pinForProbe,
                trustInsecure,
                observedFp,
                timeoutMs
            );

            JSObject res = new JSObject();
            res.put("reachable", false);
            res.put("authenticated", false);
            res.put("httpStatus", 0);
            res.put("certFingerprint", "");
            res.put("fingerprintMatches", JSONObject.NULL);

            try {
                Request pingReq = new Request.Builder()
                    .url(normalizedBase + "/api/remote/ping")
                    .get()
                    .build();
                try (Response pingResp = client.newCall(pingReq).execute()) {
                    res.put("reachable", true);
                    res.put("httpStatus", pingResp.code());
                    String obs = observedFp.get();
                    res.put("certFingerprint", obs);
                    if (expectedFp != null && !expectedFp.trim().isEmpty() && !obs.isEmpty()) {
                        res.put(
                            "fingerprintMatches",
                            CadencePinnedStore.normalizeFingerprint(expectedFp).equals(obs)
                        );
                    }
                    if (pingResp.body() != null && pingResp.isSuccessful()) {
                        try {
                            JSONObject pingJson = new JSONObject(pingResp.body().string());
                            res.put("port", pingJson.optInt("port", parsed.getPort()));
                            res.put("service", pingJson.optString("service", ""));
                        } catch (Exception ignored) {}
                    }
                }

                if (token != null && !token.trim().isEmpty()) {
                    Request statusReq = new Request.Builder()
                        .url(normalizedBase + "/api/remote/status?token=" + Uri.encode(token.trim()))
                        .header("x-cadence-token", token.trim())
                        .get()
                        .build();
                    try (Response statusResp = client.newCall(statusReq).execute()) {
                        res.put("httpStatus", statusResp.code());
                        if (statusResp.isSuccessful()) {
                            res.put("authenticated", true);
                            res.put("errorKind", "ok");
                            res.put("errorMessage", "");
                        } else if (statusResp.code() == 401 || statusResp.code() == 403) {
                            res.put("authenticated", false);
                            res.put("errorKind", "unauthorized");
                            res.put("errorMessage", "Pairing PIN was rejected by Cadence Desktop.");
                        } else {
                            res.put("errorKind", "http_error");
                            res.put("errorMessage", "HTTP " + statusResp.code());
                        }
                    }
                } else {
                    res.put("errorKind", "ok");
                    res.put("errorMessage", "");
                }
            } catch (Exception e) {
                String kind = CadenceRemoteStateHolder.classifyThrowable(e, 0);
                String fp = !observedFp.get().isEmpty()
                    ? observedFp.get()
                    : CadenceRemoteStateHolder.extractObservedFingerprint(e);
                res.put("certFingerprint", fp);
                if ("cert_mismatch".equals(kind) || "cert_untrusted".equals(kind)) {
                    // TCP + TLS handshake reached the desktop host, just failed trust verification
                    res.put("reachable", true);
                    if (expectedFp != null && !expectedFp.trim().isEmpty() && !fp.isEmpty()) {
                        res.put(
                            "fingerprintMatches",
                            CadencePinnedStore.normalizeFingerprint(expectedFp).equals(fp)
                        );
                    }
                }
                res.put("errorKind", kind);
                res.put("errorMessage", e.getMessage() == null ? kind : e.getMessage());
            }

            res.put("latencyMs", System.currentTimeMillis() - t0);
            call.resolve(res);
        });
    }

    @PluginMethod
    public void httpRequest(PluginCall call) {
        String url = call.getString("url", "");
        String method = call.getString("method", "GET");
        String bodyStr = call.getString("body", null);
        JSObject headersObj = call.getObject("headers", new JSObject());

        if (url == null || url.trim().isEmpty()) {
            call.reject("url is required");
            return;
        }
        Uri uri = Uri.parse(url.trim());
        if (!CadencePinnedStore.isAllowedServerUri(uri)) {
            call.reject("Blocked non-local HTTP URL.");
            return;
        }

        executor.execute(() -> {
            Request.Builder reqBuilder = new Request.Builder().url(url.trim());
            if (headersObj != null) {
                Iterator<String> keys = headersObj.keys();
                while (keys.hasNext()) {
                    String k = keys.next();
                    String v = headersObj.getString(k);
                    if (v != null) {
                        reqBuilder.header(k, v);
                    }
                }
            }
            String upperMethod = method == null ? "GET" : method.toUpperCase(Locale.US);
            if ("POST".equals(upperMethod)) {
                RequestBody rb = RequestBody.create(bodyStr == null ? "" : bodyStr, JSON_MEDIA_TYPE);
                reqBuilder.post(rb);
            } else {
                reqBuilder.get();
            }

            JSObject out = new JSObject();
            try (Response resp = CadencePinnedStore.getActiveClient().newCall(reqBuilder.build()).execute()) {
                out.put("ok", resp.isSuccessful());
                out.put("status", resp.code());
                out.put("statusText", resp.message());
                out.put("body", resp.body() != null ? resp.body().string() : "");
                out.put("errorKind", resp.isSuccessful() ? "ok" : (resp.code() == 401 ? "unauthorized" : "http_error"));
                call.resolve(out);
            } catch (Exception e) {
                out.put("ok", false);
                out.put("status", 0);
                out.put("statusText", "");
                out.put("body", "");
                out.put("errorKind", CadenceRemoteStateHolder.classifyThrowable(e, 0));
                out.put("observedFingerprint", CadenceRemoteStateHolder.extractObservedFingerprint(e));
                out.put("errorMessage", e.getMessage() == null ? "Network request failed" : e.getMessage());
                call.resolve(out);
            }
        });
    }

    @PluginMethod
    public void connectSocket(PluginCall call) {
        String baseUrl = call.getString("baseUrl", "");
        String token = call.getString("token", "");
        String fingerprint = call.getString("fingerprint", "");
        boolean trustInsecure = Boolean.TRUE.equals(call.getBoolean("trustInsecure", false));
        boolean heartbeat = Boolean.TRUE.equals(call.getBoolean("heartbeat", true));

        if (baseUrl == null || !CadencePinnedStore.isAllowedServerUri(Uri.parse(baseUrl.trim()))) {
            call.reject("Invalid or unsafe desktop server URL.");
            return;
        }
        CadenceRemoteStateHolder.connectSocket(
            getContext(),
            baseUrl,
            token,
            fingerprint,
            trustInsecure,
            heartbeat
        );
        call.resolve();
    }

    @PluginMethod
    public void sendSocketCommand(PluginCall call) {
        String payload = call.getString("payload", "");
        boolean sent = payload != null && !payload.isEmpty() && CadenceRemoteStateHolder.sendCommandJson(payload);
        JSObject out = new JSObject();
        out.put("sent", sent);
        call.resolve(out);
    }

    @PluginMethod
    public void disconnectSocket(PluginCall call) {
        CadenceRemoteStateHolder.disconnectSocket();
        call.resolve();
    }

    @PluginMethod
    public void setBackgroundMode(PluginCall call) {
        boolean background = Boolean.TRUE.equals(call.getBoolean("background", false));
        boolean keepMediaSession = Boolean.TRUE.equals(call.getBoolean("keepMediaSession", true));
        CadenceRemoteStateHolder.setBackgroundMode(background, keepMediaSession);
        call.resolve();
    }

    @PluginMethod
    public void setMediaSessionEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        CadenceRemoteStateHolder.setMediaSessionEnabled(enabled);
        call.resolve();
    }

    @PluginMethod
    @SuppressWarnings("deprecation")
    public void discoverServers(PluginCall call) {
        int timeoutMs = Math.min(8000, Math.max(1000, call.getInt("timeoutMs", 3000)));
        Context ctx = getContext();
        NsdManager nsdManager = (NsdManager) ctx.getSystemService(Context.NSD_SERVICE);
        if (nsdManager == null) {
            JSObject out = new JSObject();
            out.put("servers", new JSArray());
            call.resolve(out);
            return;
        }

        WifiManager wifi = (WifiManager) ctx.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        WifiManager.MulticastLock multicastLock = null;
        if (wifi != null) {
            try {
                multicastLock = wifi.createMulticastLock("cadence_mdns_discovery");
                multicastLock.setReferenceCounted(false);
                multicastLock.acquire();
            } catch (Exception ignored) {
                multicastLock = null;
            }
        }

        final WifiManager.MulticastLock lockRef = multicastLock;
        final Map<String, JSObject> discovered = new ConcurrentHashMap<>();
        final ConcurrentLinkedQueue<NsdServiceInfo> resolveQueue = new ConcurrentLinkedQueue<>();
        final AtomicBoolean isResolving = new AtomicBoolean(false);
        final AtomicBoolean isFinished = new AtomicBoolean(false);

        final Runnable processNext = new Runnable() {
            @Override
            public void run() {
                if (isFinished.get() || !isResolving.compareAndSet(false, true)) return;
                NsdServiceInfo next = resolveQueue.poll();
                if (next == null) {
                    isResolving.set(false);
                    return;
                }
                final Runnable self = this;
                try {
                    nsdManager.resolveService(next, new NsdManager.ResolveListener() {
                        @Override
                        public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                            isResolving.set(false);
                            self.run();
                        }

                        @Override
                        public void onServiceResolved(NsdServiceInfo resolved) {
                            try {
                                InetAddress hostAddr = resolved.getHost();
                                String ip = hostAddr != null ? hostAddr.getHostAddress() : "";
                                int port = resolved.getPort();
                                Map<String, byte[]> attrs = resolved.getAttributes();
                                String fp = readAttr(attrs, "fp");
                                String hostLabel = readAttr(attrs, "host");
                                String mdnsHost = readAttr(attrs, "mdns");
                                String proto = readAttr(attrs, "proto");
                                if (proto.isEmpty()) proto = "https";

                                if (ip != null && !ip.isEmpty() && port > 0) {
                                    String key = ip + ":" + port;
                                    JSObject entry = new JSObject();
                                    entry.put("serviceName", resolved.getServiceName());
                                    entry.put("hostName", hostLabel.isEmpty() ? resolved.getServiceName() : hostLabel);
                                    entry.put("mDnsHost", mdnsHost);
                                    entry.put("ip", ip);
                                    entry.put("port", port);
                                    entry.put("protocol", proto);
                                    entry.put("baseUrl", proto + "://" + ip + ":" + port);
                                    entry.put("fingerprint", fp);
                                    discovered.put(key, entry);
                                    notifyListeners("serviceDiscovered", entry);
                                }
                            } catch (Exception ignored) {
                            } finally {
                                isResolving.set(false);
                                self.run();
                            }
                        }
                    });
                } catch (Exception ignored) {
                    isResolving.set(false);
                    self.run();
                }
            }
        };

        final NsdManager.DiscoveryListener discoveryListener = new NsdManager.DiscoveryListener() {
            @Override
            public void onDiscoveryStarted(String regType) {}

            @Override
            public void onServiceFound(NsdServiceInfo serviceInfo) {
                if (isFinished.get()) return;
                if (serviceInfo.getServiceType() != null
                    && serviceInfo.getServiceType().contains("_cadence._tcp")) {
                    resolveQueue.add(serviceInfo);
                    processNext.run();
                }
            }

            @Override
            public void onServiceLost(NsdServiceInfo serviceInfo) {}

            @Override
            public void onDiscoveryStopped(String serviceType) {}

            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                if (isFinished.compareAndSet(false, true)) {
                    releaseLock(lockRef);
                    JSObject out = new JSObject();
                    out.put("servers", new JSArray());
                    call.resolve(out);
                }
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {}
        };

        try {
            nsdManager.discoverServices(MDNS_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener);
        } catch (Exception e) {
            releaseLock(lockRef);
            JSObject out = new JSObject();
            out.put("servers", new JSArray());
            call.resolve(out);
            return;
        }

        mainHandler.postDelayed(() -> {
            if (isFinished.compareAndSet(false, true)) {
                try {
                    nsdManager.stopServiceDiscovery(discoveryListener);
                } catch (Exception ignored) {}
                releaseLock(lockRef);

                JSArray list = new JSArray();
                for (JSObject item : discovered.values()) {
                    list.put(item);
                }
                JSObject out = new JSObject();
                out.put("servers", list);
                call.resolve(out);
            }
        }, timeoutMs);
    }

    @PluginMethod
    public void getNetworkDiagnostics(PluginCall call) {
        Context ctx = getContext();
        ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);

        boolean hasNetwork = false;
        boolean isWifi = false;
        boolean isCellular = false;
        boolean isVpn = false;
        JSArray localIpv4s = new JSArray();

        if (cm != null) {
            Network active = cm.getActiveNetwork();
            if (active != null) {
                NetworkCapabilities caps = cm.getNetworkCapabilities(active);
                if (caps != null) {
                    hasNetwork = caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
                    isWifi = caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                        || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
                    isCellular = caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR);
                    isVpn = caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN);
                }
                LinkProperties props = cm.getLinkProperties(active);
                if (props != null) {
                    for (LinkAddress la : props.getLinkAddresses()) {
                        InetAddress addr = la.getAddress();
                        if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
                            localIpv4s.put(addr.getHostAddress() + "/" + la.getPrefixLength());
                        }
                    }
                }
            }
        }

        boolean isIgnoringBatteryOptimizations = true;
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        if (pm != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            isIgnoringBatteryOptimizations = pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        }

        boolean notificationsEnabled = NotificationManagerCompat.from(ctx).areNotificationsEnabled();

        JSObject out = new JSObject();
        out.put("hasNetwork", hasNetwork);
        out.put("isWifi", isWifi);
        out.put("isCellular", isCellular);
        out.put("isVpn", isVpn);
        out.put("localIpv4s", localIpv4s);
        out.put("isBatteryOptimized", !isIgnoringBatteryOptimizations);
        out.put("notificationsEnabled", notificationsEnabled);
        call.resolve(out);
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33) {
            JSObject out = new JSObject();
            out.put("granted", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
            call.resolve(out);
            return;
        }
        if (getPermissionState("notifications") == PermissionState.GRANTED) {
            JSObject out = new JSObject();
            out.put("granted", true);
            call.resolve(out);
            return;
        }
        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");
    }

    @PermissionCallback
    private void notificationPermissionCallback(PluginCall call) {
        boolean granted = getPermissionState("notifications") == PermissionState.GRANTED
            || NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        JSObject out = new JSObject();
        out.put("granted", granted);
        call.resolve(out);
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open battery settings");
        }
    }

    private static String readAttr(Map<String, byte[]> attrs, String key) {
        if (attrs == null) return "";
        byte[] raw = attrs.get(key);
        return raw == null ? "" : new String(raw, StandardCharsets.UTF_8).trim();
    }

    private static void releaseLock(WifiManager.MulticastLock lock) {
        if (lock != null) {
            try {
                if (lock.isHeld()) {
                    lock.release();
                }
            } catch (Exception ignored) {}
        }
    }
}

