import { useState, useEffect, useCallback, useRef } from 'react';

export interface Pista {
  nombre: string;
  artista?: string;
  duracion?: number;
  caratula?: string;
  fechaEscuchado?: number;
  blob?: Blob;
  tamano?: number;
  [key: string]: any;
}

export type ItemHistorialEscucha = Pista;

const STORAGE_KEY = 'app_musica_historial_reciente';
const STORAGE_KEY_LEGACY = 'app_musica_historial_escucha';
const MAX_HISTORIAL = 20;

export function useHistorialEscucha() {
  const [historial, setHistorial] = useState<Pista[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const guardado = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY_LEGACY);
      if (guardado) {
        const parsed = JSON.parse(guardado);
        if (Array.isArray(parsed)) return parsed.slice(0, MAX_HISTORIAL);
      }
    } catch (e) {
      console.warn('[useHistorialEscucha]: Error al cargar historial inicial:', e);
    }
    return [];
  });

  // Guardar en localStorage de forma sincronizada
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const json = JSON.stringify(historial);
      localStorage.setItem(STORAGE_KEY, json);
      // Mantener clave legacy sincronizada por compatibilidad
      localStorage.setItem(STORAGE_KEY_LEGACY, json);
    } catch (e) {
      console.warn('[useHistorialEscucha]: Error al persistir historial:', e);
    }
  }, [historial]);

  // Referencia interna para rastrear qué pista ya fue registrada en la reproducción actual
  const pistaRegistradaRef = useRef<string | null>(null);

  /**
   * Agrega o reposiciona una pista en el historial.
   * Si se proporcionan tiempoActual y duracionTotal, evalúa el umbral:
   * Solo registra si la canción ha superado al menos 20 segundos de reproducción o el 40% de su duración total.
   */
  const agregarAlHistorial = useCallback((pista: Pista, tiempoActual?: number, duracionTotal?: number) => {
    if (!pista || !pista.nombre) return;

    const claveNormalizada = pista.nombre.toLowerCase().trim();

    // Si se pasa tiempoActual, verificar el umbral de reproducción
    if (typeof tiempoActual === 'number') {
      // Si la pista recomienza desde cero (nuevo tema), resetear el flag si es distinta
      if (tiempoActual < 1 && pistaRegistradaRef.current !== claveNormalizada) {
        pistaRegistradaRef.current = null;
      }

      const duracion = duracionTotal || pista.duracion || 0;
      const supero20Segundos = tiempoActual >= 20;
      const supero40Porciento = duracion > 0 && tiempoActual >= duracion * 0.4;

      if (!supero20Segundos && !supero40Porciento) {
        // Aún no cumple el umbral para ser considerado escuchado
        return;
      }
    }

    // Evitar llamadas redundantes si la pista activa ya fue registrada en este turno
    if (pistaRegistradaRef.current === claveNormalizada) {
      return;
    }

    pistaRegistradaRef.current = claveNormalizada;

    setHistorial((prev) => {
      // Si ya está en la posición 0, no es necesario reordenar
      if (prev.length > 0 && prev[0].nombre.toLowerCase().trim() === claveNormalizada) {
        return prev;
      }

      // Remover si ya existía para moverla a la posición 0 (más reciente) sin duplicar
      const filtrado = prev.filter(
        (item) => item.nombre.toLowerCase().trim() !== claveNormalizada
      );

      const nuevaEntrada: Pista = {
        nombre: pista.nombre,
        artista: pista.artista || '',
        duracion: pista.duracion || duracionTotal || 0,
        caratula: pista.caratula || '',
        fechaEscuchado: Date.now()
      };

      return [nuevaEntrada, ...filtrado].slice(0, MAX_HISTORIAL);
    });
  }, []);

  const limpiarHistorial = useCallback(() => {
    pistaRegistradaRef.current = null;
    setHistorial([]);
    try {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY_LEGACY);
    } catch (_) {}
  }, []);

  return {
    historial,
    agregarAlHistorial,
    registrarEscucha: agregarAlHistorial, // Alias de compatibilidad total
    limpiarHistorial
  };
}
