import React, { useState, useEffect, useRef } from 'react';
import { useDebounce } from '../utils/useDebounce';
import { IconBuscar, IconPlay, IconSpinner } from './SpotifyIcons';
import { obtenerUrlApi, fetchJsonSeguro } from '../utils/apiConfig';

export interface SugerenciaItem {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string;
  seconds: number;
}

interface SearchSuggestionsProps {
  busqueda: string;
  visible: boolean;
  onSeleccionarTexto: (termino: string) => void;
  onSeleccionarPista?: (item: SugerenciaItem) => void;
  onCerrar: () => void;
}

export const SearchSuggestions: React.FC<SearchSuggestionsProps> = React.memo(({
  busqueda,
  visible,
  onSeleccionarTexto,
  onSeleccionarPista,
  onCerrar
}) => {
  const debouncedQuery = useDebounce(busqueda.trim(), 300);
  const [sugerencias, setSugerencias] = useState<SugerenciaItem[]>([]);
  const [cargando, setCargando] = useState<boolean>(false);
  const contenedorRef = useRef<HTMLDivElement | null>(null);

  // Escuchar clics fuera para cerrar sugerencias
  useEffect(() => {
    const handleClickAfuera = (e: MouseEvent) => {
      if (contenedorRef.current && !contenedorRef.current.contains(e.target as Node)) {
        onCerrar();
      }
    };

    if (visible) {
      document.addEventListener('mousedown', handleClickAfuera);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickAfuera);
    };
  }, [visible, onCerrar]);

  // Consulta reactiva cuando el término con debounce cambia
  useEffect(() => {
    if (!debouncedQuery || debouncedQuery.length < 2) {
      setSugerencias([]);
      setCargando(false);
      return;
    }

    let cancelado = false;
    const abortController = new AbortController();

    const fetchSugerencias = async () => {
      setCargando(true);
      try {
        let items: SugerenciaItem[] = [];
        const urlApi = obtenerUrlApi(`/api/buscar-canciones?q=${encodeURIComponent(debouncedQuery)}`);

        // 1. Si hay endpoint de backend disponible
        if (urlApi) {
          try {
            const data = await fetchJsonSeguro<{ resultados?: any[] }>(urlApi, {
              signal: abortController.signal
            });
            if (data && Array.isArray(data.resultados)) {
              items = data.resultados.slice(0, 5);
            }
          } catch (_) {}
        }

        // 2. Si no hay backend o no devolvió resultados, usar sugerencias rápidas de iTunes
        if (items.length === 0 && !cancelado) {
          try {
            const itunesData = await fetchJsonSeguro<{ results?: any[] }>(
              `https://itunes.apple.com/search?term=${encodeURIComponent(debouncedQuery)}&media=music&entity=song&limit=5`,
              { signal: abortController.signal }
            );
            if (itunesData && Array.isArray(itunesData.results)) {
              items = itunesData.results.map((item: any) => ({
                videoId: `itunes_${item.trackId}`,
                title: item.trackName || '',
                artist: item.artistName || '',
                thumbnail: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
                seconds: Math.round((item.trackTimeMillis || 0) / 1000)
              }));
            }
          } catch (_) {}
        }

        if (!cancelado) {
          setSugerencias(items);
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') {
          console.warn('[SearchSuggestions]: Error obteniendo sugerencias:', err);
        }
      } finally {
        if (!cancelado) setCargando(false);
      }
    };

    fetchSugerencias();

    return () => {
      cancelado = true;
      abortController.abort();
    };
  }, [debouncedQuery]);

  if (!visible || !busqueda.trim() || (sugerencias.length === 0 && !cargando)) {
    return null;
  }

  return (
    <div
      ref={contenedorRef}
      style={{
        position: 'absolute',
        top: 'calc(100% + 6px)',
        left: 0,
        right: 0,
        backgroundColor: '#1c1c1f',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        borderRadius: '16px',
        boxShadow: '0 12px 35px rgba(0, 0, 0, 0.75)',
        zIndex: 100,
        overflow: 'hidden',
        transform: 'translateZ(0)',
        WebkitTransform: 'translateZ(0)'
      }}
    >
      <div style={{ padding: '8px 14px 4px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.8px', color: '#71717A' }}>
          Sugerencias rápidas
        </span>
        {cargando && <IconSpinner size={13} color="#1ED760" />}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', padding: '4px 6px 8px 6px' }}>
        {sugerencias.map((item) => (
          <div
            key={item.videoId}
            onClick={() => {
              if (onSeleccionarPista) {
                onSeleccionarPista(item);
              } else {
                onSeleccionarTexto(item.title);
              }
              onCerrar();
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 10px',
              borderRadius: '10px',
              cursor: 'pointer',
              gap: '10px',
              transition: 'background-color 0.12s ease'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
              {item.thumbnail ? (
                <img
                  src={item.thumbnail}
                  alt={item.title}
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
                    backgroundColor: '#27272a',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#9CA3AF',
                    fontSize: '12px',
                    flexShrink: 0
                  }}
                >
                  <IconBuscar size={14} color="#A1A1AA" />
                </div>
              )}

              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: '600', color: '#F4F4F5', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.title}
                </p>
                <p style={{ margin: '1px 0 0 0', fontSize: '11px', color: '#A1A1AA', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.artist || 'Artista'}
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0, color: '#1ED760' }}>
              <IconPlay size={13} color="#1ED760" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});
