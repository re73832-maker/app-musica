package com.musica.app;

import android.Manifest;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.IBinder;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    public static MainActivity instanciaActiva = null;
    private MediaPlaybackService mediaService = null;
    private boolean servicioEnlazado = false;

    private boolean tieneActualizacionPendiente = false;
    private String pendingTitulo = "";
    private String pendingArtista = "";
    private int pendingDuracionSecs = 0;
    private int pendingPosicionSecs = 0;
    private boolean pendingReproduciendo = false;
    private String pendingCaratulaUrl = "";

    private final ServiceConnection serviceConnection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder service) {
            MediaPlaybackService.LocalBinder binder = (MediaPlaybackService.LocalBinder) service;
            mediaService = binder.getService();
            servicioEnlazado = true;
            if (tieneActualizacionPendiente && mediaService != null) {
                tieneActualizacionPendiente = false;
                mediaService.actualizarEstado(
                        pendingTitulo,
                        pendingArtista,
                        pendingDuracionSecs,
                        pendingPosicionSecs,
                        pendingReproduciendo,
                        pendingCaratulaUrl
                );
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            mediaService = null;
            servicioEnlazado = false;
        }
    };

    private void registrarPuenteAlmacenamiento() {
        try {
            if (this.getBridge() != null) {
                WebView webView = this.getBridge().getWebView();
                if (webView != null) {
                    webView.addJavascriptInterface(new AppMusicaStorageBridge(this), "AndroidAppMusica");
                }
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public void iniciarYVincularServicioMedia() {
        try {
            Intent intent = new Intent(this, MediaPlaybackService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(intent);
            } else {
                startService(intent);
            }
            bindService(intent, serviceConnection, Context.BIND_AUTO_CREATE);
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public void actualizarNotificacionMedia(
            String titulo,
            String artista,
            int duracionSecs,
            int posicionSecs,
            boolean reproduciendo,
            String caratulaUrl
    ) {
        runOnUiThread(() -> {
            if (mediaService != null && servicioEnlazado) {
                tieneActualizacionPendiente = false;
                mediaService.actualizarEstado(titulo, artista, duracionSecs, posicionSecs, reproduciendo, caratulaUrl);
            } else {
                pendingTitulo = titulo;
                pendingArtista = artista;
                pendingDuracionSecs = duracionSecs;
                pendingPosicionSecs = posicionSecs;
                pendingReproduciendo = reproduciendo;
                pendingCaratulaUrl = caratulaUrl;
                tieneActualizacionPendiente = true;
                iniciarYVincularServicioMedia();
            }
        });
    }

    public void detenerNotificacionMedia() {
        runOnUiThread(() -> {
            tieneActualizacionPendiente = false;
            if (mediaService != null) {
                mediaService.detenerReproduccion();
            }
        });
    }

    public static void enviarAccionRemotaAWebView(String accion, long valor) {
        if (instanciaActiva != null && instanciaActiva.getBridge() != null) {
            WebView webView = instanciaActiva.getBridge().getWebView();
            if (webView != null) {
                webView.post(() -> {
                    String js;
                    if ("duck".equals(accion)) {
                        js = "(function(){ try { var d = window.__duckFactor || 0.25; window.__preDuckVolumes = window.__preDuckVolumes || new Map(); document.querySelectorAll('audio').forEach(function(a){ if(!window.__preDuckVolumes.has(a)) window.__preDuckVolumes.set(a, a.volume); a.volume = Math.max(0.05, a.volume * d); }); if (window.despacharAccionRemota) window.despacharAccionRemota('duck', " + valor + "); } catch(e){} })();";
                    } else if ("unduck".equals(accion)) {
                        js = "(function(){ try { document.querySelectorAll('audio').forEach(function(a){ if(window.__preDuckVolumes && window.__preDuckVolumes.has(a)) { a.volume = window.__preDuckVolumes.get(a); window.__preDuckVolumes.delete(a); } }); if (window.despacharAccionRemota) window.despacharAccionRemota('unduck', " + valor + "); } catch(e){} })();";
                    } else {
                        js = "window.despacharAccionRemota && window.despacharAccionRemota('" + accion + "', " + valor + ");";
                    }
                    webView.evaluateJavascript(js, null);
                });
            }
        }
    }

    private void solicitarPermisosNotificacion() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 101);
            }
        }
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        instanciaActiva = this;
        registrarPuenteAlmacenamiento();
        solicitarPermisosNotificacion();
        iniciarYVincularServicioMedia();
    }

    @Override
    public void onResume() {
        super.onResume();
        instanciaActiva = this;
        registrarPuenteAlmacenamiento();
    }

    @Override
    public void onDestroy() {
        if (servicioEnlazado) {
            try {
                unbindService(serviceConnection);
            } catch (Exception ignored) {}
            servicioEnlazado = false;
        }
        if (instanciaActiva == this) {
            instanciaActiva = null;
        }
        super.onDestroy();
    }
}
