import React, { useEffect, useMemo, useRef, useState } from 'react';
import localforage from 'localforage';
import {
  esCancionParaRevisar,
  esAlertaSospechosa,
  descargarArchivoRespaldoBiblioteca,
  type BackupSongMetadata
} from '../utils/libraryMigration';
import {
  esAlmacenamientoNativoDisponible,
  recuperarBlobCancionDesdeMemoriaFisica
} from '../utils/persistentStorageBridge';

export interface CancionRevisable {
  nombre: string;
  artista?: string;
  caratula?: string;
  duracion: number;
  tamano: number;
  favorito?: boolean;
  fecha?: number;
  origen?: string;
  verified?: boolean;
  sourceVersion?: string;
  durationExpected?: number;
  durationActual?: number;
  durationMatch?: boolean;
  flagReason?: string;
}

interface RevisarBibliotecaProps {
  biblioteca: CancionRevisable[];
  reemplazandoNombre?: string | null;
  onMarcarCorrecta: (nombre: string) => Promise<void> | void;
  onReemplazarVersion: (cancion: CancionRevisable, e: React.MouseEvent) => void;
  onEliminar: (nombre: string, e: React.MouseEvent) => void;
  onVolver?: () => void;
  onNotificar?: (mensaje: string, tipo?: 'exito' | 'error' | 'info') => void;
}

function formatearSegundos(segundos?: number): string {
  if (!segundos || isNaN(segundos) || !isFinite(segundos) || segundos < 0) return '0:00';
  const mins = Math.floor(segundos / 60);
  const segs = Math.floor(segundos % 60);
  return `${mins}:${segs < 10 ? '0' : ''}${segs}`;
}

export const RevisarBiblioteca: React.FC<RevisarBibliotecaProps> = ({
  biblioteca,
  reemplazandoNombre,
  onMarcarCorrecta,
  onReemplazarVersion,
  onEliminar,
  onVolver,
  onNotificar
}) => {
  const [filtroTexto, setFiltroTexto] = useState('');
  const [soloConAlerta, setSoloConAlerta] = useState(false);
  const [previewNombre, setPreviewNombre] = useState<string | null>(null);
  const [segundosRestantes, setSegundosRestantes] = useState<number>(15);
  const [cargandoPreview, setCargandoPreview] = useState<string | null>(null);
  const [procesandoId, setProcesandoId] = useState<string | null>(null);

  // Reproductor aislado para pre-escucha de 15 s (no toca SmartAutomixEngine ni bassBoostManager)
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const timerRef = useRef<number | null>(null);
  const countdownRef = useRef<number | null>(null);

  const detenerPreview = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (countdownRef.current !== null) {
      window.clearInterval(countdownRef.current);
      countdownRef.current = null;
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
    setPreviewNombre(null);
    setSegundosRestantes(15);
  };

  useEffect(() => {
    return () => {
      detenerPreview();
    };
  }, []);

  const cancionesPendientes = useMemo(() => {
    const q = filtroTexto.trim().toLowerCase();
    return biblioteca.filter((c) => {
      if (!esCancionParaRevisar(c)) return false;
      if (soloConAlerta && !esAlertaSospechosa(c)) return false;
      if (!q) return true;
      return (
        c.nombre.toLowerCase().includes(q) ||
        (c.artista || '').toLowerCase().includes(q) ||
        (c.flagReason || '').toLowerCase().includes(q)
      );
    });
  }, [biblioteca, filtroTexto, soloConAlerta]);

  const totalSinRevisar = useMemo(
    () => biblioteca.filter((c) => esCancionParaRevisar(c)).length,
    [biblioteca]
  );

  const totalConAlerta = useMemo(
    () => biblioteca.filter((c) => esCancionParaRevisar(c) && esAlertaSospechosa(c)).length,
    [biblioteca]
  );

  const manejarEscuchar15s = async (cancion: CancionRevisable) => {
    if (previewNombre === cancion.nombre) {
      detenerPreview();
      return;
    }

    detenerPreview();
    setCargandoPreview(cancion.nombre);

    try {
      const registro: any = await localforage.getItem(cancion.nombre);
      let blobAudio: Blob | null =
        registro instanceof Blob
          ? registro
          : registro && typeof registro === 'object' && registro.blob instanceof Blob
          ? registro.blob
          : null;

      if ((!blobAudio || blobAudio.size === 0) && esAlmacenamientoNativoDisponible()) {
        blobAudio = recuperarBlobCancionDesdeMemoriaFisica(cancion.nombre);
      }

      if (!blobAudio || blobAudio.size === 0) {
        onNotificar?.(`No se encontró el audio local de "${cancion.nombre}".`, 'error');
        return;
      }

      const url = URL.createObjectURL(blobAudio);
      objectUrlRef.current = url;

      const audio = new Audio(url);
      audio.preload = 'auto';
      audioRef.current = audio;

      audio.onended = () => detenerPreview();
      audio.onerror = () => {
        onNotificar?.(`No se pudo reproducir la vista previa de "${cancion.nombre}".`, 'error');
        detenerPreview();
      };

      await audio.play();
      setPreviewNombre(cancion.nombre);
      setSegundosRestantes(15);

      countdownRef.current = window.setInterval(() => {
        setSegundosRestantes((prev) => (prev > 1 ? prev - 1 : 0));
      }, 1000);

      timerRef.current = window.setTimeout(() => {
        detenerPreview();
      }, 15000);
    } catch (err: any) {
      console.warn('[RevisarBiblioteca]: Error en vista previa 15s:', err);
      onNotificar?.(`Error al reproducir vista previa: ${err?.message || 'desconocido'}`, 'error');
      detenerPreview();
    } finally {
      setCargandoPreview(null);
    }
  };

  const manejarMarcarCorrecta = async (nombre: string) => {
    if (previewNombre === nombre) detenerPreview();
    setProcesandoId(nombre);
    try {
      await onMarcarCorrecta(nombre);
    } finally {
      setProcesandoId(null);
    }
  };

  const manejarExportarRespaldo = () => {
    const lista: BackupSongMetadata[] = biblioteca.map((c) => ({
      nombre: c.nombre,
      artista: c.artista,
      duracion: c.duracion,
      tamano: c.tamano,
      favorito: Boolean(c.favorito),
      fecha: c.fecha,
      origen: c.origen,
      verified: c.verified,
      sourceVersion: c.sourceVersion,
      durationExpected: c.durationExpected,
      durationActual: c.durationActual ?? c.duracion,
      flagReason: c.flagReason
    }));
    const res = descargarArchivoRespaldoBiblioteca(lista);
    if (res.ok) {
      onNotificar?.(`✓ Respaldo JSON exportado (${lista.length} canciones).`, 'exito');
    } else {
      onNotificar?.('No se pudo generar el archivo de respaldo JSON.', 'error');
    }
  };

  return (
    <div style={{ paddingBottom: '32px' }}>
      {/* Encabezado */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '12px',
          marginBottom: '16px',
          padding: '14px 16px',
          borderRadius: '14px',
          background: 'rgba(255, 255, 255, 0.05)',
          border: '1px solid rgba(255, 255, 255, 0.1)'
        }}
      >
        <div>
          <h2 style={{ margin: 0, fontSize: '20px', fontWeight: 800, color: '#FFFFFF' }}>
            Revisar biblioteca
          </h2>
          <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#B3B3B3' }}>
            {totalSinRevisar === 0
              ? 'Todas tus canciones están verificadas.'
              : `${totalSinRevisar} pendientes de verificar (${totalConAlerta} con alerta detectada)`}
          </p>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            onClick={manejarExportarRespaldo}
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              color: '#FFFFFF',
              border: '1px solid rgba(255, 255, 255, 0.18)',
              borderRadius: '500px',
              padding: '8px 14px',
              fontSize: '12px',
              fontWeight: 700,
              cursor: 'pointer'
            }}
          >
            Exportar respaldo JSON
          </button>
          {onVolver && (
            <button
              onClick={() => {
                detenerPreview();
                onVolver();
              }}
              style={{
                backgroundColor: '#1ED760',
                color: '#000000',
                border: 'none',
                borderRadius: '500px',
                padding: '8px 14px',
                fontSize: '12px',
                fontWeight: 700,
                cursor: 'pointer'
              }}
            >
              Volver a Biblioteca
            </button>
          )}
        </div>
      </div>

      {/* Controles de filtro */}
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '14px' }}>
        <input
          type="text"
          value={filtroTexto}
          onChange={(e) => setFiltroTexto(e.target.value)}
          placeholder="Filtrar por título, artista o alerta..."
          style={{
            flex: '1 1 220px',
            backgroundColor: 'rgba(36, 36, 38, 0.85)',
            color: '#FFFFFF',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '500px',
            padding: '9px 14px',
            fontSize: '13px',
            outline: 'none'
          }}
        />
        <button
          onClick={() => setSoloConAlerta((prev) => !prev)}
          style={{
            backgroundColor: soloConAlerta ? '#F59E0B' : 'rgba(255, 255, 255, 0.08)',
            color: soloConAlerta ? '#000000' : '#FFFFFF',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '500px',
            padding: '8px 14px',
            fontSize: '12px',
            fontWeight: 700,
            cursor: 'pointer'
          }}
        >
          {soloConAlerta ? `Solo alertas (${totalConAlerta})` : `Ver solo alertas (${totalConAlerta})`}
        </button>
      </div>

      {/* Lista de canciones */}
      {cancionesPendientes.length === 0 ? (
        <div
          style={{
            textAlign: 'center',
            padding: '44px 16px',
            borderRadius: '14px',
            backgroundColor: 'rgba(255, 255, 255, 0.03)',
            color: '#B3B3B3'
          }}
        >
          <p style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: '#FFFFFF' }}>
            {totalSinRevisar === 0
              ? '¡Biblioteca 100% verificada!'
              : 'No hay canciones que coincidan con este filtro'}
          </p>
          <p style={{ margin: '6px 0 0 0', fontSize: '13px', color: '#8E8E93' }}>
            {totalSinRevisar === 0
              ? 'No quedan canciones pendientes o sospechosas por revisar.'
              : 'Prueba limpiando el texto de búsqueda o desactivando el filtro de alertas.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {cancionesPendientes.map((cancion) => {
            const estaEnPreview = previewNombre === cancion.nombre;
            const cargandoEsta = cargandoPreview === cancion.nombre;
            const reemplazandoEsta = reemplazandoNombre === cancion.nombre;
            const procesandoEsta = procesandoId === cancion.nombre;
            const durActual = cancion.durationActual ?? cancion.duracion ?? 0;

            return (
              <div
                key={cancion.nombre}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  padding: '12px 14px',
                  borderRadius: '12px',
                  backgroundColor: estaEnPreview
                    ? 'rgba(30, 215, 96, 0.12)'
                    : 'rgba(24, 24, 26, 0.92)',
                  border: cancion.flagReason
                    ? '1px solid rgba(245, 158, 11, 0.45)'
                    : '1px solid rgba(255, 255, 255, 0.09)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  {cancion.caratula ? (
                    <img
                      src={cancion.caratula}
                      alt={cancion.nombre}
                      style={{
                        width: '48px',
                        height: '48px',
                        borderRadius: '8px',
                        objectFit: 'cover',
                        flexShrink: 0
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '48px',
                        height: '48px',
                        borderRadius: '8px',
                        backgroundColor: '#282828',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#B3B3B3',
                        fontSize: '18px',
                        flexShrink: 0
                      }}
                    >
                      ♪
                    </div>
                  )}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontWeight: 700,
                        fontSize: '14px',
                        color: '#FFFFFF',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis'
                      }}
                    >
                      {cancion.nombre}
                    </div>
                    <div
                      style={{
                        fontSize: '12px',
                        color: '#B3B3B3',
                        marginTop: '2px',
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '8px'
                      }}
                    >
                      <span>{cancion.artista || 'Artista desconocido'}</span>
                      <span>•</span>
                      <span>Real: {formatearSegundos(durActual)}</span>
                      {typeof cancion.durationExpected === 'number' && cancion.durationExpected > 0 && (
                        <>
                          <span>•</span>
                          <span>Esperada: {formatearSegundos(cancion.durationExpected)}</span>
                        </>
                      )}
                      {cancion.sourceVersion && (
                        <>
                          <span>•</span>
                          <span>Origen: {cancion.sourceVersion}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Etiqueta de estado / alerta */}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
                  {esAlertaSospechosa(cancion) ? (
                    <span
                      style={{
                        backgroundColor: 'rgba(245, 158, 11, 0.2)',
                        color: '#FBBF24',
                        border: '1px solid rgba(245, 158, 11, 0.45)',
                        borderRadius: '999px',
                        padding: '3px 10px',
                        fontSize: '11px',
                        fontWeight: 700
                      }}
                    >
                      ⚠ {cancion.flagReason}
                    </span>
                  ) : cancion.flagReason === 'sin datos' ? (
                    <span
                      style={{
                        backgroundColor: 'rgba(255, 255, 255, 0.08)',
                        color: '#9CA3AF',
                        borderRadius: '999px',
                        padding: '3px 10px',
                        fontSize: '11px',
                        fontWeight: 600
                      }}
                    >
                      Sin datos en MusicBrainz
                    </span>
                  ) : cancion.durationMatch === true ? (
                    <span
                      style={{
                        backgroundColor: 'rgba(30, 215, 96, 0.14)',
                        color: '#6EE7B7',
                        border: '1px solid rgba(30, 215, 96, 0.3)',
                        borderRadius: '999px',
                        padding: '3px 10px',
                        fontSize: '11px',
                        fontWeight: 600
                      }}
                    >
                      Duración coincide (±5 s) — Pendiente confirmar
                    </span>
                  ) : (
                    <span
                      style={{
                        backgroundColor: 'rgba(255, 255, 255, 0.08)',
                        color: '#D1D5DB',
                        borderRadius: '999px',
                        padding: '3px 10px',
                        fontSize: '11px',
                        fontWeight: 600
                      }}
                    >
                      Pendiente de verificación
                    </span>
                  )}
                </div>

                {/* Botones de acción */}
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => manejarEscuchar15s(cancion)}
                    disabled={cargandoEsta}
                    style={{
                      backgroundColor: estaEnPreview ? '#1ED760' : 'rgba(255, 255, 255, 0.12)',
                      color: estaEnPreview ? '#000000' : '#FFFFFF',
                      border: 'none',
                      borderRadius: '8px',
                      padding: '8px 12px',
                      fontSize: '12px',
                      fontWeight: 700,
                      cursor: cargandoEsta ? 'wait' : 'pointer'
                    }}
                  >
                    {cargandoEsta
                      ? 'Cargando...'
                      : estaEnPreview
                      ? `Detener (${segundosRestantes} s)`
                      : 'Escuchar 15 s'}
                  </button>

                  <button
                    onClick={() => manejarMarcarCorrecta(cancion.nombre)}
                    disabled={procesandoEsta}
                    style={{
                      backgroundColor: 'rgba(30, 215, 96, 0.18)',
                      color: '#1ED760',
                      border: '1px solid rgba(30, 215, 96, 0.4)',
                      borderRadius: '8px',
                      padding: '8px 12px',
                      fontSize: '12px',
                      fontWeight: 700,
                      cursor: procesandoEsta ? 'wait' : 'pointer'
                    }}
                  >
                    {procesandoEsta ? 'Guardando...' : 'Marcar como correcta'}
                  </button>

                  <button
                    onClick={(e) => {
                      if (estaEnPreview) detenerPreview();
                      onReemplazarVersion(cancion, e);
                    }}
                    disabled={reemplazandoEsta}
                    style={{
                      backgroundColor: 'rgba(59, 130, 246, 0.18)',
                      color: '#60A5FA',
                      border: '1px solid rgba(59, 130, 246, 0.4)',
                      borderRadius: '8px',
                      padding: '8px 12px',
                      fontSize: '12px',
                      fontWeight: 700,
                      cursor: reemplazandoEsta ? 'wait' : 'pointer'
                    }}
                  >
                    {reemplazandoEsta ? 'Reemplazando...' : 'Reemplazar versión'}
                  </button>

                  <button
                    onClick={(e) => {
                      if (estaEnPreview) detenerPreview();
                      onEliminar(cancion.nombre, e);
                    }}
                    style={{
                      backgroundColor: 'rgba(239, 68, 68, 0.16)',
                      color: '#F87171',
                      border: '1px solid rgba(239, 68, 68, 0.35)',
                      borderRadius: '8px',
                      padding: '8px 12px',
                      fontSize: '12px',
                      fontWeight: 700,
                      cursor: 'pointer'
                    }}
                  >
                    Eliminar
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
