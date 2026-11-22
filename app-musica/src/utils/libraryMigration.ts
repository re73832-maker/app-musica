import localforage from 'localforage';

export const MIGRATION_VERSION_KEY = 'app_musica_migration_v1_done';
export const BACKUP_STORAGE_KEY = 'app_musica_backup_pre_v1';
export const BACKUP_FILE_EXPORTED_KEY = 'app_musica_backup_file_exported_v1';

export interface SongVerificationFields {
  verified: boolean;
  sourceVersion: string;
  durationExpected?: number;
  durationActual: number;
  flagReason?: string;
}

export interface BackupSongMetadata {
  nombre: string;
  artista?: string;
  duracion: number;
  tamano: number;
  favorito: boolean;
  fecha?: number;
  origen?: string;
  verified?: boolean;
  sourceVersion?: string;
  durationExpected?: number;
  durationActual?: number;
  flagReason?: string;
}

export interface MigrationBackupResult {
  ok: boolean;
  verified: boolean;
  count: number;
  fileExported: boolean;
  nativeSaved: boolean;
  error?: string;
}

export interface MigrationRunResult {
  skipped: boolean;
  migrated: number;
  total: number;
  backup: MigrationBackupResult;
  updatedMetadata?: any[];
}

const PREFIJOS_NO_CANCION = [
  'app_',
  'lyrics_',
  'probe_',
  'cache_',
  'temp_',
  'stream_',
  'catalogo_metadatos_ligero'
];

export function esClaveCancionValida(clave: string): boolean {
  if (!clave || typeof clave !== 'string') return false;
  return !PREFIJOS_NO_CANCION.some((p) => clave === p || clave.startsWith(p));
}

/**
 * Detecta patrones comunes de covers, versiones aceleradas/ralentizadas o videoclips con intro.
 */
export function detectarSospechaInicial(nombre: string, artista?: string): string | undefined {
  const texto = `${nombre || ''} ${artista || ''}`.toLowerCase();
  if (!texto.trim()) return undefined;

  if (/\b(sped\s*up|speed\s*up|nightcore)\b/.test(texto)) {
    return 'Posible versión acelerada';
  }
  if (/\b(slowed|reverb|chopped|screwed)\b/.test(texto)) {
    return 'Posible versión ralentizada / editada';
  }
  if (/\b(cover|tributo|tribute|karaoke|instrumental)\b/.test(texto)) {
    return 'Posible cover o versión no original';
  }
  if (/\b(official\s*video|video\s*oficial|videoclip|music\s*video|con\s*intro)\b/.test(texto)) {
    return 'Posible videoclip con intro hablado';
  }
  if (/\b(en\s*vivo|live\s*at|live\s*session|concierto)\b/.test(texto)) {
    return 'Posible grabación en vivo';
  }
  return undefined;
}

export function esCancionParaRevisar(cancion: { verified?: boolean; flagReason?: string }): boolean {
  return cancion.verified !== true || Boolean(cancion.flagReason);
}

/**
 * Descarga un archivo JSON de respaldo con la lista de canciones (solo metadatos, sin Blobs).
 * Retorna true si el Blob se generó y su tamaño fue verificado.
 */
export function descargarArchivoRespaldoBiblioteca(
  canciones: BackupSongMetadata[],
  nombreArchivo?: string
): { ok: boolean; bytes: number } {
  try {
    const payload = {
      app: 'APP_Musica',
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      totalCanciones: canciones.length,
      canciones
    };
    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
    if (!blob || blob.size === 0) {
      return { ok: false, bytes: 0 };
    }

    if (typeof document !== 'undefined') {
      const fecha = new Date().toISOString().slice(0, 10);
      const filename = nombreArchivo || `app-musica-respaldo-pre-migracion-${fecha}.json`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (document.body.contains(a)) document.body.removeChild(a);
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      }, 4000);
    }

    return { ok: true, bytes: blob.size };
  } catch (err) {
    console.warn('[Migración]: Error generando archivo JSON de respaldo:', err);
    return { ok: false, bytes: 0 };
  }
}

/**
 * Crea un respaldo de la lista de canciones en localStorage, archivo JSON descargable
 * (y almacenamiento nativo si está disponible), verificando su escritura antes de migrar.
 */
export async function exportarYVerificarRespaldoPreMigracion(): Promise<MigrationBackupResult> {
  try {
    await localforage.ready();
    const todasLasClaves = await localforage.keys();
    const clavesCanciones = todasLasClaves.filter(esClaveCancionValida);

    if (clavesCanciones.length === 0) {
      return {
        ok: true,
        verified: true,
        count: 0,
        fileExported: false,
        nativeSaved: false
      };
    }

    const listaRespaldo: BackupSongMetadata[] = [];
    const BATCH = 10;
    for (let i = 0; i < clavesCanciones.length; i += BATCH) {
      const lote = clavesCanciones.slice(i, i + BATCH);
      const resultados = await Promise.all(
        lote.map(async (clave): Promise<BackupSongMetadata | null> => {
          try {
            const val: any = await localforage.getItem(clave);
            if (!val) return null;
            if (val instanceof Blob) {
              return {
                nombre: clave,
                duracion: 0,
                tamano: val.size,
                favorito: false,
                origen: 'legacy_blob'
              };
            }
            if (typeof val === 'object') {
              return {
                nombre: val.nombre || clave,
                artista: val.artista,
                duracion: Number(val.duracion) || 0,
                tamano: Number(val.tamano) || (val.blob instanceof Blob ? val.blob.size : 0),
                favorito: Boolean(val.favorito),
                fecha: val.fecha,
                origen: val.origen,
                verified: val.verified,
                sourceVersion: val.sourceVersion,
                durationExpected: val.durationExpected,
                durationActual: val.durationActual,
                flagReason: val.flagReason
              };
            }
            return null;
          } catch {
            return null;
          }
        })
      );
      for (const item of resultados) {
        if (item) listaRespaldo.push(item);
      }
    }

    const jsonStr = JSON.stringify({
      version: 1,
      createdAt: new Date().toISOString(),
      totalCanciones: listaRespaldo.length,
      canciones: listaRespaldo
    });

    // 1. Guardar y verificar en localStorage
    localStorage.setItem(BACKUP_STORAGE_KEY, jsonStr);
    const leidoLocalStorage = localStorage.getItem(BACKUP_STORAGE_KEY);
    if (!leidoLocalStorage || leidoLocalStorage !== jsonStr) {
      return {
        ok: false,
        verified: false,
        count: listaRespaldo.length,
        fileExported: false,
        nativeSaved: false,
        error: 'No se pudo verificar la escritura del respaldo en localStorage.'
      };
    }

    // 2. Si existe puente nativo Android, guardar respaldo JSON físico y verificar lectura
    let nativeSaved = false;
    if (typeof window !== 'undefined' && window.AndroidAppMusica?.guardarRespaldoJSON) {
      try {
        const guardado = window.AndroidAppMusica.guardarRespaldoJSON(jsonStr);
        if (guardado && window.AndroidAppMusica.leerRespaldoJSON) {
          const leidoNativo = window.AndroidAppMusica.leerRespaldoJSON();
          const parsedNativo = leidoNativo ? JSON.parse(leidoNativo) : null;
          if (parsedNativo && Array.isArray(parsedNativo.canciones) && parsedNativo.canciones.length === listaRespaldo.length) {
            nativeSaved = true;
          }
        }
      } catch (eNativo) {
        console.warn('[Migración]: Aviso guardando respaldo nativo:', eNativo);
      }
    }

    // 3. Exportar archivo JSON descargable (una vez por versión) y verificar Blob
    let fileExported = localStorage.getItem(BACKUP_FILE_EXPORTED_KEY) === 'true';
    if (!fileExported) {
      const exportRes = descargarArchivoRespaldoBiblioteca(listaRespaldo);
      if (exportRes.ok && exportRes.bytes > 0) {
        fileExported = true;
        localStorage.setItem(BACKUP_FILE_EXPORTED_KEY, 'true');
      }
    }

    if (!fileExported && !nativeSaved) {
      return {
        ok: false,
        verified: false,
        count: listaRespaldo.length,
        fileExported: false,
        nativeSaved: false,
        error: 'No se pudo verificar la exportación del archivo JSON de respaldo.'
      };
    }

    return {
      ok: true,
      verified: true,
      count: listaRespaldo.length,
      fileExported,
      nativeSaved
    };
  } catch (err: any) {
    return {
      ok: false,
      verified: false,
      count: 0,
      fileExported: false,
      nativeSaved: false,
      error: err?.message || String(err)
    };
  }
}

/**
 * Agrega los campos de verificación a todas las canciones existentes en IndexedDB
 * sin borrar ninguna canción ni perder Blobs. Es idempotente.
 */
export async function migrarBibliotecaIndexedDB(): Promise<MigrationRunResult> {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem(MIGRATION_VERSION_KEY) === 'true') {
      return {
        skipped: true,
        migrated: 0,
        total: 0,
        backup: { ok: true, verified: true, count: 0, fileExported: true, nativeSaved: false }
      };
    }

    const backup = await exportarYVerificarRespaldoPreMigracion();
    if (!backup.ok || !backup.verified) {
      console.error('[Migración]: Abortada porque falló la verificación del respaldo:', backup.error);
      return {
        skipped: true,
        migrated: 0,
        total: backup.count,
        backup
      };
    }

    await localforage.ready();
    const todasLasClaves = await localforage.keys();
    const clavesCanciones = todasLasClaves.filter(esClaveCancionValida);

    let migrated = 0;
    const updatedMetadata: any[] = [];
    const BATCH = 5;

    for (let i = 0; i < clavesCanciones.length; i += BATCH) {
      const lote = clavesCanciones.slice(i, i + BATCH);
      await Promise.all(
        lote.map(async (clave) => {
          try {
            const valor: any = await localforage.getItem(clave);
            if (!valor) return;

            let actualizado: any;
            let requiereEscritura = false;

            if (valor instanceof Blob) {
              actualizado = {
                nombre: clave,
                blob: valor,
                tamano: valor.size,
                duracion: 0,
                favorito: false,
                fecha: Date.now(),
                descargada: true,
                origen: 'descarga',
                verified: false,
                sourceVersion: 'legacy_blob',
                durationActual: 0,
                flagReason: detectarSospechaInicial(clave)
              };
              requiereEscritura = true;
            } else if (typeof valor === 'object') {
              const durActual =
                typeof valor.durationActual === 'number'
                  ? valor.durationActual
                  : Number(valor.duracion) || 0;
              const verified = typeof valor.verified === 'boolean' ? valor.verified : false;
              const sourceVersion =
                typeof valor.sourceVersion === 'string' && valor.sourceVersion.trim()
                  ? valor.sourceVersion
                  : valor.origen || 'legacy_indexeddb';
              const durationExpected =
                typeof valor.durationExpected === 'number' ? valor.durationExpected : undefined;
              const flagReason =
                typeof valor.flagReason === 'string' && valor.flagReason.trim()
                  ? valor.flagReason
                  : !verified
                  ? detectarSospechaInicial(valor.nombre || clave, valor.artista)
                  : undefined;

              if (
                typeof valor.verified !== 'boolean' ||
                typeof valor.sourceVersion !== 'string' ||
                typeof valor.durationActual !== 'number' ||
                (flagReason && valor.flagReason !== flagReason)
              ) {
                requiereEscritura = true;
              }

              actualizado = {
                ...valor,
                nombre: valor.nombre || clave,
                verified,
                sourceVersion,
                durationActual: durActual,
                ...(durationExpected !== undefined ? { durationExpected } : {}),
                ...(flagReason ? { flagReason } : {})
              };
            } else {
              return;
            }

            if (requiereEscritura) {
              await localforage.setItem(clave, actualizado);
              migrated++;
            }

            // Extraer versión ligera sin Blob para sincronizar UI/catálogo
            const { blob: _omitBlob, ...metaSinBlob } = actualizado;
            updatedMetadata.push({
              ...metaSinBlob,
              tamano:
                actualizado.tamano ||
                (actualizado.blob instanceof Blob ? actualizado.blob.size : 0),
              duracion: actualizado.duracion ?? actualizado.durationActual ?? 0
            });
          } catch (errItem) {
            console.warn(`[Migración]: Error procesando "${clave}":`, errItem);
          }
        })
      );

      // Pausa breve para mantener fluida la UI en WebView
      await new Promise((r) => setTimeout(r, 30));
    }

    localStorage.setItem(MIGRATION_VERSION_KEY, 'true');

    return {
      skipped: false,
      migrated,
      total: clavesCanciones.length,
      backup,
      updatedMetadata
    };
  } catch (err: any) {
    console.error('[Migración]: Error general en migración:', err);
    return {
      skipped: true,
      migrated: 0,
      total: 0,
      backup: {
        ok: false,
        verified: false,
        count: 0,
        fileExported: false,
        nativeSaved: false,
        error: err?.message || String(err)
      }
    };
  }
}
