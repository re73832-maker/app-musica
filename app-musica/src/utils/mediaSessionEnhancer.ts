/**
 * Extensión Segura para MediaSession API
 * Añade soporte para scrubber/seekto y sincronización de estado de reproducción
 * sin interferir ni sobreescribir los handlers existentes (play, pause, next, prev).
 */

export interface SeekToHandlerOptions {
  /** Callback ejecutado cuando el usuario interactúa con la barra en pantalla de bloqueo/notificación */
  onSeek: (segundos: number) => void;
  /** Función opcional para consultar la duración actual máxima */
  getDuration?: () => number;
}

let ultimoSyncTimestamp = 0;

/**
 * Registra de forma aislada y segura el handler 'seekto' en navigator.mediaSession.
 * Permite al usuario arrastrar la barra de reproducción desde la pantalla de bloqueo
 * o barra de notificaciones del sistema operativo sin afectar los otros controles.
 * 
 * @returns Función de desuscripción limpia
 */
export function registrarMediaSessionSeekTo(options: SeekToHandlerOptions): () => void {
  if (typeof window === 'undefined' || !('mediaSession' in navigator)) {
    return () => {};
  }

  const { onSeek, getDuration } = options;

  try {
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime === undefined || isNaN(details.seekTime)) return;

      const duracionMaxima = getDuration ? getDuration() : Infinity;
      const tiempoValido = Math.max(0, Math.min(details.seekTime, duracionMaxima));

      onSeek(tiempoValido);
    });

    console.log('[MediaSessionEnhancer]: Handler "seekto" registrado exitosamente.');
  } catch (err) {
    console.warn('[MediaSessionEnhancer]: El navegador no soporta el evento "seekto":', err);
  }

  return () => {
    try {
      if ('mediaSession' in navigator) {
        navigator.mediaSession.setActionHandler('seekto', null);
      }
    } catch (_) {}
  };
}

/**
 * Actualiza la posición y barra de progreso en la notificación del sistema.
 * Aplica throttling estricto de 2 segundos para evitar saturación del IPC de WebView en Android.
 */
export function sincronizarMediaSessionPosition(
  duracion: number,
  posicion: number,
  velocidad: number = 1,
  forzar: boolean = false
): boolean {
  if (
    typeof window === 'undefined' ||
    !duracion ||
    !isFinite(duracion) ||
    duracion <= 0 ||
    isNaN(duracion) ||
    isNaN(posicion) ||
    !isFinite(posicion) ||
    posicion < 0
  ) {
    return false;
  }

  const ahora = Date.now();
  if (!forzar && ahora - ultimoSyncTimestamp < 1500) {
    return false;
  }
  ultimoSyncTimestamp = ahora;

  const position = Math.max(0, Math.min(posicion, duracion));
  const duration = Math.max(0.1, duracion);

  if (
    'mediaSession' in navigator &&
    'setPositionState' in navigator.mediaSession &&
    typeof navigator.mediaSession.setPositionState === 'function' &&
    duration > 0 &&
    position <= duration
  ) {
    try {
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate: velocidad > 0 && isFinite(velocidad) ? velocidad : 1,
        position
      });
    } catch (_) {
      // Silencioso para evitar romper renderizados
    }
  }
  return true;
}
