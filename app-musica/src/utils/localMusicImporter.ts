import localforage from 'localforage';
import { parseBlob } from 'music-metadata';
import {
  esAlmacenamientoNativoDisponible,
  blindarCancionEnMemoriaFisica
} from './persistentStorageBridge';

export interface CancionImportableBase {
  nombre: string;
  artista?: string;
  duracion: number;
}

export interface CancionImportadaResultado {
  nombre: string;
  blob?: Blob;
  tamano: number;
  duracion: number;
  favorito: boolean;
  fecha: number;
  caratula?: string;
  artista?: string;
  album?: string;
  exportada: boolean;
  descargada: boolean;
  origen: 'local_importada';
  verified: true;
  sourceVersion: 'importado';
  durationActual: number;
}

export interface ProgresoImportacion {
  actual: number;
  total: number;
  archivo: string;
}

export interface ResumenImportacion {
  importadas: CancionImportadaResultado[];
  duplicadas: number;
  errores: number;
  copiadasNativo: number;
}

const EXTENSIONES_PERMITIDAS = /\.(mp3|m4a|flac|ogg|wav)$/i;

function normalizarTexto(str?: string): string {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function limpiarNombreArchivo(nombreArchivo: string): string {
  return nombreArchivo.replace(/\.[^/.]+$/, '').trim() || 'Pista sin título';
}

function obtenerDuracionFallbackAudio(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    if (typeof Audio === 'undefined' || !blob || blob.size === 0) {
      resolve(0);
      return;
    }
    let url = '';
    let settled = false;
    const audio = new Audio();
    const timer = window.setTimeout(() => {
      if (!settled) {
        settled = true;
        if (url) URL.revokeObjectURL(url);
        resolve(0);
      }
    }, 5000);

    const finish = (dur: number) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
      resolve(isFinite(dur) && dur > 0 ? Math.round(dur) : 0);
    };

    try {
      url = URL.createObjectURL(blob);
      audio.preload = 'metadata';
      audio.onloadedmetadata = () => finish(audio.duration);
      audio.onerror = () => finish(0);
      audio.src = url;
    } catch {
      finish(0);
    }
  });
}

function pictureADataUrl(data: Uint8Array, format?: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      const safeBytes = new Uint8Array(data.byteLength);
      safeBytes.set(data);
      const blob = new Blob([safeBytes.buffer], { type: format || 'image/jpeg' });
      const reader = new FileReader();
      reader.onloadend = () => {
        resolve(typeof reader.result === 'string' ? reader.result : undefined);
      };
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    } catch {
      resolve(undefined);
    }
  });
}

export function esDuplicadoEnBiblioteca(
  titulo: string,
  artista: string | undefined,
  duracion: number,
  existentes: CancionImportableBase[]
): boolean {
  const tNorm = normalizarTexto(titulo);
  const aNorm = normalizarTexto(artista);

  return existentes.some((c) => {
    const ct = normalizarTexto(c.nombre);
    if (ct !== tNorm) return false;

    const ca = normalizarTexto(c.artista);
    const artistaCoincide = !aNorm || !ca || ca === aNorm;
    if (!artistaCoincide) return false;

    if (duracion > 0 && c.duracion > 0) {
      return Math.abs(duracion - c.duracion) <= 3;
    }
    return true;
  });
}

/**
 * Importa archivos de audio locales (MP3, M4A, FLAC, OGG, WAV) leyendo sus metadatos,
 * detectando duplicados y copiando a /Music/AppMusica/ cuando el puente nativo está disponible.
 */
export async function importarArchivosMusicaPropia(
  archivos: File[],
  bibliotecaActual: CancionImportableBase[],
  onProgreso?: (progreso: ProgresoImportacion) => void
): Promise<ResumenImportacion> {
  const validos = archivos.filter(
    (f) => EXTENSIONES_PERMITIDAS.test(f.name) || (f.type && f.type.startsWith('audio/'))
  );

  const importadas: CancionImportadaResultado[] = [];
  const acumulados: CancionImportableBase[] = [...bibliotecaActual];
  let duplicadas = 0;
  let errores = 0;
  let copiadasNativo = 0;

  for (let i = 0; i < validos.length; i++) {
    const file = validos[i];
    onProgreso?.({ actual: i + 1, total: validos.length, archivo: file.name });

    try {
      let titulo = limpiarNombreArchivo(file.name);
      let artista: string | undefined;
      let album: string | undefined;
      let caratula: string | undefined;
      let duracion = 0;

      try {
        const meta = await parseBlob(file, { duration: true });
        if (meta.common.title && meta.common.title.trim()) {
          titulo = meta.common.title.trim();
        }
        if (meta.common.artist && meta.common.artist.trim()) {
          artista = meta.common.artist.trim();
        }
        if (meta.common.album && meta.common.album.trim()) {
          album = meta.common.album.trim();
        }
        if (typeof meta.format.duration === 'number' && meta.format.duration > 0) {
          duracion = Math.round(meta.format.duration);
        }
        if (meta.common.picture && meta.common.picture.length > 0) {
          const pic = meta.common.picture[0];
          if (pic && pic.data && pic.data.length > 0 && pic.data.length <= 2 * 1024 * 1024) {
            caratula = await pictureADataUrl(pic.data, pic.format);
          }
        }
      } catch (metaErr) {
        console.warn(`[Importador]: Metadatos parciales para "${file.name}":`, metaErr);
      }

      if (duracion <= 0) {
        duracion = await obtenerDuracionFallbackAudio(file);
      }

      if (esDuplicadoEnBiblioteca(titulo, artista, duracion, acumulados)) {
        duplicadas++;
        continue;
      }

      // Evitar colisión accidental de clave en localforage si el título coincide con distinta duración/artista
      let claveFinal = titulo;
      const yaEnDb = await localforage.getItem(claveFinal);
      if (yaEnDb && artista) {
        claveFinal = `${titulo} - ${artista}`;
      }

      const blobAudio =
        file.type && file.type.startsWith('audio/')
          ? file
          : new Blob([file], { type: 'audio/mpeg' });

      const registro: CancionImportadaResultado = {
        nombre: claveFinal,
        blob: blobAudio,
        tamano: blobAudio.size,
        duracion,
        favorito: false,
        fecha: Date.now(),
        caratula,
        artista,
        album,
        exportada: true,
        descargada: true,
        origen: 'local_importada',
        verified: true,
        sourceVersion: 'importado',
        durationActual: duracion
      };

      await localforage.setItem(claveFinal, registro);

      if (esAlmacenamientoNativoDisponible()) {
        const resNativo = await blindarCancionEnMemoriaFisica(
          { nombre: claveFinal, artista, duracion },
          blobAudio
        );
        if (resNativo.ok) copiadasNativo++;
      }

      const { blob: _omit, ...ligera } = registro;
      importadas.push(ligera);
      acumulados.push({ nombre: claveFinal, artista, duracion });
    } catch (err) {
      console.warn(`[Importador]: Error importando "${file.name}":`, err);
      errores++;
    }
  }

  return {
    importadas,
    duplicadas,
    errores,
    copiadasNativo
  };
}
