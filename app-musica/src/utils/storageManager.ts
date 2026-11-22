/**
 * Módulo de Salud, Persistencia y Validación de Almacenamiento (Storage Health & Stability)
 * Gestiona cuotas de IndexedDB, persistencia contra limpiezas automáticas del SO
 * y valida el estado de la conexión con el almacenamiento local.
 */
import localforage from 'localforage';

export interface StorageHealthInfo {
  soportado: boolean;
  persistido: boolean;
  usoBytes: number;
  cuotaBytes: number;
  disponibleBytes: number;
  porcentajeUso: number;
  usoLegible: string;
  cuotaLegible: string;
  disponibleLegible: string;
}

export interface StorageConnectionStatus {
  ok: boolean;
  driver: string;
  mensaje: string;
}

/**
 * Convierte un número de bytes a una cadena legible (KB, MB, GB).
 */
export function formatearBytes(bytes: number, decimales: number = 1): string {
  if (!bytes || bytes <= 0 || isNaN(bytes)) return '0 B';
  const k = 1024;
  const dm = decimales < 0 ? 0 : decimales;
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${unidades[i] || 'B'}`;
}

/**
 * Solicita al navegador que marque el almacenamiento como persistente.
 * Esto evita que el sistema operativo o navegador purgue canciones guardadas
 * en IndexedDB cuando el disco del dispositivo esté lleno.
 */
export async function solicitarPersistenciaStorage(): Promise<boolean> {
  if (typeof window === 'undefined' || !navigator.storage || !navigator.storage.persist) {
    console.warn('[StorageManager]: navigator.storage.persist no está disponible en este navegador.');
    return false;
  }

  try {
    const yaPersistido = await navigator.storage.persisted();
    if (yaPersistido) {
      console.log('[StorageManager]: El almacenamiento ya cuenta con persistencia garantizada.');
      return true;
    }

    const concedido = await navigator.storage.persist();
    if (concedido) {
      console.log('[StorageManager]: Persistencia de almacenamiento concedida con éxito.');
    } else {
      console.warn('[StorageManager]: El navegador no concedió persistencia automática.');
    }
    return concedido;
  } catch (error) {
    console.warn('[StorageManager]: Error al solicitar persistencia:', error);
    return false;
  }
}

/**
 * Valida de forma no destructiva la conexión y operatividad de IndexedDB / localforage.
 * Previene fallos silenciosos por cuota excedida o almacenamiento deshabilitado.
 */
export async function validarConexionStorage(): Promise<StorageConnectionStatus> {
  if (typeof window === 'undefined') {
    return { ok: false, driver: 'ninguno', mensaje: 'Entorno no compatible con almacenamiento local' };
  }

  try {
    await localforage.ready();
    const driverActivo = localforage.driver() || 'desconocido';

    // Test rápido no destructivo de lectura/escritura en IndexedDB
    const probeKey = '__probe_db_health__';
    await localforage.setItem(probeKey, Date.now());
    await localforage.removeItem(probeKey);

    return {
      ok: true,
      driver: driverActivo,
      mensaje: `Almacenamiento local operativo (${driverActivo.replace('asyncStorage', 'IndexedDB')})`
    };
  } catch (err: any) {
    console.error('[StorageManager]: Error validando conexión de IndexedDB:', err);
    return {
      ok: false,
      driver: 'error',
      mensaje: `Fallo de conexión en almacenamiento local: ${err?.message || err}`
    };
  }
}

/**
 * Obtiene métricas detalladas del almacenamiento actual (IndexedDB, Caché PWA).
 */
export async function obtenerEstadoAlmacenamiento(): Promise<StorageHealthInfo> {
  const fallback: StorageHealthInfo = {
    soportado: false,
    persistido: false,
    usoBytes: 0,
    cuotaBytes: 0,
    disponibleBytes: 0,
    porcentajeUso: 0,
    usoLegible: 'Desconocido',
    cuotaLegible: 'Desconocido',
    disponibleLegible: 'Desconocido'
  };

  if (typeof window === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
    return fallback;
  }

  try {
    const [estimado, persistido] = await Promise.all([
      navigator.storage.estimate(),
      navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(false)
    ]);

    const uso = estimado.usage || 0;
    const cuota = estimado.quota || 0;
    const disponible = Math.max(0, cuota - uso);
    const porcentaje = cuota > 0 ? parseFloat(((uso / cuota) * 100).toFixed(2)) : 0;

    return {
      soportado: true,
      persistido: Boolean(persistido),
      usoBytes: uso,
      cuotaBytes: cuota,
      disponibleBytes: disponible,
      porcentajeUso: porcentaje,
      usoLegible: formatearBytes(uso),
      cuotaLegible: formatearBytes(cuota),
      disponibleLegible: formatearBytes(disponible)
    };
  } catch (error) {
    console.warn('[StorageManager]: Error al estimar cuota de almacenamiento:', error);
    return { ...fallback, soportado: true };
  }
}
