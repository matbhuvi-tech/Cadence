package com.cadence.remote;

import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import java.io.InputStream;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONObject;

/**
 * Shared native state & OkHttp WebSocket bridge between Capacitor UI and CadenceMediaService.
 * Ensures lock-screen playback controls and track metadata stay synchronized even if the WebView
 * is suspended while the phone screen is locked.
 */
public final class CadenceRemoteStateHolder {

    public interface SocketObserver {
        void onOpen();
        void onEvent(String rawJson);
        void onClosed(int code, String reason);
        void onFailure(int httpStatus, String errorKind, String message, String observedFingerprint);
    }

    public interface ServiceObserver {
        void onPlaybackSnapshot(PlaybackSnapshot snapshot, Bitmap artwork);
    }

    public static final class PlaybackSnapshot {
        public final boolean isPlaying;
        public final boolean isPaused;
        public final String currentFile;
        public final String title;
        public final String artist;
        public final String album;
        public final double positionSecs;
        public final double durationSecs;
        public final long updatedElapsedMs;

        public PlaybackSnapshot(
            boolean isPlaying,
            boolean isPaused,
            String currentFile,
            String title,
            String artist,
            String album,
            double positionSecs,
            double durationSecs,
            long updatedElapsedMs
        ) {
            this.isPlaying = isPlaying;
            this.isPaused = isPaused;
            this.currentFile = currentFile;
            this.title = title;
            this.artist = artist;
            this.album = album;
            this.positionSecs = positionSecs;
            this.durationSecs = durationSecs;
            this.updatedElapsedMs = updatedElapsedMs;
        }
    }

    private static final MediaType JSON_MEDIA_TYPE = MediaType.get("application/json; charset=utf-8");
    private static final ExecutorService IO_EXECUTOR = Executors.newSingleThreadExecutor();

    private static final Object LOCK = new Object();
    private static WebSocket activeSocket = null;
    private static SocketObserver socketObserver = null;
    private static ServiceObserver serviceObserver = null;
    private static Context appContext = null;

    private static final AtomicBoolean mediaSessionEnabled = new AtomicBoolean(true);
    private static final AtomicBoolean isBackgrounded = new AtomicBoolean(false);

    private static PlaybackSnapshot lastSnapshot = new PlaybackSnapshot(
        false, false, "", "Cadence", "Cadence Audiophile", "", 0.0, 0.0, 0L
    );
    private static String cachedArtworkFile = "";
    private static Bitmap cachedArtworkBitmap = null;

    private CadenceRemoteStateHolder() {}

    public static void initContext(Context ctx) {
        if (ctx != null && appContext == null) {
            appContext = ctx.getApplicationContext();
        }
    }

    public static void setSocketObserver(SocketObserver observer) {
        synchronized (LOCK) {
            socketObserver = observer;
        }
    }

    public static void setServiceObserver(ServiceObserver observer) {
        PlaybackSnapshot snap;
        Bitmap art;
        synchronized (LOCK) {
            serviceObserver = observer;
            snap = lastSnapshot;
            art = cachedArtworkBitmap;
        }
        if (observer != null) {
            observer.onPlaybackSnapshot(snap, art);
        }
    }

    public static void setMediaSessionEnabled(boolean enabled) {
        mediaSessionEnabled.set(enabled);
        if (!enabled) {
            stopMediaService();
        } else {
            PlaybackSnapshot snap;
            synchronized (LOCK) {
                snap = lastSnapshot;
            }
            if (snap.isPlaying || snap.isPaused) {
                syncMediaServiceState(snap);
            }
        }
    }

    public static boolean isMediaSessionEnabled() {
        return mediaSessionEnabled.get();
    }

    public static void setBackgroundMode(boolean background, boolean keepMediaSession) {
        isBackgrounded.set(background);
        PlaybackSnapshot snap;
        WebSocket ws;
        synchronized (LOCK) {
            snap = lastSnapshot;
            ws = activeSocket;
        }

        if (background) {
            boolean activePlayback = snap.isPlaying || snap.isPaused;
            if (keepMediaSession && mediaSessionEnabled.get() && activePlayback) {
                // Keep event-driven STATE_CHANGE pushes while suppressing 5s HEARTBEAT ticks
                if (ws != null) {
                    ws.send("{\"action\":\"set_client_mode\",\"heartbeat\":false}");
                }
            } else {
                // Zero Wi-Fi radio activity when idle or lock-screen sync is off
                disconnectSocket();
            }
        } else {
            if (ws != null) {
                ws.send("{\"action\":\"set_client_mode\",\"heartbeat\":true}");
            }
        }
    }

    public static void connectSocket(
        Context ctx,
        String baseUrl,
        String token,
        String fingerprint,
        boolean trustInsecure,
        boolean heartbeat
    ) {
        initContext(ctx);
        CadencePinnedStore.setActiveProfile(baseUrl, token, fingerprint, trustInsecure);

        disconnectSocketOnly();

        CadencePinnedStore.ServerProfile profile = CadencePinnedStore.getActiveProfile();
        if (profile.baseUrl.isEmpty() || profile.token.isEmpty()) {
            notifyFailure(0, "config_error", "Desktop URL or pairing token is missing.", "");
            return;
        }

        String wsScheme = "http".equals(profile.scheme) ? "ws" : "wss";
        String wsUrl = String.format(
            Locale.US,
            "%s://%s:%d/api/remote/ws?token=%s&heartbeat=%s",
            wsScheme,
            profile.host,
            profile.port,
            Uri.encode(profile.token),
            heartbeat ? "true" : "false"
        );

        OkHttpClient client = CadencePinnedStore.getActiveClient();
        Request request = new Request.Builder().url(wsUrl).build();
        final java.util.concurrent.atomic.AtomicReference<WebSocket> createdRef = new java.util.concurrent.atomic.AtomicReference<>();

        WebSocket ws = client.newWebSocket(request, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                synchronized (LOCK) {
                    if (activeSocket != webSocket) return;
                }
                SocketObserver obs;
                synchronized (LOCK) {
                    obs = socketObserver;
                }
                if (obs != null) obs.onOpen();
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                synchronized (LOCK) {
                    if (activeSocket != webSocket) return;
                }
                handleIncomingMessage(text);
                SocketObserver obs;
                synchronized (LOCK) {
                    obs = socketObserver;
                }
                if (obs != null) obs.onEvent(text);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                synchronized (LOCK) {
                    if (activeSocket != webSocket) return;
                    activeSocket = null;
                }
                SocketObserver obs;
                synchronized (LOCK) {
                    obs = socketObserver;
                }
                if (obs != null) obs.onClosed(code, reason);
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                synchronized (LOCK) {
                    if (activeSocket != webSocket) return;
                    activeSocket = null;
                }
                int code = response != null ? response.code() : 0;
                String kind = classifyThrowable(t, code);
                String observedFp = extractObservedFingerprint(t);
                String msg = t != null && t.getMessage() != null ? t.getMessage() : "Connection failed";
                notifyFailure(code, kind, msg, observedFp);
            }
        });

        synchronized (LOCK) {
            createdRef.set(ws);
            activeSocket = ws;
        }
    }

    public static boolean sendCommandJson(String json) {
        WebSocket ws;
        synchronized (LOCK) {
            ws = activeSocket;
        }
        if (ws != null) {
            try {
                if (ws.send(json)) {
                    return true;
                }
            } catch (Exception ignored) {}
        }
        return false;
    }

    public static void dispatchPlaybackControl(String jsonCommand) {
        if (sendCommandJson(jsonCommand)) {
            return;
        }
        IO_EXECUTOR.execute(() -> {
            CadencePinnedStore.ServerProfile p = CadencePinnedStore.getActiveProfile();
            if (p.baseUrl.isEmpty() || p.token.isEmpty()) return;
            String url = p.baseUrl + "/api/remote/command?token=" + Uri.encode(p.token);
            Request req = new Request.Builder()
                .url(url)
                .header("x-cadence-token", p.token)
                .post(RequestBody.create(jsonCommand, JSON_MEDIA_TYPE))
                .build();
            try (Response resp = CadencePinnedStore.getActiveClient().newCall(req).execute()) {
                // Triggered command; if status succeeded and playback paused/resumed, refresh status
                if (resp.isSuccessful()) {
                    refreshStatusOnce();
                }
            } catch (Exception ignored) {}
        });
    }

    public static void disconnectSocket() {
        disconnectSocketOnly();
        stopMediaService();
    }

    private static void disconnectSocketOnly() {
        WebSocket ws;
        synchronized (LOCK) {
            ws = activeSocket;
            activeSocket = null;
        }
        if (ws != null) {
            try {
                ws.close(1000, "Client disconnected");
            } catch (Exception ignored) {
                ws.cancel();
            }
        }
    }

    private static void refreshStatusOnce() {
        CadencePinnedStore.ServerProfile p = CadencePinnedStore.getActiveProfile();
        if (p.baseUrl.isEmpty() || p.token.isEmpty()) return;
        String url = p.baseUrl + "/api/remote/status?token=" + Uri.encode(p.token);
        Request req = new Request.Builder()
            .url(url)
            .header("x-cadence-token", p.token)
            .get()
            .build();
        try (Response resp = CadencePinnedStore.getActiveClient().newCall(req).execute()) {
            if (!resp.isSuccessful() || resp.body() == null) return;
            JSONObject obj = new JSONObject(resp.body().string());
            JSONObject stream = obj.optJSONObject("streamInfo");
            String file = obj.optString("currentFile", "");
            boolean playing = obj.optBoolean("isPlaying", false);
            boolean paused = obj.optBoolean("isPaused", false);
            double pos = obj.optDouble("positionSecs", 0.0);
            double dur = obj.optDouble("durationSecs", 0.0);
            String title = stream != null ? stream.optString("title", "") : "";
            String artist = stream != null ? stream.optString("artist", "") : "";
            String album = stream != null ? stream.optString("album", "") : "";
            updateSnapshot(playing, paused, file, title, artist, album, pos, dur);
        } catch (Exception ignored) {}
    }

    private static void handleIncomingMessage(String text) {
        try {
            JSONObject obj = new JSONObject(text);
            String type = obj.optString("type", "");
            if ("STATE_CHANGE".equals(type)) {
                boolean playing = obj.optBoolean("is_playing", false);
                boolean paused = obj.optBoolean("is_paused", false);
                String file = obj.isNull("current_file") ? "" : obj.optString("current_file", "");
                double pos = obj.optDouble("position_secs", 0.0);
                double dur = obj.optDouble("duration_secs", 0.0);
                JSONObject stream = obj.optJSONObject("stream_info");
                String title = stream != null && !stream.isNull("title") ? stream.optString("title", "") : "";
                String artist = stream != null && !stream.isNull("artist") ? stream.optString("artist", "") : "";
                String album = stream != null && !stream.isNull("album") ? stream.optString("album", "") : "";
                updateSnapshot(playing, paused, file, title, artist, album, pos, dur);
            } else if ("HEARTBEAT".equals(type)) {
                PlaybackSnapshot prev;
                synchronized (LOCK) {
                    prev = lastSnapshot;
                }
                boolean playing = obj.optBoolean("is_playing", prev.isPlaying);
                double pos = obj.optDouble("position_secs", prev.positionSecs);
                double dur = obj.optDouble("duration_secs", prev.durationSecs);
                updateSnapshot(
                    playing,
                    !playing && prev.isPaused,
                    prev.currentFile,
                    prev.title,
                    prev.artist,
                    prev.album,
                    pos,
                    dur
                );
            }
        } catch (Exception ignored) {}
    }

    private static void updateSnapshot(
        boolean playing,
        boolean paused,
        String file,
        String title,
        String artist,
        String album,
        double pos,
        double dur
    ) {
        String resolvedTitle = (title != null && !title.isEmpty()) ? title : fallbackTitleFromFile(file);
        String resolvedArtist = (artist != null && !artist.isEmpty()) ? artist : "Cadence Audiophile";
        String resolvedAlbum = (album != null && !album.isEmpty()) ? album : "Bit-Perfect Playback";

        PlaybackSnapshot snap = new PlaybackSnapshot(
            playing,
            paused,
            file == null ? "" : file,
            resolvedTitle,
            resolvedArtist,
            resolvedAlbum,
            pos,
            dur,
            SystemClock.elapsedRealtime()
        );

        boolean needArtworkFetch = false;
        Bitmap artToEmit;
        ServiceObserver obs;
        synchronized (LOCK) {
            lastSnapshot = snap;
            if (snap.currentFile.isEmpty()) {
                cachedArtworkFile = "";
                cachedArtworkBitmap = null;
            } else if (!snap.currentFile.equals(cachedArtworkFile)) {
                cachedArtworkFile = snap.currentFile;
                cachedArtworkBitmap = null;
                needArtworkFetch = true;
            }
            artToEmit = cachedArtworkBitmap;
            obs = serviceObserver;
        }

        if (obs != null) {
            obs.onPlaybackSnapshot(snap, artToEmit);
        }

        if (needArtworkFetch && mediaSessionEnabled.get() && (playing || paused)) {
            fetchArtworkAsync(snap.currentFile);
        }

        syncMediaServiceState(snap);
    }

    private static void fetchArtworkAsync(final String fileKey) {
        IO_EXECUTOR.execute(() -> {
            CadencePinnedStore.ServerProfile p = CadencePinnedStore.getActiveProfile();
            if (p.baseUrl.isEmpty() || p.token.isEmpty() || fileKey.isEmpty()) return;
            String url = p.baseUrl + "/api/remote/library/artwork/" + Uri.encode(fileKey) + "?token=" + Uri.encode(p.token);
            Request req = new Request.Builder()
                .url(url)
                .header("x-cadence-token", p.token)
                .get()
                .build();
            try (Response resp = CadencePinnedStore.getActiveClient().newCall(req).execute()) {
                if (!resp.isSuccessful() || resp.code() == 204 || resp.body() == null) return;
                try (InputStream is = resp.body().byteStream()) {
                    Bitmap bmp = BitmapFactory.decodeStream(is);
                    if (bmp == null) return;
                    ServiceObserver obs;
                    PlaybackSnapshot snap;
                    synchronized (LOCK) {
                        if (!fileKey.equals(cachedArtworkFile)) {
                            bmp.recycle();
                            return;
                        }
                        cachedArtworkBitmap = bmp;
                        snap = lastSnapshot;
                        obs = serviceObserver;
                    }
                    if (obs != null) {
                        obs.onPlaybackSnapshot(snap, bmp);
                    }
                }
            } catch (Exception ignored) {}
        });
    }

    private static void syncMediaServiceState(PlaybackSnapshot snap) {
        Context ctx = appContext;
        if (ctx == null) return;
        boolean shouldRun = mediaSessionEnabled.get() && (snap.isPlaying || snap.isPaused);
        if (!shouldRun) {
            stopMediaService();
            return;
        }
        Intent intent = new Intent(ctx, CadenceMediaService.class);
        intent.setAction(CadenceMediaService.ACTION_SYNC);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent);
            } else {
                ctx.startService(intent);
            }
        } catch (Exception ignored) {
            // Avoid ForegroundServiceStartNotAllowedException crash if OS restricts background start
        }
    }

    private static void stopMediaService() {
        Context ctx = appContext;
        if (ctx == null) return;
        try {
            ctx.stopService(new Intent(ctx, CadenceMediaService.class));
        } catch (Exception ignored) {}
    }

    private static String fallbackTitleFromFile(String file) {
        if (file == null || file.isEmpty()) return "Cadence";
        int idx = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
        return idx >= 0 && idx + 1 < file.length() ? file.substring(idx + 1) : file;
    }

    private static void notifyFailure(int httpStatus, String kind, String message, String observedFp) {
        SocketObserver obs;
        synchronized (LOCK) {
            obs = socketObserver;
        }
        if (obs != null) {
            obs.onFailure(httpStatus, kind, message, observedFp);
        }
    }

    public static String classifyThrowable(Throwable t, int httpStatus) {
        if (httpStatus == 401 || httpStatus == 403) {
            return "unauthorized";
        }
        if (t == null) {
            return httpStatus >= 400 ? "http_error" : "network_error";
        }
        String msg = collectMessages(t);
        if (msg.contains("CADENCE_CERT_MISMATCH")) return "cert_mismatch";
        if (msg.contains("CADENCE_CERT_UNTRUSTED")) return "cert_untrusted";
        if (t instanceof javax.net.ssl.SSLException || msg.contains("Trust anchor") || msg.contains("SSL")) {
            return "cert_untrusted";
        }
        if (t instanceof java.net.SocketTimeoutException || msg.contains("timed out")) {
            return "timeout";
        }
        if (t instanceof java.net.UnknownHostException) {
            return "dns_error";
        }
        if (t instanceof java.net.ConnectException || msg.contains("ECONNREFUSED") || msg.contains("Connection refused")) {
            return "connection_refused";
        }
        return "network_error";
    }

    public static String extractObservedFingerprint(Throwable t) {
        String msg = collectMessages(t);
        int idx = msg.indexOf("CADENCE_CERT_MISMATCH:");
        if (idx >= 0) {
            return parseHex64(msg.substring(idx + "CADENCE_CERT_MISMATCH:".length()));
        }
        idx = msg.indexOf("CADENCE_CERT_UNTRUSTED:");
        if (idx >= 0) {
            return parseHex64(msg.substring(idx + "CADENCE_CERT_UNTRUSTED:".length()));
        }
        return "";
    }

    private static String parseHex64(String raw) {
        if (raw == null || raw.length() < 64) return "";
        String candidate = raw.substring(0, 64);
        return candidate.matches("[0-9a-fA-F]{64}") ? candidate.toLowerCase(Locale.US) : "";
    }

    private static String collectMessages(Throwable t) {
        StringBuilder sb = new StringBuilder();
        Throwable cur = t;
        int depth = 0;
        while (cur != null && depth < 6) {
            if (cur.getMessage() != null) sb.append(cur.getMessage()).append(' ');
            cur = cur.getCause();
            depth++;
        }
        return sb.toString();
    }
}
