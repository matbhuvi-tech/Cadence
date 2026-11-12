package com.cadence.remote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.media.session.MediaButtonReceiver;
import java.util.Locale;

/**
 * Foreground MediaSession service providing native Android lock-screen & notification controls
 * without looping silent audio in the WebView. Runs only while remote playback is active/paused.
 */
public class CadenceMediaService extends Service implements CadenceRemoteStateHolder.ServiceObserver {

    public static final String ACTION_SYNC = "com.cadence.remote.ACTION_SYNC_MEDIA";
    private static final String CHANNEL_ID = "cadence_remote_media";
    private static final int NOTIFICATION_ID = 40401;

    private MediaSessionCompat mediaSession;
    private boolean isForegroundStarted = false;

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();

        mediaSession = new MediaSessionCompat(this, "CadenceRemoteMedia");
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                CadenceRemoteStateHolder.dispatchPlaybackControl("{\"action\":\"resume\"}");
            }

            @Override
            public void onPause() {
                CadenceRemoteStateHolder.dispatchPlaybackControl("{\"action\":\"pause\"}");
            }

            @Override
            public void onSkipToNext() {
                CadenceRemoteStateHolder.dispatchPlaybackControl("{\"action\":\"next_track\"}");
            }

            @Override
            public void onSkipToPrevious() {
                CadenceRemoteStateHolder.dispatchPlaybackControl("{\"action\":\"prev_track\"}");
            }

            @Override
            public void onSeekTo(long posMs) {
                double secs = Math.max(0.0, posMs / 1000.0);
                CadenceRemoteStateHolder.dispatchPlaybackControl(
                    String.format(Locale.US, "{\"action\":\"seek\",\"position_secs\":%.3f}", secs)
                );
            }

            @Override
            public void onStop() {
                CadenceRemoteStateHolder.dispatchPlaybackControl("{\"action\":\"stop\"}");
                stopGracefully();
            }
        });
        mediaSession.setActive(true);
        CadenceRemoteStateHolder.setServiceObserver(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            MediaButtonReceiver.handleIntent(mediaSession, intent);
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        CadenceRemoteStateHolder.setServiceObserver(null);
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
            mediaSession = null;
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onPlaybackSnapshot(
        CadenceRemoteStateHolder.PlaybackSnapshot snap,
        Bitmap artwork
    ) {
        if (mediaSession == null) return;
        if (!CadenceRemoteStateHolder.isMediaSessionEnabled() || (!snap.isPlaying && !snap.isPaused)) {
            stopGracefully();
            return;
        }

        long durationMs = Math.max(0L, Math.round(snap.durationSecs * 1000.0));
        long basePosMs = Math.max(0L, Math.round(snap.positionSecs * 1000.0));
        boolean activelyPlaying = snap.isPlaying && !snap.isPaused;

        MediaMetadataCompat.Builder meta = new MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, snap.title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, snap.artist)
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, snap.album)
            .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, durationMs);
        if (artwork != null && !artwork.isRecycled()) {
            meta.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, artwork);
        }
        mediaSession.setMetadata(meta.build());

        int stateCode = activelyPlaying ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED;
        long actions = PlaybackStateCompat.ACTION_PLAY
            | PlaybackStateCompat.ACTION_PAUSE
            | PlaybackStateCompat.ACTION_PLAY_PAUSE
            | PlaybackStateCompat.ACTION_SKIP_TO_NEXT
            | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            | PlaybackStateCompat.ACTION_SEEK_TO
            | PlaybackStateCompat.ACTION_STOP;

        PlaybackStateCompat playbackState = new PlaybackStateCompat.Builder()
            .setActions(actions)
            .setState(stateCode, basePosMs, activelyPlaying ? 1.0f : 0.0f, snap.updatedElapsedMs)
            .build();
        mediaSession.setPlaybackState(playbackState);

        Notification notification = buildNotification(snap, artwork, activelyPlaying);
        try {
            if (!isForegroundStarted) {
                int fgType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                    ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
                    : 0;
                ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, fgType);
                isForegroundStarted = true;
            } else {
                NotificationManager nm = getSystemService(NotificationManager.class);
                if (nm != null) {
                    nm.notify(NOTIFICATION_ID, notification);
                }
            }
        } catch (Exception ignored) {
            // Gracefully handle OS foreground restrictions
        }
    }

    private Notification buildNotification(
        CadenceRemoteStateHolder.PlaybackSnapshot snap,
        Bitmap artwork,
        boolean activelyPlaying
    ) {
        Intent openIntent = new Intent(this, MainActivity.class);
        openIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent contentIntent = PendingIntent.getActivity(this, 0, openIntent, piFlags);

        PendingIntent prevIntent = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this, PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
        );
        PendingIntent toggleIntent = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this, activelyPlaying ? PlaybackStateCompat.ACTION_PAUSE : PlaybackStateCompat.ACTION_PLAY
        );
        PendingIntent nextIntent = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this, PlaybackStateCompat.ACTION_SKIP_TO_NEXT
        );
        PendingIntent stopIntent = MediaButtonReceiver.buildMediaButtonPendingIntent(
            this, PlaybackStateCompat.ACTION_STOP
        );

        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_cadence)
            .setContentTitle(snap.title)
            .setContentText(snap.artist)
            .setSubText(snap.album)
            .setContentIntent(contentIntent)
            .setDeleteIntent(stopIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setOngoing(activelyPlaying)
            .addAction(
                new NotificationCompat.Action(
                    android.R.drawable.ic_media_previous,
                    "Previous",
                    prevIntent
                )
            )
            .addAction(
                new NotificationCompat.Action(
                    activelyPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                    activelyPlaying ? "Pause" : "Play",
                    toggleIntent
                )
            )
            .addAction(
                new NotificationCompat.Action(
                    android.R.drawable.ic_media_next,
                    "Next",
                    nextIntent
                )
            )
            .setStyle(
                new androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(mediaSession.getSessionToken())
                    .setShowActionsInCompactView(0, 1, 2)
                    .setShowCancelButton(true)
                    .setCancelButtonIntent(stopIntent)
            );

        if (artwork != null && !artwork.isRecycled()) {
            builder.setLargeIcon(artwork);
        }
        return builder.build();
    }

    private void stopGracefully() {
        isForegroundStarted = false;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Cadence Remote Playback",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Lock-screen and notification transport controls for Cadence Desktop");
            channel.setShowBadge(false);
            channel.enableVibration(false);
            channel.setSound(null, null);
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) {
                nm.createNotificationChannel(channel);
            }
        }
    }
}

