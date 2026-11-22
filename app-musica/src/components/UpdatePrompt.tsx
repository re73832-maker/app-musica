import React, { useState, useEffect } from 'react';

export const UpdatePrompt: React.FC<{
  reproduciendo?: boolean;
  forzarBanner?: boolean;
  onActualizarClick?: () => void;
}> = ({ forzarBanner = false, onActualizarClick }) => {
  const [hayActualizacion, setHayActualizacion] = useState(false);
  const [descartado, setDescartado] = useState(false);
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (forzarBanner) {
      setHayActualizacion(true);
    }
  }, [forzarBanner]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    const inspeccionarRegistro = (reg: ServiceWorkerRegistration) => {
      // 1. Ya hay un worker esperando
      if (reg.waiting) {
        setWaitingWorker(reg.waiting);
        setHayActualizacion(true);
        return;
      }

      // 2. Se está instalando un nuevo worker
      reg.addEventListener('updatefound', () => {
        const nuevoWorker = reg.installing;
        if (!nuevoWorker) return;

        nuevoWorker.addEventListener('statechange', () => {
          if (
            (nuevoWorker.state === 'installed' || nuevoWorker.state === 'activated') &&
            navigator.serviceWorker.controller
          ) {
            setWaitingWorker(nuevoWorker);
            setHayActualizacion(true);
          }
        });
      });
    };

    // Consultar registro actual al montar
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) {
        inspeccionarRegistro(reg);
        // Forzar chequeo de actualización al iniciar la app solo si hay conexión
        if (typeof navigator !== 'undefined' && navigator.onLine) {
          reg.update().catch(() => {});
        }
      }
    });

    // Consultar periódicamente cada 45 segundos en segundo plano si hay conexión
    const intervalTimer = setInterval(() => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) return;
      navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg) {
          inspeccionarRegistro(reg);
          reg.update().catch(() => {});
        }
      });
    }, 45000);

    // Consultar actualizaciones al cambiar de pestaña o volver a primer plano
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && typeof navigator !== 'undefined' && navigator.onLine) {
        navigator.serviceWorker.getRegistration().then((reg) => {
          if (reg) {
            inspeccionarRegistro(reg);
            reg.update().catch(() => {});
          }
        });
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      clearInterval(intervalTimer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  const handleActualizar = async () => {
    if (onActualizarClick) {
      onActualizarClick();
      return;
    }

    // 1. Limpiar CacheStorage para garantizar que el nuevo Service Worker descargue assets frescos
    if (typeof window !== 'undefined' && 'caches' in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (_) {}
    }

    // 2. Notificar al Service Worker en espera para que tome el control
    if (waitingWorker) {
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } else {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg?.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        } else {
          window.location.reload();
          return;
        }
      } catch (_) {
        window.location.reload();
        return;
      }
    }

    // 3. Fallback de recarga segura si controllerchange no se dispara inmediatamente
    setTimeout(() => {
      window.location.reload();
    }, 300);
  };

  if (!hayActualizacion || descartado) return null;

  return (
    <div
      onClick={handleActualizar}
      style={{
        position: 'fixed',
        top: '16px',
        left: '50%',
        transform: 'translateX(-50%) translateZ(0)',
        WebkitTransform: 'translateX(-50%) translateZ(0)',
        willChange: 'transform',
        zIndex: 10100,
        backgroundColor: '#181818',
        border: '1px solid #1ED760',
        borderRadius: '500px',
        padding: '8px 14px 8px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        boxShadow: '0 12px 36px rgba(0,0,0,0.9), 0 0 18px rgba(30, 215, 96, 0.25)',
        maxWidth: '92%',
        width: 'max-content',
        cursor: 'pointer',
        animation: 'slideDownPrompt 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: '#1ED760',
            boxShadow: '0 0 10px #1ED760'
          }}
        />
        <span
          style={{
            color: '#FFFFFF',
            fontSize: '12.5px',
            fontWeight: '700',
            letterSpacing: '-0.2px',
            whiteSpace: 'nowrap'
          }}
        >
          ✨ Nueva versión disponible — Tocar para actualizar
        </span>
      </div>

      <button
        onClick={(e) => {
          e.stopPropagation();
          handleActualizar();
        }}
        style={{
          backgroundColor: '#1ED760',
          color: '#000000',
          border: 'none',
          borderRadius: '500px',
          padding: '5px 12px',
          fontSize: '11.5px',
          fontWeight: '800',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
          transition: 'transform 0.15s ease, background-color 0.15s ease'
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = '#1fdf64';
          e.currentTarget.style.transform = 'scale(1.04)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = '#1ED760';
          e.currentTarget.style.transform = 'scale(1)';
        }}
      >
        Actualizar
      </button>

      <button
        onClick={(e) => {
          e.stopPropagation();
          setDescartado(true);
        }}
        title="Descartar por ahora"
        style={{
          backgroundColor: 'transparent',
          color: '#B3B3B3',
          border: 'none',
          fontSize: '14px',
          cursor: 'pointer',
          padding: '4px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
          transition: 'color 0.15s ease'
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = '#FFFFFF')}
        onMouseLeave={(e) => (e.currentTarget.style.color = '#B3B3B3')}
      >
        ✕
      </button>

      <style>{`
        @keyframes slideDownPrompt {
          from {
            opacity: 0;
            transform: translate(-50%, -20px);
          }
          to {
            opacity: 1;
            transform: translate(-50%, 0);
          }
        }
      `}</style>
    </div>
  );
};
