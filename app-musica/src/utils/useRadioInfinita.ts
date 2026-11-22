import type React from 'react';

export interface PistaRadioInfinita {
  nombre: string;
  artista?: string;
  duracion?: number;
  caratula?: string;
  blob?: Blob;
  tamano?: number;
  esRecomendada?: boolean;
}

export interface UseRadioInfinitaOptions {
  cancionActual: { nombre: string; artista?: string; duracion?: number; caratula?: string } | null;
  colaReproduccion: PistaRadioInfinita[];
  setColaReproduccion: React.Dispatch<React.SetStateAction<any[]>>;
  reproduciendo: boolean;
  autoplayHabilitado: boolean;
  historialNombres?: string[];
  biblioteca?: any[];
  onRecomendacionesAgregadas?: (cantidad: number) => void;
}

/**
 * Hook autónomo para Radio Infinita / Autoplay Inteligente (Smart Queue).
 * Cuando la cola manual se vacía y hay una pista activa, consulta en segundo plano
 * temas del mismo artista o género y los añade con `esRecomendada: true`.
 * 
 * Regla de No-Regresión: No ejecuta efectos durante el renderizado y previene
 * consultas duplicadas con control de referencias.
 */
export function useRadioInfinita(_options: UseRadioInfinitaOptions) {
  // Desactivado: La reproducción continua se gestiona de forma 100% determinista
  // sobre la biblioteca local y la fila manual del usuario (estilo Spotify),
  // evitando inyectar pistas remotas vacías (0 bytes) que interrumpan o corten el audio.
}
