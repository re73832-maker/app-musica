package com.musica.app;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.media.MediaMetadataRetriever;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Puente Nativo Android <-> Web para Almacenamiento Permanente en Almacenamiento Público.
 * 
 * PROPÓSITO CRÍTICO:
 * Los archivos guardados en Environment.DIRECTORY_MUSIC ("Music/AppMusica")
 * NUNCA se eliminan cuando el usuario desinstala la aplicación, la actualiza,
 * o limpia datos de la aplicación. Esto garantiza inmunidad total contra
 * pérdida de canciones.
 */
public class AppMusicaStorageBridge {

    private static final String TAG = "AppMusicaBridge";
    private static final String SUBDIRECTORIO_MUSICA = "AppMusica";
    private static final String NOMBRE_RESPALDO_JSON = "respaldo_biblioteca_appmusica.json";

    private final Context context;

    public AppMusicaStorageBridge(Context context) {
        this.context = context.getApplicationContext();
        asegurarDirectorioMusica();
    }

    /**
     * Obtiene la carpeta física pública /storage/emulated/0/Music/AppMusica
     */
    private File obtenerCarpetaMusicaPublica() {
        File musicDir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_MUSIC);
        File appMusicaDir = new File(musicDir, SUBDIRECTORIO_MUSICA);
        if (!appMusicaDir.exists()) {
            appMusicaDir.mkdirs();
        }
        return appMusicaDir;
    }

    private void asegurarDirectorioMusica() {
        try {
            File dir = obtenerCarpetaMusicaPublica();
            if (!dir.exists()) {
                dir.mkdirs();
            }
        } catch (Exception e) {
            Log.w(TAG, "No se pudo crear carpeta pública de música: " + e.getMessage());
        }
    }

    private String limpiarNombreArchivo(String nombre) {
        if (nombre == null || nombre.trim().isEmpty()) {
            return "audio_" + System.currentTimeMillis();
        }
        return nombre.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
    }

    /**
     * Guarda una canción como archivo físico permanente .mp3 en /Music/AppMusica/
     * Inmune a desinstalación de la app.
     */
    @JavascriptInterface
    public String guardarCancion(String nombre, String base64Data, String artista, int duracionSegundos) {
        if (nombre == null || base64Data == null || base64Data.isEmpty()) {
            return "ERROR: Datos inválidos";
        }

        try {
            // Limpiar prefijo data:audio/...;base64, si viene incluido
            String datosLimpios = base64Data;
            int comaIndex = base64Data.indexOf(",");
            if (comaIndex != -1 && comaIndex < 60) {
                datosLimpios = base64Data.substring(comaIndex + 1);
            }

            byte[] bytesAudio = Base64.decode(datosLimpios, Base64.DEFAULT);
            if (bytesAudio == null || bytesAudio.length < 50000) {
                return "ERROR: Archivo de audio demasiado pequeño o dañado (" + (bytesAudio != null ? bytesAudio.length : 0) + " bytes)";
            }

            String nombreLimpio = limpiarNombreArchivo(nombre);
            String nombreArchivoFinal = nombreLimpio.toLowerCase().endsWith(".mp3") ? nombreLimpio : nombreLimpio + ".mp3";

            // 1. Escritura directa en archivo público /Music/AppMusica/<nombre>.mp3
            File carpeta = obtenerCarpetaMusicaPublica();
            File archivoDestino = new File(carpeta, nombreArchivoFinal);

            FileOutputStream fos = new FileOutputStream(archivoDestino);
            fos.write(bytesAudio);
            fos.flush();
            fos.close();

            // 2. Notificar al escáner de medios de Android para que aparezca en el sistema
            MediaScannerConnection.scanFile(
                    context,
                    new String[]{archivoDestino.getAbsolutePath()},
                    new String[]{"audio/mpeg"},
                    null
            );

            // 3. En Android 10+ (API 29+), asegurar inserción en MediaStore si aplica
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                try {
                    ContentResolver resolver = context.getContentResolver();
                    ContentValues values = new ContentValues();
                    values.put(MediaStore.Audio.Media.DISPLAY_NAME, nombreArchivoFinal);
                    values.put(MediaStore.Audio.Media.TITLE, nombreLimpio);
                    if (artista != null && !artista.isEmpty()) {
                        values.put(MediaStore.Audio.Media.ARTIST, artista);
                    }
                    if (duracionSegundos > 0) {
                        values.put(MediaStore.Audio.Media.DURATION, duracionSegundos * 1000L);
                    }
                    values.put(MediaStore.Audio.Media.MIME_TYPE, "audio/mpeg");
                    values.put(MediaStore.Audio.Media.RELATIVE_PATH, Environment.DIRECTORY_MUSIC + "/" + SUBDIRECTORIO_MUSICA);

                    Uri uri = resolver.insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values);
                    if (uri != null) {
                        OutputStream os = resolver.openOutputStream(uri);
                        if (os != null) {
                            os.write(bytesAudio);
                            os.flush();
                            os.close();
                        }
                    }
                } catch (Exception eMediaStore) {
                    // Fallback a archivo físico exitoso
                    Log.d(TAG, "MediaStore insert aviso: " + eMediaStore.getMessage());
                }
            }

            Log.i(TAG, "✓ Canción blindada en almacenamiento permanente: " + archivoDestino.getAbsolutePath() + " (" + bytesAudio.length + " bytes)");
            return "OK:" + archivoDestino.getAbsolutePath();
        } catch (Exception e) {
            Log.e(TAG, "Error guardando canción permanente:", e);
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Verifica si una canción ya existe físicamente en /Music/AppMusica/
     */
    @JavascriptInterface
    public boolean existeCancion(String nombre) {
        try {
            String nombreLimpio = limpiarNombreArchivo(nombre);
            String conExt = nombreLimpio.toLowerCase().endsWith(".mp3") ? nombreLimpio : nombreLimpio + ".mp3";
            File f = new File(obtenerCarpetaMusicaPublica(), conExt);
            return f.exists() && f.length() >= 50000;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * Lista todas las canciones guardadas en /Music/AppMusica/
     * Retorna un JSON plano con metadatos: [{nombre, archivo, tamano, duracion, ruta}]
     */
    @JavascriptInterface
    public String listarCanciones() {
        JSONArray listaJson = new JSONArray();
        try {
            File carpeta = obtenerCarpetaMusicaPublica();
            File[] archivos = carpeta.listFiles();

            if (archivos != null) {
                MediaMetadataRetriever mmr = new MediaMetadataRetriever();

                for (File f : archivos) {
                    if (f.isFile() && f.length() >= 50000) {
                        String nombreArchivo = f.getName();
                        String lower = nombreArchivo.toLowerCase();

                        if (lower.endsWith(".mp3") || lower.endsWith(".m4a") || lower.endsWith(".wav") || lower.endsWith(".flac") || lower.endsWith(".aac")) {
                            JSONObject obj = new JSONObject();
                            String titulo = nombreArchivo.replaceAll("\\.[^.]+$", "");
                            obj.put("nombre", titulo);
                            obj.put("archivo", nombreArchivo);
                            obj.put("tamano", f.length());
                            obj.put("ruta", f.getAbsolutePath());
                            obj.put("fechaModificado", f.lastModified());

                            // Intentar extraer metadatos de audio
                            long duracionSegs = 0;
                            String artista = "";
                            try {
                                mmr.setDataSource(f.getAbsolutePath());
                                String durStr = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                                if (durStr != null) {
                                    duracionSegs = Math.round(Long.parseLong(durStr) / 1000.0);
                                }
                                artista = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_ARTIST);
                            } catch (Exception ignored) {}

                            obj.put("duracion", duracionSegs);
                            obj.put("artista", artista != null ? artista : "");
                            listaJson.put(obj);
                        }
                    }
                }

                try {
                    mmr.release();
                } catch (Exception ignored) {}
            }
        } catch (Exception e) {
            Log.e(TAG, "Error listando canciones permanentes:", e);
        }

        return listaJson.toString();
    }

    /**
     * Lee una canción como Base64 desde /Music/AppMusica/
     */
    @JavascriptInterface
    public String leerCancionBase64(String nombreOArchivo) {
        try {
            String nombreLimpio = limpiarNombreArchivo(nombreOArchivo);
            String conExt = nombreLimpio.toLowerCase().endsWith(".mp3") ? nombreLimpio : nombreLimpio + ".mp3";
            File f = new File(obtenerCarpetaMusicaPublica(), conExt);

            if (!f.exists()) {
                f = new File(obtenerCarpetaMusicaPublica(), nombreOArchivo);
            }

            if (!f.exists() || f.length() < 50000) {
                return "ERROR: Archivo no encontrado";
            }

            int tamano = (int) f.length();
            byte[] bytes = new byte[tamano];
            FileInputStream fis = new FileInputStream(f);
            int leidos = 0;
            while (leidos < tamano) {
                int r = fis.read(bytes, leidos, tamano - leidos);
                if (r == -1) break;
                leidos += r;
            }
            fis.close();

            String b64 = Base64.encodeToString(bytes, Base64.NO_WRAP);
            return "data:audio/mpeg;base64," + b64;
        } catch (Exception e) {
            Log.e(TAG, "Error leyendo canción base64:", e);
            return "ERROR: " + e.getMessage();
        }
    }

    /**
     * Guarda el archivo de respaldo general de listas y metadatos en /Music/AppMusica/respaldo_biblioteca_appmusica.json
     */
    @JavascriptInterface
    public boolean guardarRespaldoJSON(String jsonStr) {
        try {
            File carpeta = obtenerCarpetaMusicaPublica();
            File archivoRespaldo = new File(carpeta, NOMBRE_RESPALDO_JSON);
            FileOutputStream fos = new FileOutputStream(archivoRespaldo);
            fos.write(jsonStr.getBytes("UTF-8"));
            fos.flush();
            fos.close();
            Log.i(TAG, "✓ Respaldo JSON guardado en " + archivoRespaldo.getAbsolutePath());
            return true;
        } catch (Exception e) {
            Log.e(TAG, "Error guardando respaldo JSON:", e);
            return false;
        }
    }

    /**
     * Lee el archivo de respaldo general de /Music/AppMusica/respaldo_biblioteca_appmusica.json
     */
    @JavascriptInterface
    public String leerRespaldoJSON() {
        try {
            File carpeta = obtenerCarpetaMusicaPublica();
            File archivoRespaldo = new File(carpeta, NOMBRE_RESPALDO_JSON);
            if (!archivoRespaldo.exists()) {
                return "";
            }
            FileInputStream fis = new FileInputStream(archivoRespaldo);
            byte[] bytes = new byte[(int) archivoRespaldo.length()];
            fis.read(bytes);
            fis.close();
            return new String(bytes, "UTF-8");
        } catch (Exception e) {
            Log.e(TAG, "Error leyendo respaldo JSON:", e);
            return "";
        }
    }

    /**
     * Retorna la ruta física de la carpeta pública de música
     */
    @JavascriptInterface
    public String obtenerRutaCarpetaMusica() {
        return obtenerCarpetaMusicaPublica().getAbsolutePath();
    }

    /**
     * Actualiza la notificación multimedia nativa del sistema (estilo Spotify en Quick Settings y Lock Screen)
     * y mantiene activo el servicio en primer plano para evitar que Doze Mode pause la música.
     */
    @JavascriptInterface
    public void actualizarNotificacion(
            String titulo,
            String artista,
            int duracionSecs,
            int posicionSecs,
            boolean reproduciendo,
            String caratulaUrl
    ) {
        if (MainActivity.instanciaActiva != null) {
            MainActivity.instanciaActiva.actualizarNotificacionMedia(
                    titulo,
                    artista,
                    duracionSecs,
                    posicionSecs,
                    reproduciendo,
                    caratulaUrl
            );
        }
    }

    /**
     * Alias bidireccional con firma en milisegundos para la tarjeta MediaStyle y controles AVRCP
     */
    @JavascriptInterface
    public void actualizarNotificacionMultimedia(
            String titulo,
            String artista,
            String caratulaUrl,
            boolean reproduciendo,
            long duracionMs,
            long posicionMs
    ) {
        if (MainActivity.instanciaActiva != null) {
            int durSecs = duracionMs > 0 ? (int) Math.round(duracionMs / 1000.0) : 0;
            int posSecs = posicionMs >= 0 ? (int) Math.round(posicionMs / 1000.0) : 0;
            MainActivity.instanciaActiva.actualizarNotificacionMedia(
                    titulo,
                    artista,
                    durSecs,
                    posSecs,
                    reproduciendo,
                    caratulaUrl
            );
        }
    }

    /**
     * Detiene la notificación multimedia y libera el WakeLock
     */
    @JavascriptInterface
    public void detenerNotificacion() {
        if (MainActivity.instanciaActiva != null) {
            MainActivity.instanciaActiva.detenerNotificacionMedia();
        }
    }

    /**
     * Alias para detener la notificación multimedia nativa
     */
    @JavascriptInterface
    public void detenerNotificacionMultimedia() {
        detenerNotificacion();
    }
}
