import { Capacitor } from '@capacitor/core';
import { LiveUpdate } from '@capawesome/capacitor-live-update';
import { obtenerUrlApi, fetchConTimeout } from './apiConfig';

export const APP_OTA_VERSION = '5.2.0';

export type EstadoOta = 'idle' | 'checking' | 'actualizada' | 'descargando' | 'error';

export interface ResultadoOta {
  estado: EstadoOta;
  mensaje: string;
  versionRemota?: string;
}

interface VersionManifest {
  version?: string;
  bundleUrl?: string;
  notes?: string;
}

function compararVersiones(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va > vb) return 1;
    if (va < vb) return -1;
  }
  return 0;
}

/**
 * Confirma al plugin nativo que el bundle actual arrancó correctamente
 * para evitar rollbacks automáticos. No falla en web ni offline.
 */
export async function notificarOtaLista(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await LiveUpdate.ready();
  } catch (err) {
    console.warn('[OTA]: Aviso en LiveUpdate.ready():', err);
  }
}

/**
 * Revisa actualizaciones OTA contra /api/ota/version.json (con .zip en GitHub Releases).
 * Si no hay internet o Render está dormido, en modo silencioso no interrumpe el arranque offline.
 */
export async function revisarActualizacionOta(opciones?: {
  silencioso?: boolean;
  onEstado?: (estado: EstadoOta, mensaje: string) => void;
}): Promise<ResultadoOta> {
  const silencioso = opciones?.silencioso !== false;
  const emitir = (estado: EstadoOta, mensaje: string): ResultadoOta => {
    opciones?.onEstado?.(estado, mensaje);
    return { estado, mensaje };
  };

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    if (silencioso) {
      return { estado: 'idle', mensaje: 'Modo offline' };
    }
    return emitir('error', 'Error: sin conexión a internet.');
  }

  emitir('checking', 'Buscando actualización...');

  try {
    const urlManifest = obtenerUrlApi('/api/ota/version.json');
    if (!urlManifest) {
      if (silencioso) return { estado: 'idle', mensaje: 'Sin URL de servidor' };
      return emitir('error', 'Error: servidor de actualizaciones no configurado.');
    }

    const res = await fetchConTimeout(urlManifest, { method: 'GET' }, 5000);
    if (!res.ok) {
      if (silencioso) return { estado: 'idle', mensaje: 'Servidor no disponible' };
      return emitir('error', 'Error: no se pudo consultar la versión.');
    }

    const manifest = (await res.json()) as VersionManifest;
    const versionRemota = (manifest?.version || '').trim();
    const bundleUrl = (manifest?.bundleUrl || '').trim();

    if (!versionRemota) {
      return emitir('actualizada', `Actualizada (${APP_OTA_VERSION})`);
    }

    // En Capacitor nativo, comparar contra el bundleId activo si existe
    let versionLocal = APP_OTA_VERSION;
    if (Capacitor.isNativePlatform()) {
      try {
        const current = await LiveUpdate.getCurrentBundle();
        if (current?.bundleId) {
          versionLocal = current.bundleId;
        }
      } catch (_) {}
    }

    const hayNueva = compararVersiones(versionRemota, versionLocal) > 0;
    if (!hayNueva || !bundleUrl) {
      return emitir('actualizada', `Actualizada (v${versionLocal})`);
    }

    if (Capacitor.isNativePlatform()) {
      emitir('descargando', `Descargando v${versionRemota}...`);
      await LiveUpdate.downloadBundle({
        bundleId: versionRemota,
        url: bundleUrl,
        artifactType: 'zip'
      });
      await LiveUpdate.setNextBundle({ bundleId: versionRemota });
      await LiveUpdate.reload();
      return {
        estado: 'descargando',
        mensaje: `Descargando v${versionRemota}...`,
        versionRemota
      };
    }

    // En PWA / navegador: actualizar Service Worker si hay uno nuevo
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        await reg.update();
      }
    }

    return emitir('actualizada', `Actualizada (v${versionLocal})`);
  } catch (err: any) {
    if (silencioso) {
      return { estado: 'idle', mensaje: 'Offline o servidor dormido' };
    }
    return emitir('error', `Error: ${err?.message || 'no se pudo actualizar'}`);
  }
}
