import React from 'react';
import { SpotifyEqualizer, IconCola, IconLimpiar, IconPlay } from './SpotifyIcons';

export interface PistaCola {
  nombre: string;
  artista?: string;
  duracion?: number;
  caratula?: string;
  blob?: Blob;
  tamano?: number;
  esRecomendada?: boolean;
}

interface ColaReproduccionModalProps {
  abierto: boolean;
  alCerrar: () => void;
  cancionActual: PistaCola | null;
  reproduciendo: boolean;
  cola: PistaCola[];
  siguientesBiblioteca?: PistaCola[];
  onQuitarDeCola: (index: number) => void;
  onVaciarCola: () => void;
  onReordenarCola: (origenIndex: number, destinoIndex: number) => void;
  onReproducirDirecto?: (cancion: PistaCola, indexEnCola?: number) => void;
  onAgregarACola?: (cancion: PistaCola) => void;
  autoplayActivo?: boolean;
  onToggleAutoplay?: (activo: boolean) => void;
}

function formatearSegundos(segundos?: number): string {
  if (!segundos || isNaN(segundos)) return '0:00';
  const mins = Math.floor(segundos / 60);
  const segs = Math.floor(segundos % 60);
  return `${mins}:${segs < 10 ? '0' : ''}${segs}`;
}

export const ColaReproduccionModal: React.FC<ColaReproduccionModalProps> = React.memo(({
  abierto,
  alCerrar,
  cancionActual,
  reproduciendo,
  cola,
  siguientesBiblioteca = [],
  onQuitarDeCola,
  onVaciarCola,
  onReordenarCola,
  onReproducirDirecto,
  onAgregarACola,
  autoplayActivo = true,
  onToggleAutoplay
}) => {
  if (!abierto) return null;

  return (
    <div
      onClick={alCerrar}
      className="cola-modal-overlay"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="cola-modal-container cola-reproduccion-drawer"
      >
        {/* Barra superior con 'handle' táctil */}
        <div style={{ padding: '12px 20px 8px 20px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <div
            style={{
              width: '42px',
              height: '4px',
              backgroundColor: 'rgba(255, 255, 255, 0.25)',
              borderRadius: '2px',
              marginBottom: '12px'
            }}
          />
          <div style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <IconCola size={20} color="#1ED760" />
              <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: '#FFFFFF', letterSpacing: '-0.3px' }}>
                Fila de Reproducción
              </h3>
              <span
                style={{
                  fontSize: '11px',
                  fontWeight: '700',
                  backgroundColor: 'rgba(30, 215, 96, 0.15)',
                  color: '#1ED760',
                  padding: '2px 8px',
                  borderRadius: '12px'
                }}
              >
                {cola.length} manuales
              </span>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {cola.length > 0 && (
                <button
                  onClick={onVaciarCola}
                  title="Vaciar canciones manuales de la fila"
                  style={{
                    background: 'rgba(239, 68, 68, 0.12)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#ef4444',
                    borderRadius: '500px',
                    padding: '5px 12px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '4px'
                  }}
                >
                  <IconLimpiar size={14} color="#ef4444" />
                  <span>Vaciar</span>
                </button>
              )}
              <button
                onClick={alCerrar}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: 'none',
                  borderRadius: '50%',
                  width: '32px',
                  height: '32px',
                  color: '#B3B3B3',
                  fontSize: '16px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                ✕
              </button>
            </div>
          </div>
        </div>

        {/* Contenido scrolleable */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px 20px 24px 20px', display: 'flex', flexDirection: 'column', gap: '18px' }}>
          {/* SECCIÓN 1: En reproducción actual */}
          <div>
            <span style={{ fontSize: '11px', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.8px', color: '#A7A7A7', display: 'block', marginBottom: '8px' }}>
              Sonando Ahora
            </span>
            {cancionActual ? (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  backgroundColor: 'rgba(30, 215, 96, 0.08)',
                  border: '1px solid rgba(30, 215, 96, 0.3)',
                  padding: '12px 14px',
                  borderRadius: '14px',
                  gap: '12px'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
                  {cancionActual.caratula ? (
                    <img
                      src={cancionActual.caratula}
                      alt={cancionActual.nombre}
                      loading="lazy"
                      decoding="async"
                      style={{ width: '44px', height: '44px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '44px',
                        height: '44px',
                        borderRadius: '8px',
                        backgroundColor: '#282828',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#1ED760',
                        fontWeight: '800',
                        flexShrink: 0
                      }}
                    >
                      ♫
                    </div>
                  )}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <p style={{ margin: 0, fontSize: '14px', fontWeight: '700', color: '#1ED760', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cancionActual.nombre}
                    </p>
                    <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: '#B3B3B3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {cancionActual.artista || 'Artista desconocido'} • {formatearSegundos(cancionActual.duracion)}
                    </p>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                  <SpotifyEqualizer animando={reproduciendo} color="#1ED760" />
                </div>
              </div>
            ) : (
              <div style={{ padding: '14px', textAlign: 'center', color: '#71717a', fontSize: '13px', backgroundColor: 'rgba(255, 255, 255, 0.03)', borderRadius: '12px' }}>
                No hay ninguna canción reproduciéndose actualmente
              </div>
            )}
          </div>

          {/* SWITCH DISCRETO SPOTIFY: AUTOPLAY / RADIO INTELIGENTE */}
          {onToggleAutoplay && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                backgroundColor: 'rgba(255, 255, 255, 0.03)',
                borderRadius: '14px',
                border: '1px solid rgba(255, 255, 255, 0.06)'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '16px' }}>✨</span>
                <div>
                  <p style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#F4F4F5' }}>
                    Autoplay: Música similar continua
                  </p>
                  <p style={{ margin: '1px 0 0 0', fontSize: '11px', color: '#71717A' }}>
                    Añade canciones afines al vaciarse la fila
                  </p>
                </div>
              </div>

              {/* Botón switch pill interactivo */}
              <button
                type="button"
                onClick={() => onToggleAutoplay(!autoplayActivo)}
                title={autoplayActivo ? 'Desactivar Autoplay' : 'Activar Autoplay'}
                style={{
                  width: '42px',
                  height: '24px',
                  borderRadius: '12px',
                  backgroundColor: autoplayActivo ? '#1ED760' : '#3f3f46',
                  border: 'none',
                  cursor: 'pointer',
                  position: 'relative',
                  padding: '2px',
                  transition: 'background-color 0.2s ease',
                  flexShrink: 0
                }}
              >
                <div
                  style={{
                    width: '20px',
                    height: '20px',
                    borderRadius: '50%',
                    backgroundColor: '#FFFFFF',
                    transform: autoplayActivo ? 'translateX(18px)' : 'translateX(0px)',
                    transition: 'transform 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
                    boxShadow: '0 2px 4px rgba(0,0,0,0.4)'
                  }}
                />
              </button>
            </div>
          )}

          {/* SECCIÓN 2: Lista A Continuación (Agregadas a la Fila) */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <span style={{ fontSize: '11px', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.8px', color: '#A7A7A7' }}>
                A continuación en la fila ({cola.length})
              </span>
              <span style={{ fontSize: '10px', color: '#71717a' }}>Agregadas manualmente</span>
            </div>

            {cola.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '24px 16px',
                  backgroundColor: 'rgba(255, 255, 255, 0.02)',
                  border: '1px dashed rgba(255, 255, 255, 0.1)',
                  borderRadius: '14px',
                  color: '#71717a'
                }}
              >
                <div style={{ fontSize: '20px', marginBottom: '4px' }}>🎧</div>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: '600', color: '#D4D4D8' }}>No hay pistas agregadas a la fila</p>
                <p style={{ margin: '3px 0 0 0', fontSize: '11px', color: '#A1A1AA' }}>
                  Toca el botón "+ Fila" en cualquier canción para programarla a continuación.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {cola.map((cancion, index) => {
                  const esPrimeraRecomendada = Boolean(
                    cancion.esRecomendada && (index === 0 || !cola[index - 1]?.esRecomendada)
                  );

                  return (
                    <React.Fragment key={`${cancion.nombre}-${index}`}>
                      {esPrimeraRecomendada && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '14px 0 6px 0', padding: '0 4px' }}>
                          <span style={{ fontSize: '11px', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.8px', color: '#1ED760' }}>
                            ✨ Continuando con canciones similares
                          </span>
                          <div style={{ flex: 1, height: '1px', backgroundColor: 'rgba(30, 215, 96, 0.25)' }} />
                        </div>
                      )}

                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          backgroundColor: cancion.esRecomendada
                            ? 'rgba(30, 215, 96, 0.04)'
                            : 'rgba(255, 255, 255, 0.04)',
                          border: cancion.esRecomendada
                            ? '1px dashed rgba(30, 215, 96, 0.25)'
                            : '1px solid rgba(255, 255, 255, 0.06)',
                          borderRadius: '12px',
                          padding: '8px 12px',
                          gap: '8px',
                          transition: 'background-color 0.15s ease'
                        }}
                      >
                        {/* Botón reproducir directo / índice */}
                        <button
                          onClick={() => onReproducirDirecto && onReproducirDirecto(cancion, index)}
                          title="Reproducir ahora"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#A1A1AA',
                            fontSize: '12px',
                            fontWeight: '700',
                            cursor: 'pointer',
                            padding: '4px 8px',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                          }}
                        >
                          <span style={{ minWidth: '16px', textAlign: 'center' }}>{index + 1}</span>
                          <IconPlay size={14} color="#1ED760" />
                        </button>

                        {/* Portada / Info */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                          {cancion.caratula ? (
                            <img
                              src={cancion.caratula}
                              alt={cancion.nombre}
                              loading="lazy"
                              decoding="async"
                              style={{ width: '38px', height: '38px', borderRadius: '6px', objectFit: 'cover', flexShrink: 0 }}
                            />
                          ) : (
                            <div
                              style={{
                                width: '38px',
                                height: '38px',
                                borderRadius: '6px',
                                backgroundColor: '#27272a',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: '#9CA3AF',
                                fontSize: '12px',
                                flexShrink: 0
                              }}
                            >
                              ♫
                            </div>
                          )}
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <p style={{ margin: 0, fontSize: '13px', fontWeight: '600', color: '#F4F4F5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {cancion.nombre}
                              </p>
                              {cancion.esRecomendada && (
                                <span
                                  style={{
                                    fontSize: '9px',
                                    fontWeight: '800',
                                    backgroundColor: 'rgba(30, 215, 96, 0.15)',
                                    color: '#1ED760',
                                    padding: '1px 5px',
                                    borderRadius: '4px',
                                    flexShrink: 0
                                  }}
                                >
                                  Radio
                                </span>
                              )}
                            </div>
                            <p style={{ margin: '1px 0 0 0', fontSize: '11px', color: '#71717A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {cancion.artista || 'Artista desconocido'} • {formatearSegundos(cancion.duracion)}
                            </p>
                          </div>
                        </div>

                        {/* Acciones de reordenación y eliminación */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
                          <button
                            onClick={() => onReordenarCola(index, index - 1)}
                            disabled={index === 0}
                            title="Subir en la fila"
                            style={{
                              background: 'rgba(255, 255, 255, 0.05)',
                              border: 'none',
                              borderRadius: '6px',
                              color: index === 0 ? '#4b5563' : '#e4e4e7',
                              width: '26px',
                              height: '26px',
                              cursor: index === 0 ? 'not-allowed' : 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '12px'
                            }}
                          >
                            ▲
                          </button>
                          <button
                            onClick={() => onReordenarCola(index, index + 1)}
                            disabled={index === cola.length - 1}
                            title="Bajar en la fila"
                            style={{
                              background: 'rgba(255, 255, 255, 0.05)',
                              border: 'none',
                              borderRadius: '6px',
                              color: index === cola.length - 1 ? '#4b5563' : '#e4e4e7',
                              width: '26px',
                              height: '26px',
                              cursor: index === cola.length - 1 ? 'not-allowed' : 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '12px'
                            }}
                          >
                            ▼
                          </button>
                          <button
                            onClick={() => onQuitarDeCola(index)}
                            title="Quitar de la fila"
                            style={{
                              background: 'none',
                              border: 'none',
                              borderRadius: '6px',
                              color: '#ef4444',
                              width: '26px',
                              height: '26px',
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontSize: '14px',
                              marginLeft: '2px'
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </div>

          {/* SECCIÓN 3: Siguientes de la lista / biblioteca (Estilo Spotify Oficial) */}
          {siguientesBiblioteca && siguientesBiblioteca.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontSize: '11px', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.8px', color: '#A7A7A7' }}>
                  Siguientes de tu lista ({siguientesBiblioteca.length})
                </span>
                <span style={{ fontSize: '10px', color: '#1ED760' }}>Reproducción continua</span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                {siguientesBiblioteca.slice(0, 15).map((cancion, idx) => (
                  <div
                    key={`sig-${cancion.nombre}-${idx}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      backgroundColor: 'rgba(255, 255, 255, 0.02)',
                      border: '1px solid rgba(255, 255, 255, 0.04)',
                      borderRadius: '12px',
                      padding: '8px 12px',
                      gap: '8px',
                      opacity: 0.88
                    }}
                  >
                    <button
                      onClick={() => onReproducirDirecto && onReproducirDirecto(cancion)}
                      title="Reproducir ahora"
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#71717A',
                        fontSize: '12px',
                        fontWeight: '700',
                        cursor: 'pointer',
                        padding: '4px',
                        display: 'flex',
                        alignItems: 'center'
                      }}
                    >
                      <IconPlay size={13} color="#94A3B8" />
                    </button>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                      {cancion.caratula ? (
                        <img
                          src={cancion.caratula}
                          alt={cancion.nombre}
                          loading="lazy"
                          decoding="async"
                          style={{ width: '36px', height: '36px', borderRadius: '6px', objectFit: 'cover', flexShrink: 0 }}
                        />
                      ) : (
                        <div
                          style={{
                            width: '36px',
                            height: '36px',
                            borderRadius: '6px',
                            backgroundColor: '#1f1f23',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: '#71717A',
                            fontSize: '11px',
                            flexShrink: 0
                          }}
                        >
                          ♫
                        </div>
                      )}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <p style={{ margin: 0, fontSize: '13px', fontWeight: '600', color: '#E4E4E7', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cancion.nombre}
                        </p>
                        <p style={{ margin: '1px 0 0 0', fontSize: '11px', color: '#71717A', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {cancion.artista || 'Artista desconocido'} • {formatearSegundos(cancion.duracion)}
                        </p>
                      </div>
                    </div>

                    {onAgregarACola && (
                      <button
                        onClick={() => onAgregarACola(cancion)}
                        title="Agregar a la fila manual"
                        style={{
                          background: 'rgba(30, 215, 96, 0.1)',
                          border: '1px solid rgba(30, 215, 96, 0.25)',
                          borderRadius: '500px',
                          color: '#1ED760',
                          fontSize: '11px',
                          fontWeight: '700',
                          padding: '4px 10px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}
                      >
                        <span>+ Fila</span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});
