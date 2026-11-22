/**
 * Módulo de Almacenamiento Permanente en Almacenamiento Público de Android
 * + Optimización de Memoria RAM con Protección de URLs Activas (5000ms Delay Seguro)
 * 
 * Permite que las canciones descargadas se guarden físicamente en la carpeta
 * pública /Music/AppMusica del teléfono.
 * 
 * VITAL: Los archivos en esta carpeta NO SE ELIMINAN cuando:
 * 1. El usuario desinstala la aplicación o la reinstala.
 * 2. Se actualiza la aplicación OTA o por nuevo APK.
 * 3. Se limpian los datos / caché de la app desde los Ajustes de Android.
 */

export interface CancionAlmacenadaNativa {
  nombre: string;
  archivo: string;
  tamano: number;
  duracion: number;
  ruta?: string;
  artista?: string;
  fechaModificado?: number;
}

// Interfaz para el puente inyectado en el WebView de Android
interface AndroidAppMusicaBridge {
  guardarCancion(nombre: string, base64Data: string, artista: string, duracionSegundos: number): string;
  existeCancion(nombre: string): boolean;
  listarCanciones(): string;
  leerCancionBase64(nombreOArchivo: string): string;
  guardarRespaldoJSON(jsonStr: string): boolean;
  leerRespaldoJSON(): string;
  obtenerRutaCarpetaMusica(): string;
  actualizarNotificacion(
    titulo: string,
    artista: string,
    duracionSecs: number,
    posicionSecs: number,
    reproduciendo: boolean,
    caratulaUrl: string
  ): void;
  actualizarNotificacionMultimedia?(
    titulo: string,
    artista: string,
    caratulaUrl: string,
    reproduciendo: boolean,
    duracionMs: number,
    posicionMs: number
  ): void;
  detenerNotificacion(): void;
  detenerNotificacionMultimedia?(): void;
}

declare global {
  interface Window {
    AndroidAppMusica?: AndroidAppMusicaBridge;
    despacharAccionRemota?: (accion: string, valor: number) => void;
  }
}

// Caché ligera en memoria para evitar llamadas JNI repetitivas sobre archivos ya verificados
const cacheCancionesFisicas = new Set<string>();

// Registro de callback opcional para verificar qué ObjectURLs siguen en uso en los Decks activos
let validadorUrlActivaCallback: ((url: string) => boolean) | null = null;

export function registrarValidadorUrlActiva(fn: (url: string) => boolean): void {
  validadorUrlActivaCallback = fn;
}

function normalizarClaveFisica(nombre: string): string {
  return (nombre || '').trim().toLowerCase();
}

/**
 * Determina si la aplicación se está ejecutando dentro del contenedor APK
 * con acceso al almacenamiento público del teléfono.
 */
export function esAlmacenamientoNativoDisponible(): boolean {
  return typeof window !== 'undefined' && Boolean(window.AndroidAppMusica);
}

/**
 * Revoca de forma segura un ObjectURL tras 5000ms (5 segundos), verificando antes de revocar
 * que la URL NO sea la misma que está cargada actualmente en el Deck activo o en precarga.
 */
export function revocarUrlObjetoSegura(url: string | null | undefined, delayMs: number = 5000): void {
  if (!url || !url.startsWith('blob:')) return;
  const tiempoEspera = Math.max(5000, delayMs);

  setTimeout(() => {
    try {
      // Verificar que la URL no esté siendo usada por ningún Deck activo antes de revocarla
      if (validadorUrlActivaCallback && validadorUrlActivaCallback(url)) {
        return;
      }
      URL.revokeObjectURL(url);
    } catch (_) {}
  }, tiempoEspera);
}

/**
 * Convierte un Blob de audio a una cadena Base64
 */
export function blobABase64Audio(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const resultado = reader.result as string;
      resolve(resultado);
    };
    reader.onerror = (e) => reject(e);
    reader.readAsDataURL(blob);
  });
}

/**
 * Convierte una cadena Data URL (data:audio/...;base64,...) de regreso a Blob
 * optimizando la reserva de memoria en un único ArrayBuffer sin clonar arreglos intermedios.
 */
export function dataUrlABlobAudio(dataUrl: string): Blob {
  const comaIdx = dataUrl.indexOf(',');
  const header = comaIdx !== -1 ? dataUrl.slice(0, comaIdx) : '';
  const base64Body = comaIdx !== -1 ? dataUrl.slice(comaIdx + 1) : dataUrl;
  const mime = header.match(/:(.*?);/)?.[1] || 'audio/mpeg';
  const bstr = atob(base64Body);
  const len = bstr.length;
  const u8arr = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    u8arr[i] = bstr.charCodeAt(i);
  }
  return new Blob([u8arr.buffer], { type: mime });
}

/**
 * Guarda físicamente un archivo .mp3 en /Music/AppMusica del teléfono.
 * Inmune a la desinstalación de la app.
 */
export async function blindarCancionEnMemoriaFisica(
  cancion: { nombre: string; artista?: string; duracion?: number },
  blobAudio: Blob
): Promise<{ ok: boolean; ruta?: string; error?: string }> {
  if (!esAlmacenamientoNativoDisponible() || !window.AndroidAppMusica) {
    return { ok: false, error: 'Entorno no nativo' };
  }

  try {
    const base64 = await blobABase64Audio(blobAudio);
    const res = window.AndroidAppMusica.guardarCancion(
      cancion.nombre,
      base64,
      cancion.artista || '',
      Math.round(cancion.duracion || 0)
    );

    if (res && res.startsWith('OK:')) {
      const ruta = res.substring(3);
      cacheCancionesFisicas.add(normalizarClaveFisica(cancion.nombre));
      return { ok: true, ruta };
    }

    return { ok: false, error: res };
  } catch (err: any) {
    console.error('[PersistentStorage]: Error al blindar canción física:', err);
    return { ok: false, error: err?.message || String(err) };
  }
}

/**
 * Verifica si una canción ya se encuentra guardada en /Music/AppMusica/
 * usando caché en memoria para 0 latencia JNI en consultas repetidas.
 */
export function estaCancionEnMemoriaFisica(nombre: string): boolean {
  if (!esAlmacenamientoNativoDisponible() || !window.AndroidAppMusica) return false;
  const clave = normalizarClaveFisica(nombre);
  if (cacheCancionesFisicas.has(clave)) return true;

  try {
    const existe = window.AndroidAppMusica.existeCancion(nombre);
    if (existe) {
      cacheCancionesFisicas.add(clave);
    }
    return existe;
  } catch (_) {
    return false;
  }
}

/**
 * Lista todas las canciones encontradas en /Music/AppMusica/ del dispositivo.
 */
export function obtenerCancionesEnMemoriaFisica(): CancionAlmacenadaNativa[] {
  if (!esAlmacenamientoNativoDisponible() || !window.AndroidAppMusica) return [];
  try {
    const raw = window.AndroidAppMusica.listarCanciones();
    if (!raw) return [];
    const lista = JSON.parse(raw);
    if (Array.isArray(lista)) {
      for (const item of lista) {
        if (item?.nombre) {
          cacheCancionesFisicas.add(normalizarClaveFisica(item.nombre));
        }
      }
      return lista;
    }
    return [];
  } catch (err) {
    console.error('[PersistentStorage]: Error leyendo canciones del teléfono:', err);
    return [];
  }
}

/**
 * Lee el archivo de audio desde /Music/AppMusica/ y lo entrega como Blob.
 */
export function recuperarBlobCancionDesdeMemoriaFisica(nombreOArchivo: string): Blob | null {
  if (!esAlmacenamientoNativoDisponible() || !window.AndroidAppMusica) return null;
  try {
    const dataUrl = window.AndroidAppMusica.leerCancionBase64(nombreOArchivo);
    if (!dataUrl || dataUrl.startsWith('ERROR:')) return null;
    cacheCancionesFisicas.add(normalizarClaveFisica(nombreOArchivo));
    return dataUrlABlobAudio(dataUrl);
  } catch (err) {
    console.error('[PersistentStorage]: Error recuperando audio físico:', err);
    return null;
  }
}

/**
 * Guarda el catálogo de metadatos (JSON) en la carpeta física de música.
 */
export function guardarRespaldoEnMemoriaFisica(datos: any): boolean {
  if (!esAlmacenamientoNativoDisponible() || !window.AndroidAppMusica) return false;
  try {
    const jsonStr = JSON.stringify(datos, null, 2);
    return window.AndroidAppMusica.guardarRespaldoJSON(jsonStr);
  } catch (err) {
    console.error('[PersistentStorage]: Error guardando respaldo JSON nativo:', err);
    return false;
  }
}

/**
 * Recupera el catálogo de metadatos (JSON) guardado previamente en el teléfono.
 */
export function leerRespaldoDeMemoriaFisica(): any | null {
  if (!esAlmacenamientoNativoDisponible() || !window.AndroidAppMusica) return null;
  try {
    const raw = window.AndroidAppMusica.leerRespaldoJSON();
    if (!raw || raw.trim().length === 0) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('[PersistentStorage]: Error leyendo respaldo JSON nativo:', err);
    return null;
  }
}

/**
 * Retorna la ruta física de la carpeta de música en el teléfono
 */
export function obtenerRutaCarpetaMusicaFisica(): string {
  if (!esAlmacenamientoNativoDisponible() || !window.AndroidAppMusica) return '/Music/AppMusica';
  try {
    return window.AndroidAppMusica.obtenerRutaCarpetaMusica();
  } catch (_) {
    return '/Music/AppMusica';
  }
}

/**
 * Actualiza la tarjeta interactiva de control multimedia del sistema
 * (notificación estilo Spotify en Quick Settings y pantalla de bloqueo)
 * y mantiene activo el servicio para evitar que Android Doze mode suspenda el audio.
 */
export function actualizarNotificacionNativa(
  titulo: string,
  artista: string,
  duracionSecs: number,
  posicionSecs: number,
  reproduciendo: boolean,
  caratulaUrl?: string
): void {
  if (typeof window === 'undefined' || !window.AndroidAppMusica) return;
  try {
    if (typeof window.AndroidAppMusica.actualizarNotificacionMultimedia === 'function') {
      window.AndroidAppMusica.actualizarNotificacionMultimedia(
        titulo,
        artista,
        caratulaUrl || '',
        reproduciendo,
        Math.round((duracionSecs || 0) * 1000),
        Math.round((posicionSecs || 0) * 1000)
      );
    } else if (typeof window.AndroidAppMusica.actualizarNotificacion === 'function') {
      window.AndroidAppMusica.actualizarNotificacion(
        titulo,
        artista,
        Math.round(duracionSecs || 0),
        Math.round(posicionSecs || 0),
        reproduciendo,
        caratulaUrl || ''
      );
    }
  } catch (e) {
    console.warn('[PersistentStorage]: Error actualizando notificación nativa:', e);
  }
}

/**
 * Detiene la notificación multimedia y apaga el Foreground Service
 */
export function detenerNotificacionNativa(): void {
  if (typeof window === 'undefined' || !window.AndroidAppMusica) return;
  try {
    if (typeof window.AndroidAppMusica.detenerNotificacionMultimedia === 'function') {
      window.AndroidAppMusica.detenerNotificacionMultimedia();
    } else if (typeof window.AndroidAppMusica.detenerNotificacion === 'function') {
      window.AndroidAppMusica.detenerNotificacion();
    }
  } catch (_) {}
}
