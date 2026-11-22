import React, { useEffect, useRef, useState } from 'react';

export interface DatosPreescucha {
  titulo: string;
  artista?: string;
  caratula?: string;
  blob: Blob;
  duracionReal: number;
  duracionEsperada?: number;
  modoReemplazo?: boolean;
  reemplazarClaveOriginal?: string;
  sourceVersion?: string;
}

interface PreescuchaModalProps {
  datos: DatosPreescucha | null;
  guardando?: boolean;
  onGuardar: (datos: DatosPreescucha) => Promise<void> | void;
  onDescartar: () => void;
  onBuscarOtraVersion: (datos: DatosPreescucha) => void;
}

function formatearSegundos(seg?: number): string {
  if (!seg || isNaN(seg) || !isFinite(seg) || seg < 0) return '0:00';
  const m = Math.floor(seg / 60);
  const s = Math.floor(seg % 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

export const PreescuchaModal: React.FC<PreescuchaModalProps> = ({
  datos,
  guardando = false,
  onGuardar,
  onDescartar,
  onBuscarOtraVersion
}) => {
  const [reproduciendo, setReproduciendo] = useState(false);
  const [segundosTranscurridos, setSegundosTranscurridos] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);

  const detener = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
        audioRef.current.load();
      } catch (_) {}
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      try {
        URL.revokeObjectURL(objectUrlRef.current);
      } catch (_) {}
      objectUrlRef.current = null;
    }
    setReproduciendo(false);
    setSegundosTranscurridos(0);
  };

  useEffect(() => {
    return () => detener();
  }, [datos]);

  if (!datos) return null;

  const alternarReproduccion15s = async () => {
    if (reproduciendo) {
      detener();
      return;
    }

    detener();
    try {
      const url = URL.createObjectURL(datos.blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audioRef.current = audio;

      audio.onended = () => detener();
      audio.onerror = () => detener();

      await audio.play();
      setReproduciendo(true);
      setSegundosTranscurridos(0);

      intervalRef.current = window.setInterval(() => {
        setSegundosTranscurridos((prev) => (prev < 15 ? prev + 1 : 15));
      }, 1000);

      timerRef.current = window.setTimeout(() => {
        detener();
      }, 15000);
    } catch {
      detener();
    }
  };

  const diferencia =
    typeof datos.duracionEsperada === 'number' && datos.duracionEsperada > 0 && datos.duracionReal > 0
      ? Math.abs(datos.duracionReal - datos.duracionEsperada)
      : null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        backgroundColor: 'rgba(0, 0, 0, 0.78)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '16px'
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '420px',
          backgroundColor: '#18181B',
          border: '1px solid rgba(255, 255, 255, 0.14)',
          borderRadius: '18px',
          padding: '20px',
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.65)'
        }}
      >
        <div style={{ fontSize: '11px', fontWeight: 800, color: '#1ED760', textTransform: 'uppercase', letterSpacing: '0.7px', marginBottom: '8px' }}>
          {datos.modoReemplazo ? 'Confirmar reemplazo de versión' : 'Vista previa antes de guardar'}
        </div>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '14px' }}>
          {datos.caratula ? (
            <img
              src={datos.caratula}
              alt={datos.titulo}
              style={{ width: '56px', height: '56px', borderRadius: '10px', objectFit: 'cover', flexShrink: 0 }}
            />
          ) : (
            <div
              style={{
                width: '56px',
                height: '56px',
                borderRadius: '10px',
                backgroundColor: '#27272A',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#A1A1AA',
                fontSize: '20px',
                flexShrink: 0
              }}
            >
              ♪
            </div>
          )}

          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: '15px', fontWeight: 800, color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {datos.titulo}
            </div>
            <div style={{ fontSize: '13px', color: '#A1A1AA', marginTop: '2px' }}>
              {datos.artista || 'Artista desconocido'}
            </div>
            {datos.modoReemplazo && datos.reemplazarClaveOriginal && (
              <div style={{ fontSize: '11px', color: '#60A5FA', marginTop: '4px' }}>
                Reemplazará: "{datos.reemplazarClaveOriginal}" (conservando playlists y favoritos)
              </div>
            )}
          </div>
        </div>

        {/* Duración total y esperada */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '8px',
            padding: '10px 12px',
            borderRadius: '10px',
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            marginBottom: '14px',
            fontSize: '12px',
            color: '#E4E4E7'
          }}
        >
          <span>
            Duración total: <strong>{formatearSegundos(datos.duracionReal)}</strong>
          </span>
          <span>
            Esperada:{' '}
            <strong>
              {datos.duracionEsperada && datos.duracionEsperada > 0
                ? formatearSegundos(datos.duracionEsperada)
                : 'N/D'}
            </strong>
          </span>
        </div>

        {diferencia !== null && diferencia > 5 && (
          <div
            style={{
              marginBottom: '12px',
              padding: '8px 10px',
              borderRadius: '8px',
              backgroundColor: 'rgba(245, 158, 11, 0.16)',
              border: '1px solid rgba(245, 158, 11, 0.4)',
              color: '#FBBF24',
              fontSize: '12px',
              fontWeight: 600
            }}
          >
            ⚠ La duración difiere en {Math.round(diferencia)} s respecto a la esperada.
          </div>
        )}

        {/* Reproductor 15s */}
        <div style={{ marginBottom: '16px' }}>
          <button
            onClick={alternarReproduccion15s}
            style={{
              width: '100%',
              backgroundColor: reproduciendo ? '#1ED760' : 'rgba(255, 255, 255, 0.12)',
              color: reproduciendo ? '#000000' : '#FFFFFF',
              border: 'none',
              borderRadius: '10px',
              padding: '10px 14px',
              fontSize: '13px',
              fontWeight: 800,
              cursor: 'pointer'
            }}
          >
            {reproduciendo ? `Detener vista previa (${15 - segundosTranscurridos} s)` : '▶ Escuchar 15 s'}
          </button>
          <div style={{ marginTop: '6px', height: '4px', borderRadius: '999px', backgroundColor: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
            <div
              style={{
                width: `${Math.min(100, Math.round((segundosTranscurridos / 15) * 100))}%`,
                height: '100%',
                backgroundColor: '#1ED760',
                transition: 'width 0.3s linear'
              }}
            />
          </div>
        </div>

        {/* Acciones */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            onClick={() => {
              detener();
              onGuardar(datos);
            }}
            disabled={guardando}
            style={{
              backgroundColor: '#1ED760',
              color: '#000000',
              border: 'none',
              borderRadius: '500px',
              padding: '11px 16px',
              fontSize: '13px',
              fontWeight: 800,
              cursor: guardando ? 'wait' : 'pointer'
            }}
          >
            {guardando ? 'Guardando...' : datos.modoReemplazo ? 'Confirmar reemplazo' : 'Guardar'}
          </button>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={() => {
                detener();
                onBuscarOtraVersion(datos);
              }}
              disabled={guardando}
              style={{
                flex: 1,
                backgroundColor: 'rgba(59, 130, 246, 0.18)',
                color: '#60A5FA',
                border: '1px solid rgba(59, 130, 246, 0.4)',
                borderRadius: '500px',
                padding: '10px 12px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              Buscar otra versión
            </button>

            <button
              onClick={() => {
                detener();
                onDescartar();
              }}
              disabled={guardando}
              style={{
                flex: 1,
                backgroundColor: 'rgba(239, 68, 68, 0.16)',
                color: '#F87171',
                border: '1px solid rgba(239, 68, 68, 0.35)',
                borderRadius: '500px',
                padding: '10px 12px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              Descartar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
