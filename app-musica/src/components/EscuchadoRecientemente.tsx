import React from 'react';
import type { Pista } from '../utils/useHistorialEscucha';
import { IconPlay, SpotifyEqualizer } from './SpotifyIcons';

export interface EscuchadoRecientementeProps {
  historial: Pista[];
  cancionActualNombre?: string;
  reproduciendo?: boolean;
  onReproducirCancion?: (pista: Pista) => void;
  onSeleccionar?: (pista: Pista) => void;
  onLimpiar?: () => void;
}

export const EscuchadoRecientemente: React.FC<EscuchadoRecientementeProps> = React.memo(({
  historial,
  cancionActualNombre,
  reproduciendo = false,
  onReproducirCancion,
  onSeleccionar,
  onLimpiar
}) => {
  if (!historial || historial.length === 0) return null;

  const handleItemClick = (item: Pista) => {
    if (onReproducirCancion) {
      onReproducirCancion(item);
    } else if (onSeleccionar) {
      onSeleccionar(item);
    }
  };

  return (
    <div style={{ margin: '20px 0 24px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', padding: '0 4px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <span style={{ fontSize: '18px' }}>🕒</span>
          <h2 style={{ fontSize: '18px', fontWeight: '800', color: '#FFFFFF', margin: 0, letterSpacing: '-0.3px' }}>
            Escuchado recientemente
          </h2>
        </div>
        {onLimpiar && (
          <button
            onClick={onLimpiar}
            title="Vaciar historial de reproducción"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#71717a',
              fontSize: '11px',
              fontWeight: '600',
              cursor: 'pointer',
              padding: '4px 8px',
              transition: 'color 0.2s ease'
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = '#ef4444')}
            onMouseLeave={(e) => (e.currentTarget.style.color = '#71717a')}
          >
            Vaciar historial
          </button>
        )}
      </div>

      {/* Carrusel horizontal scrolleable estilo Spotify */}
      <div
        style={{
          display: 'flex',
          gap: '12px',
          overflowX: 'auto',
          paddingBottom: '8px',
          scrollSnapType: 'x mandatory',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none',
          msOverflowStyle: 'none'
        }}
      >
        {historial.map((item, index) => {
          const esActual =
            cancionActualNombre &&
            cancionActualNombre.toLowerCase().trim() === item.nombre.toLowerCase().trim();

          return (
            <div
              key={`${item.nombre}-${index}`}
              onClick={() => handleItemClick(item)}
              style={{
                flex: '0 0 136px',
                width: '136px',
                backgroundColor: esActual ? 'rgba(30, 215, 96, 0.12)' : 'rgba(255, 255, 255, 0.04)',
                border: esActual ? '1px solid rgba(30, 215, 96, 0.4)' : '1px solid rgba(255, 255, 255, 0.07)',
                borderRadius: '12px',
                padding: '10px',
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                scrollSnapAlign: 'start',
                position: 'relative',
                transition: 'transform 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-3px)';
                e.currentTarget.style.backgroundColor = esActual ? 'rgba(30, 215, 96, 0.18)' : 'rgba(255, 255, 255, 0.08)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.backgroundColor = esActual ? 'rgba(30, 215, 96, 0.12)' : 'rgba(255, 255, 255, 0.04)';
              }}
            >
              {/* Carátula Cuadrada */}
              <div
                style={{
                  width: '100%',
                  aspectRatio: '1/1',
                  borderRadius: '8px',
                  backgroundColor: '#242424',
                  overflow: 'hidden',
                  position: 'relative',
                  marginBottom: '8px'
                }}
              >
                {item.caratula ? (
                  <img
                    src={item.caratula}
                    alt={item.nombre}
                    loading="lazy"
                    decoding="async"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '26px',
                      color: '#52525b'
                    }}
                  >
                    🎵
                  </div>
                )}

                {/* Badge flotante de reproducción */}
                <div
                  style={{
                    position: 'absolute',
                    right: '6px',
                    bottom: '6px',
                    width: '32px',
                    height: '32px',
                    borderRadius: '50%',
                    backgroundColor: '#1ED760',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.6)',
                    opacity: esActual ? 1 : 0.88,
                    transition: 'transform 0.15s ease, opacity 0.15s ease'
                  }}
                >
                  {esActual && reproduciendo ? (
                    <SpotifyEqualizer animando={true} color="#000000" />
                  ) : (
                    <IconPlay size={13} color="#000000" style={{ marginLeft: '2px' }} />
                  )}
                </div>
              </div>

              {/* Título en negrita */}
              <p
                style={{
                  margin: '0 0 3px 0',
                  fontSize: '13px',
                  fontWeight: '700',
                  color: esActual ? '#1ED760' : '#FFFFFF',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
                title={item.nombre}
              >
                {item.nombre}
              </p>

              {/* Artista abajo en gris */}
              <p
                style={{
                  margin: 0,
                  fontSize: '11px',
                  color: '#A1A1AA',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap'
                }}
                title={item.artista || 'Desconocido'}
              >
                {item.artista || 'Artista'}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
});
