/**
 * Administrador de Progreso de Audio Aislado (Ultra Alto Rendimiento)
 * Desacopla por completo los ticks de tiempo (onTimeUpdate) del árbol principal de React.
 * Permite que ni App.tsx ni las vistas (Inicio, Buscar, Biblioteca, Ajustes) se re-rendericen al sonar música.
 */

export function formatearTiempo(segundos?: number): string {
  if (!segundos || isNaN(segundos) || !isFinite(segundos) || segundos < 0) return '0:00';
  const mins = Math.floor(segundos / 60);
  const segs = Math.floor(segundos % 60);
  return `${mins}:${segs < 10 ? '0' : ''}${segs}`;
}

type AudioProgressListener = (currentTime: number, duration: number) => void;

class AudioProgressManager {
  private listeners: Set<AudioProgressListener> = new Set();
  private currentTime: number = 0;
  private duration: number = 0;

  /**
   * Emite el nuevo tiempo y duración a los componentes suscritos.
   */
  public emit(curr: number, dur: number): void {
    const tiempoSeguro = isFinite(curr) && curr >= 0 ? curr : 0;
    const duracionSegura = isFinite(dur) && dur >= 0 ? dur : 0;

    this.currentTime = tiempoSeguro;
    if (duracionSegura > 0) {
      this.duration = duracionSegura;
    }

    for (const listener of this.listeners) {
      try {
        listener(this.currentTime, this.duration);
      } catch (err) {
        console.error('[AudioProgressManager] Error en listener:', err);
      }
    }
  }

  /**
   * Suscribe un callback a las actualizaciones de tiempo.
   */
  public subscribe(listener: AudioProgressListener): () => void {
    this.listeners.add(listener);
    // Notificar inmediatamente el valor actual
    listener(this.currentTime, this.duration);

    return () => {
      this.listeners.delete(listener);
    };
  }

  public getCurrentTime(): number {
    return this.currentTime;
  }

  public getDuration(): number {
    return this.duration;
  }

  public reset(): void {
    this.currentTime = 0;
    this.duration = 0;
    this.emit(0, 0);
  }
}

export const audioProgress = new AudioProgressManager();
