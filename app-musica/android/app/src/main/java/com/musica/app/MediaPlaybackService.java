package com.musica.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.Binder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Base64;
import android.util.Log;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Servicio en Primer Plano (Foreground Service) de Reproducción de Audio
 * 
 * PROPÓSITOS CLAVE:
 * 1. Mantiene activo el WakeLock y el hilo de audio cuando la pantalla está apagada
 *    o la app está en segundo plano, evitando que la música se detenga después de un tiempo.
 * 2. Gestiona el AudioFocus nativo de Android (API 26+ AudioFocusRequest con AUDIOFOCUS_GAIN),
 *    pausando en llamadas/audio exclusivo, reanudando automáticamente al recuperar foco y aplicando
 *    ducking temporal en notificaciones cortas.
 * 3. Muestra la tarjeta interactiva de control multimedia del sistema (Quick Settings / Lockscreen)
 *    estilo Spotify con carátula, título, artista, barra de progreso y botones de Prev/Play/Pause/Next.
 */
public class MediaPlaybackService extends Service implements AudioManager.OnAudioFocusChangeListener {

    private static final String TAG = "MediaPlaybackService";
    public static final String CANAL_ID = "canal_reproduccion_musica";
    public static final int NOTIFICACION_ID = 1001;

    public static final String ACCION_PLAY = "com.musica.app.ACTION_PLAY";
    public static final String ACCION_PAUSE = "com.musica.app.ACTION_PAUSE";
    public static final String ACCION_PREV = "com.musica.app.ACTION_PREV";
    public static final String ACCION_NEXT = "com.musica.app.ACTION_NEXT";
    public static final String ACCION_STOP = "com.musica.app.ACTION_STOP";

    private MediaSession mediaSession;
    private PowerManager.WakeLock wakeLock;
    private NotificationManager notificationManager;
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private boolean tieneAudioFocus = false;
    private boolean reanudarAlRecuperarFoco = false;
    private boolean enDucking = false;

    private String tituloActual = "App Música";
    private String artistaActual = "Reproduciendo...";
    private long duracionActualMs = 0;
    private long posicionActualMs = 0;
    private boolean estaReproduciendo = false;
    private Bitmap bitmapCaratulaActual = null;
    private String ultimaUrlCaratula = null;

    private final IBinder binder = new LocalBinder();

    public class LocalBinder extends Binder {
        public MediaPlaybackService getService() {
            return MediaPlaybackService.this;
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return binder;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        // 1. Crear canal de notificación para Android 8.0+ (Oreo+)
        crearCanalNotificacion();

        // 2. Adquirir WakeLock para evitar que Doze Mode congele la música
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "AppMusica:AudioWakeLock");
            wakeLock.setReferenceCounted(false);
        }

        // 3. Inicializar MediaSession nativa
        inicializarMediaSession();
    }

    /**
     * Solicita AudioFocus de sistema (AUDIOFOCUS_GAIN) usando AudioFocusRequest en API 26+
     */
    private boolean solicitarAudioFocus() {
        if (audioManager == null) return false;
        if (tieneAudioFocus) return true;

        int resultado;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build();
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(attrs)
                        .setAcceptsDelayedFocusGain(true)
                        .setWillPauseWhenDucked(false)
                        .setOnAudioFocusChangeListener(this)
                        .build();
            }
            resultado = audioManager.requestAudioFocus(audioFocusRequest);
        } else {
            resultado = audioManager.requestAudioFocus(
                    this,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN
            );
        }

        tieneAudioFocus = (resultado == AudioManager.AUDIOFOCUS_REQUEST_GRANTED);
        return tieneAudioFocus;
    }

    /**
     * Libera AudioFocus cuando el servicio se detiene por completo
     */
    private void abandonarAudioFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
            } else {
                audioManager.abandonAudioFocus(this);
            }
        } catch (Exception ignored) {}
        tieneAudioFocus = false;
        reanudarAlRecuperarFoco = false;
        enDucking = false;
    }

    @Override
    public void onAudioFocusChange(int focusChange) {
        switch (focusChange) {
            case AudioManager.AUDIOFOCUS_LOSS:
                tieneAudioFocus = false;
                reanudarAlRecuperarFoco = estaReproduciendo;
                if (estaReproduciendo) {
                    MainActivity.enviarAccionRemotaAWebView("pause", 0);
                }
                break;

            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                tieneAudioFocus = false;
                if (estaReproduciendo) {
                    reanudarAlRecuperarFoco = true;
                    MainActivity.enviarAccionRemotaAWebView("pause", 0);
                }
                break;

            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                if (estaReproduciendo && !enDucking) {
                    enDucking = true;
                    MainActivity.enviarAccionRemotaAWebView("duck", 25);
                }
                break;

            case AudioManager.AUDIOFOCUS_GAIN:
                tieneAudioFocus = true;
                if (enDucking) {
                    enDucking = false;
                    MainActivity.enviarAccionRemotaAWebView("unduck", 100);
                }
                if (reanudarAlRecuperarFoco) {
                    reanudarAlRecuperarFoco = false;
                    MainActivity.enviarAccionRemotaAWebView("play", 0);
                }
                break;
        }
    }

    private void crearCanalNotificacion() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel canal = new NotificationChannel(
                    CANAL_ID,
                    "Reproductor de Música",
                    NotificationManager.IMPORTANCE_LOW
            );
            canal.setDescription("Controles de reproducción y estado en vivo de la música");
            canal.setShowBadge(false);
            canal.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
            if (notificationManager != null) {
                notificationManager.createNotificationChannel(canal);
            }
        }
    }

    private void inicializarMediaSession() {
        mediaSession = new MediaSession(this, "AppMusicaSession");
        mediaSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);

        mediaSession.setCallback(new MediaSession.Callback() {
            @Override
            public void onPlay() {
                solicitarAudioFocus();
                reanudarAlRecuperarFoco = false;
                MainActivity.enviarAccionRemotaAWebView("play", 0);
            }

            @Override
            public void onPause() {
                reanudarAlRecuperarFoco = false;
                MainActivity.enviarAccionRemotaAWebView("pause", 0);
            }

            @Override
            public void onSkipToNext() {
                solicitarAudioFocus();
                MainActivity.enviarAccionRemotaAWebView("next", 0);
            }

            @Override
            public void onSkipToPrevious() {
                solicitarAudioFocus();
                MainActivity.enviarAccionRemotaAWebView("previous", 0);
            }

            @Override
            public void onSeekTo(long pos) {
                MainActivity.enviarAccionRemotaAWebView("seek", pos);
            }

            @Override
            public void onStop() {
                reanudarAlRecuperarFoco = false;
                MainActivity.enviarAccionRemotaAWebView("pause", 0);
                detenerReproduccion();
            }
        });

        mediaSession.setActive(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getAction() != null) {
            String accion = intent.getAction();
            if (ACCION_PLAY.equals(accion)) {
                solicitarAudioFocus();
                reanudarAlRecuperarFoco = false;
                MainActivity.enviarAccionRemotaAWebView("play", 0);
            } else if (ACCION_PAUSE.equals(accion)) {
                reanudarAlRecuperarFoco = false;
                MainActivity.enviarAccionRemotaAWebView("pause", 0);
            } else if (ACCION_NEXT.equals(accion)) {
                solicitarAudioFocus();
                MainActivity.enviarAccionRemotaAWebView("next", 0);
            } else if (ACCION_PREV.equals(accion)) {
                solicitarAudioFocus();
                MainActivity.enviarAccionRemotaAWebView("previous", 0);
            } else if (ACCION_STOP.equals(accion)) {
                reanudarAlRecuperarFoco = false;
                detenerReproduccion();
            }
        }
        return START_NOT_STICKY;
    }

    /**
     * Actualiza el estado multimedia y refresca la notificación interactiva
     */
    public void actualizarEstado(
            String titulo,
            String artista,
            int duracionSecs,
            int posicionSecs,
            boolean reproduciendo,
            String urlOCaratulaBase64
    ) {
        this.tituloActual = (titulo != null && !titulo.isEmpty()) ? titulo : "Canción";
        this.artistaActual = (artista != null && !artista.isEmpty()) ? artista : "App Música";
        this.duracionActualMs = duracionSecs > 0 ? duracionSecs * 1000L : 0;
        this.posicionActualMs = posicionSecs >= 0 ? posicionSecs * 1000L : 0;
        this.estaReproduciendo = reproduciendo;

        // Solicitar AudioFocus y mantener WakeLock mientras se reproduce música
        if (reproduciendo) {
            solicitarAudioFocus();
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(4 * 60 * 60 * 1000L); // Hasta 4 horas de respaldo
            }
        } else {
            if (wakeLock != null && wakeLock.isHeld()) {
                try {
                    wakeLock.release();
                } catch (Exception ignored) {}
            }
        }

        if (mediaSession != null && !mediaSession.isActive()) {
            mediaSession.setActive(true);
        }

        // Descarga o decodificación asíncrona de carátula
        procesarCaratulaAsync(urlOCaratulaBase64);

        // Actualizar PlaybackState en la MediaSession con acciones completas para Bluetooth y Lockscreen
        long acciones = PlaybackState.ACTION_PLAY |
                PlaybackState.ACTION_PAUSE |
                PlaybackState.ACTION_PLAY_PAUSE |
                PlaybackState.ACTION_SKIP_TO_NEXT |
                PlaybackState.ACTION_SKIP_TO_PREVIOUS |
                PlaybackState.ACTION_SEEK_TO |
                PlaybackState.ACTION_STOP;

        PlaybackState state = new PlaybackState.Builder()
                .setActions(acciones)
                .setState(
                        reproduciendo ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        this.posicionActualMs,
                        reproduciendo ? 1.0f : 0.0f
                )
                .build();
        mediaSession.setPlaybackState(state);

        // Actualizar Metadatos en la MediaSession
        actualizarMetadatosSession();

        // Construir y emitir Notificación Foreground MediaStyle
        Notification notificacion = construirNotificacionMediaStyle();

        try {
            startForeground(NOTIFICACION_ID, notificacion);
        } catch (Exception e) {
            Log.w(TAG, "Aviso startForeground: " + e.getMessage());
            if (notificationManager != null) {
                notificationManager.notify(NOTIFICACION_ID, notificacion);
            }
        }
    }

    private void actualizarMetadatosSession() {
        MediaMetadata.Builder builder = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, tituloActual)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artistaActual)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, duracionActualMs);

        if (bitmapCaratulaActual != null) {
            builder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, bitmapCaratulaActual);
            builder.putBitmap(MediaMetadata.METADATA_KEY_ART, bitmapCaratulaActual);
        }

        mediaSession.setMetadata(builder.build());
    }

    private void procesarCaratulaAsync(String urlOCaratula) {
        if (urlOCaratula == null || urlOCaratula.isEmpty()) {
            bitmapCaratulaActual = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
            ultimaUrlCaratula = null;
            return;
        }

        if (urlOCaratula.equals(ultimaUrlCaratula) && bitmapCaratulaActual != null) {
            return;
        }

        ultimaUrlCaratula = urlOCaratula;

        new Thread(() -> {
            Bitmap bmp = null;
            try {
                if (urlOCaratula.startsWith("data:image")) {
                    int coma = urlOCaratula.indexOf(",");
                    String b64 = coma != -1 ? urlOCaratula.substring(coma + 1) : urlOCaratula;
                    byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
                    bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                } else if (urlOCaratula.startsWith("http://") || urlOCaratula.startsWith("https://")) {
                    URL url = new URL(urlOCaratula);
                    HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                    conn.setConnectTimeout(5000);
                    conn.setReadTimeout(5000);
                    conn.setDoInput(true);
                    conn.connect();
                    InputStream input = conn.getInputStream();
                    bmp = BitmapFactory.decodeStream(input);
                    input.close();
                }
            } catch (Exception e) {
                Log.d(TAG, "No se pudo cargar imagen de carátula: " + e.getMessage());
            }

            if (bmp == null) {
                try {
                    bmp = BitmapFactory.decodeResource(getResources(), R.mipmap.ic_launcher);
                } catch (Exception ignored) {}
            }

            if (bmp != null) {
                bitmapCaratulaActual = bmp;
                actualizarMetadatosSession();
                Notification notif = construirNotificacionMediaStyle();
                if (notificationManager != null) {
                    notificationManager.notify(NOTIFICACION_ID, notif);
                }
            }
        }).start();
    }

    private Notification construirNotificacionMediaStyle() {
        Intent intentAbrirApp = new Intent(this, MainActivity.class);
        intentAbrirApp.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent piAbrirApp = PendingIntent.getActivity(
                this,
                0,
                intentAbrirApp,
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        PendingIntent piPrev = PendingIntent.getService(
                this, 1, new Intent(this, MediaPlaybackService.class).setAction(ACCION_PREV),
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        String accionPlayPause = estaReproduciendo ? ACCION_PAUSE : ACCION_PLAY;
        PendingIntent piPlayPause = PendingIntent.getService(
                this, 2, new Intent(this, MediaPlaybackService.class).setAction(accionPlayPause),
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        PendingIntent piNext = PendingIntent.getService(
                this, 3, new Intent(this, MediaPlaybackService.class).setAction(ACCION_NEXT),
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
        );

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            builder = new Notification.Builder(this, CANAL_ID);
        } else {
            builder = new Notification.Builder(this);
        }

        int iconoPlayPause = estaReproduciendo ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;

        builder.setContentTitle(tituloActual)
                .setContentText(artistaActual)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(piAbrirApp)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(estaReproduciendo);

        if (bitmapCaratulaActual != null) {
            builder.setLargeIcon(bitmapCaratulaActual);
        }

        // Acciones: [0: Anterior, 1: Play/Pausa, 2: Siguiente]
        Notification.Action actPrev = new Notification.Action.Builder(
                Icon.createWithResource(this, android.R.drawable.ic_media_previous),
                "Anterior",
                piPrev
        ).build();

        Notification.Action actPlayPause = new Notification.Action.Builder(
                Icon.createWithResource(this, iconoPlayPause),
                estaReproduciendo ? "Pausar" : "Reproducir",
                piPlayPause
        ).build();

        Notification.Action actNext = new Notification.Action.Builder(
                Icon.createWithResource(this, android.R.drawable.ic_media_next),
                "Siguiente",
                piNext
        ).build();

        builder.addAction(actPrev);
        builder.addAction(actPlayPause);
        builder.addAction(actNext);

        // Estilo MediaStyle nativo (muestra los 3 botones en la tarjeta compacta)
        Notification.MediaStyle mediaStyle = new Notification.MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2);

        builder.setStyle(mediaStyle);

        return builder.build();
    }

    public void detenerReproduccion() {
        estaReproduciendo = false;
        abandonarAudioFocus();
        if (wakeLock != null && wakeLock.isHeld()) {
            try {
                wakeLock.release();
            } catch (Exception ignored) {}
        }
        if (mediaSession != null) {
            mediaSession.setActive(false);
        }
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        detenerReproduccion();
        if (mediaSession != null) {
            mediaSession.release();
        }
        super.onDestroy();
    }
}
