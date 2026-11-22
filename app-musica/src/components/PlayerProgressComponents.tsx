import React, { useEffect, useRef, useState, useCallback } from 'react';
import { audioProgress, formatearTiempo } from '../utils/audioProgress';

interface MiniPlayerProgressBarProps {
  color: string;
  isError?: boolean;
}

/**
 * Barra de progreso superior del mini-reproductor.
 * Manipula directamente el DOM para 0 re-renders de React en toda la aplicación.
 */
export const MiniPlayerProgressBar: React.FC<MiniPlayerProgressBarProps> = React.memo(({ color, isError }) => {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return audioProgress.subscribe((curr, dur) => {
      if (barRef.current) {
        const pct = dur > 0 ? Math.min(100, Math.max(0, (curr / dur) * 100)) : 0;
        barRef.current.style.width = `${pct}%`;
      }
    });
  }, []);

  return (
    <div style={{
      height: '2.5px',
      width: '100%',
      backgroundColor: 'rgba(255, 255, 255, 0.08)',
      position: 'absolute',
      top: 0,
      left: 0,
      overflow: 'hidden',
      borderTopLeftRadius: '14px',
      borderTopRightRadius: '14px'
    }}>
      <div
        ref={barRef}
        style={{
          height: '100%',
          backgroundColor: isError ? '#ef4444' : color,
          width: '0%',
          boxShadow: `0 0 8px ${color}`,
          transition: 'width 0.25s linear, background-color 0.8s ease'
        }}
      />
    </div>
  );
});

interface MiniPlayerTimeTextProps {
  duracionFallback?: number;
  timerTextoRestante?: string;
  mensajeErrorAudio?: string | null;
}

/**
 * Contador de tiempo (mm:ss / mm:ss) del mini-reproductor.
 * Actualiza directamente el texto en el DOM cada segundo sin re-renderizar React.
 */
export const MiniPlayerTimeText: React.FC<MiniPlayerTimeTextProps> = React.memo(({
  duracionFallback = 0,
  timerTextoRestante = '',
  mensajeErrorAudio = null
}) => {
  const textRef = useRef<HTMLSpanElement>(null);
  const ultimoSegundoRef = useRef<number>(-1);

  useEffect(() => {
    return audioProgress.subscribe((curr, dur) => {
      const segActual = Math.floor(curr);
      // Actualizar solo cuando el segundo entero cambie para mínimo overhead de DOM
      if (segActual !== ultimoSegundoRef.current || curr === 0) {
        ultimoSegundoRef.current = segActual;
        if (textRef.current) {
          if (mensajeErrorAudio) {
            textRef.current.textContent = mensajeErrorAudio;
          } else {
            const durFinal = dur > 0 ? dur : duracionFallback;
            const extraTimer = timerTextoRestante ? `   ⏳ ${timerTextoRestante}` : '';
            textRef.current.textContent = `${formatearTiempo(curr)} / ${formatearTiempo(durFinal)}${extraTimer}`;
          }
        }
      }
    });
  }, [duracionFallback, timerTextoRestante, mensajeErrorAudio]);

  return (
    <p style={{ margin: 0, fontSize: '11px', color: '#94A3B8', fontWeight: '500' }}>
      <span ref={textRef}>
        {mensajeErrorAudio || `0:00 / ${formatearTiempo(duracionFallback)}${timerTextoRestante ? `   ⏳ ${timerTextoRestante}` : ''}`}
      </span>
    </p>
  );
});

interface ExpandedPlayerScrubberProps {
  color: string;
  duracionTotal: number;
  onSeek: (nuevoSegundo: number) => void;
  onArrastrandoChange?: (arrastrando: boolean) => void;
}

/**
 * Scrubber interactivo y etiquetas de tiempo del Reproductor Expandido a pantalla completa.
 * Aislado para que el avance de la canción jamás re-renderice la app principal.
 */
export const ExpandedPlayerScrubber: React.FC<ExpandedPlayerScrubberProps> = React.memo(({
  color,
  duracionTotal,
  onSeek,
  onArrastrandoChange
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const tiempoActualRef = useRef<HTMLSpanElement>(null);
  const duracionTotalRef = useRef<HTMLSpanElement>(null);
  const arrastrandoRef = useRef<boolean>(false);
  const [duracionLocal, setDuracionLocal] = useState<number>(duracionTotal);

  useEffect(() => {
    if (duracionTotal > 0) {
      setDuracionLocal(duracionTotal);
      if (inputRef.current) inputRef.current.max = String(duracionTotal);
      if (duracionTotalRef.current) duracionTotalRef.current.textContent = formatearTiempo(duracionTotal);
    }
  }, [duracionTotal]);

  useEffect(() => {
    return audioProgress.subscribe((curr, dur) => {
      const durEfectiva = dur > 0 ? dur : duracionTotal;
      if (durEfectiva > 0 && durEfectiva !== duracionLocal) {
        setDuracionLocal(durEfectiva);
        if (inputRef.current) inputRef.current.max = String(durEfectiva);
        if (duracionTotalRef.current) duracionTotalRef.current.textContent = formatearTiempo(durEfectiva);
      }

      if (!arrastrandoRef.current) {
        if (inputRef.current) {
          inputRef.current.value = String(curr);
        }
        if (tiempoActualRef.current) {
          tiempoActualRef.current.textContent = formatearTiempo(curr);
        }
      }
    });
  }, [duracionTotal, duracionLocal]);

  const handleMouseDown = useCallback(() => {
    arrastrandoRef.current = true;
    onArrastrandoChange?.(true);
  }, [onArrastrandoChange]);

  const handleMouseUp = useCallback((e: React.MouseEvent<HTMLInputElement> | React.TouchEvent<HTMLInputElement>) => {
    arrastrandoRef.current = false;
    onArrastrandoChange?.(false);
    const val = parseFloat((e.target as HTMLInputElement).value || '0');
    onSeek(val);
  }, [onSeek, onArrastrandoChange]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value || '0');
    if (tiempoActualRef.current) {
      tiempoActualRef.current.textContent = formatearTiempo(val);
    }
  }, []);

  return (
    <div style={{ marginBottom: '24px' }}>
      <input
        ref={inputRef}
        type="range"
        min="0"
        max={duracionLocal > 0 ? duracionLocal : 100}
        step="0.05"
        defaultValue="0"
        onMouseDown={handleMouseDown}
        onTouchStart={handleMouseDown}
        onChange={handleChange}
        onMouseUp={handleMouseUp}
        onTouchEnd={handleMouseUp}
        style={{
          width: '100%',
          cursor: 'pointer',
          accentColor: color,
          height: '4px',
          borderRadius: '2px'
        }}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#B3B3B3', marginTop: '6px' }}>
        <span ref={tiempoActualRef}>0:00</span>
        <span ref={duracionTotalRef}>{formatearTiempo(duracionLocal)}</span>
      </div>
    </div>
  );
});

interface DrawerTimeTextProps {
  duracionFallback?: number;
}

/**
 * Muestra el tiempo en el drawer de ecualizador / info técnica.
 */
export const DrawerTimeText: React.FC<DrawerTimeTextProps> = React.memo(({ duracionFallback = 0 }) => {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    return audioProgress.subscribe((curr, dur) => {
      if (ref.current) {
        const durTotal = dur > 0 ? dur : duracionFallback;
        ref.current.textContent = `${formatearTiempo(curr)} / ${formatearTiempo(durTotal)}`;
      }
    });
  }, [duracionFallback]);

  return (
    <span ref={ref} style={{ fontSize: '11px', color: '#94A3B8' }}>
      0:00 / {formatearTiempo(duracionFallback)}
    </span>
  );
});

interface LetrasPreviewSnippetProps {
  infoLetra: { sincronizada?: boolean; lineas?: Array<{ segundos: number; texto: string }>; textoPlano?: string } | null;
  colorPrincipal: string;
}

/**
 * Previsualización pequeña de letra en el reproductor expandido.
 * Solo se re-renderiza cuando cambia el verso real, nunca por milisegundos.
 */
export const LetrasPreviewSnippet: React.FC<LetrasPreviewSnippetProps> = React.memo(({ infoLetra, colorPrincipal }) => {
  const [lineaIdx, setLineaIdx] = useState<number>(0);

  useEffect(() => {
    if (!infoLetra?.sincronizada || !infoLetra?.lineas || infoLetra.lineas.length === 0) return;
    return audioProgress.subscribe((curr) => {
      const lineas = infoLetra.lineas!;
      for (let i = lineas.length - 1; i >= 0; i--) {
        if (curr >= lineas[i].segundos - 0.25) {
          setLineaIdx((prev) => (prev !== i ? i : prev));
          break;
        }
      }
    });
  }, [infoLetra]);

  if (!infoLetra?.lineas || infoLetra.lineas.length === 0) return null;

  const lineasPrevias = infoLetra.lineas.slice(Math.max(0, lineaIdx - 1), lineaIdx + 3);

  return (
    <>
      {lineasPrevias.map((lin, subIdx) => {
        const esLaActual = lin.texto === infoLetra.lineas![lineaIdx]?.texto;
        return (
          <p
            key={subIdx}
            style={{
              margin: 0,
              fontSize: esLaActual ? '16px' : '13.5px',
              fontWeight: esLaActual ? '800' : '600',
              color: esLaActual ? '#FFFFFF' : 'rgba(255, 255, 255, 0.42)',
              textShadow: esLaActual ? `0 0 12px ${colorPrincipal}99` : 'none',
              transition: 'all 0.25s ease',
              lineHeight: 1.35
            }}
          >
            {lin.texto}
          </p>
        );
      })}
    </>
  );
});
