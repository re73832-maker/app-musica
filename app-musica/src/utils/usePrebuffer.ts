import { useEffect, useRef } from 'react';
import type React from 'react';
import localforage from 'localforage';
import { obtenerUrlApi, fetchJsonSeguro } from './apiConfig';

export interface PistaPrebuffer {
  videoId?: string;
  title?: string;
  nombre?: string;
  artist?: string;
  artista?: string;
  blob?: Blob;
  seconds?: number;
  duracion?: number;
  caratula?: string;
}

export interface UsePrebufferOptions {
  /** Segundos transcurridos de la pista actual para disparar el pre-buffer predictivo. Default: 10 */
  segundosTranscurridosTrigger?: number;
  /** Segundos antes de finalizar la pista actual para iniciar la precarga. Default: 15 */
  segundosRestantesTrigger?: number;
  /** Callback opcional cuando se precarga con éxito en memoria / IndexedDB */
  onPrebufferSuccess?: (trackIdentifier: string, blob?: Blob) => void;
  /** Callback opcional en caso de error silencioso */
  onPrebufferError?: (error: unknown) => void;
  /** Interruptor para activar/desactivar la precarga */
  habilitado?: boolean;
}

const cachePrebufferEnVuelo = new Set<string>();
const cachePrebufferCompletados = new Set<string>();

/**
 * Precarga silenciosa en segundo plano hacia IndexedDB (`localforage`) y memoria caché
 * si la siguiente canción de la cola o lista/radio aún no está almacenada localmente.
 */
export async function prebufferPistaEnIndexedDB(
  pista: PistaPrebuffer | null | undefined,
  options: UsePrebufferOptions = {}
): Promise<Blob | null> {
  if (!pista) return null;
  const nombreClave = (pista.nombre || pista.title || '').trim();
  if (!nombreClave) return null;

  if (cachePrebufferEnVuelo.has(nombreClave)) return null;

  try {
    // 1. Si ya tiene un Blob válido en memoria, asegurar que esté en IndexedDB
    if (pista.blob instanceof Blob && pista.blob.size > 1000) {
      cachePrebufferCompletados.add(nombreClave);
      return pista.blob;
    }

    // 2. Verificar si ya existe localmente en IndexedDB (`localforage`)
    const existente: any = await localforage.getItem(nombreClave);
    if (existente) {
      const blobLocal =
        existente instanceof Blob
          ? existente
          : existente && typeof existente === 'object' && existente.blob instanceof Blob
          ? existente.blob
          : null;
      if (blobLocal && blobLocal.size > 1000) {
        cachePrebufferCompletados.add(nombreClave);
        options.onPrebufferSuccess?.(nombreClave, blobLocal);
        return blobLocal;
      }
    }

    // 3. Si aún no está en IndexedDB y hay conexión a red, descargar y almacenar silenciosamente en background
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return null;
    }

    cachePrebufferEnVuelo.add(nombreClave);

    const artista = (pista.artista || pista.artist || '').trim();
    const videoId = (pista.videoId || '').trim();
    const duracion = pista.duracion || pista.seconds || 0;

    const rutaEnlace = `/api/obtener-enlace?q=${encodeURIComponent(nombreClave)}&artist=${encodeURIComponent(artista)}${
      videoId ? `&videoId=${encodeURIComponent(videoId)}` : ''
    }${duracion ? `&seconds=${encodeURIComponent(String(duracion))}` : ''}`;

    const urlEnlace = obtenerUrlApi(rutaEnlace);
    if (!urlEnlace) return null;

    const data = await fetchJsonSeguro<{ downloadUrl?: string }>(urlEnlace, undefined, 25000);
    if (!data?.downloadUrl) return null;

    const urlProxy = obtenerUrlApi(`/api/proxy-stream?url=${encodeURIComponent(data.downloadUrl)}`);
    let streamRes = urlProxy ? await fetch(urlProxy).catch(() => null) : null;
    if (!streamRes || !streamRes.ok) {
      streamRes = await fetch(data.downloadUrl).catch(() => null);
    }

    if (!streamRes || !streamRes.ok) return null;
    const ct = (streamRes.headers.get('content-type') || '').toLowerCase();
    if (ct.includes('text/html')) return null;

    const rawBlob = await streamRes.blob();
    if (!rawBlob || rawBlob.size < 32000) return null;

    const blobAudio = rawBlob.type && rawBlob.type.startsWith('audio/')
      ? rawBlob
      : new Blob([rawBlob], { type: 'audio/mpeg' });

    // Guardar en IndexedDB (`localforage`) para transición de 0ms de red
    await localforage.setItem(nombreClave, {
      nombre: nombreClave,
      blob: blobAudio,
      tamano: blobAudio.size,
      duracion,
      artista: artista || undefined,
      caratula: pista.caratula,
      fecha: Date.now(),
      descargada: true,
      origen: 'cache',
      verified: false,
      sourceVersion: 'prebuffer',
      durationExpected: duracion > 0 ? duracion : undefined,
      durationActual: duracion
    });

    cachePrebufferCompletados.add(nombreClave);
    options.onPrebufferSuccess?.(nombreClave, blobAudio);
    return blobAudio;
  } catch (err) {
    options.onPrebufferError?.(err);
    return null;
  } finally {
    cachePrebufferEnVuelo.delete(nombreClave);
  }
}

/**
 * Hook de Pre-buffer Predictivo Estilo Spotify.
 * Cuando la canción actual lleva más de 10 segundos reproduciéndose (`currentTime > 10`),
 * verifica cuál es la siguiente canción en la cola (`colaManual[0]` o la siguiente de la lista/radio).
 * Si aún no está guardada localmente en IndexedDB (`localforage`), la precarga en memoria/caché
 * en segundo plano de forma silenciosa para que al cambiar de pista o activarse `SmartAutomixEngine`
 * la transición sea instantánea (0ms de espera de red).
 */
export function usePrebuffer(
  audioRef: React.RefObject<HTMLAudioElement | null> | null,
  proximaPista: PistaPrebuffer | null | undefined,
  options: UsePrebufferOptions = {}
) {
  const proximaRef = useRef<PistaPrebuffer | null | undefined>(proximaPista);
  proximaRef.current = proximaPista;

  const optionsRef = useRef<UsePrebufferOptions>(options);
  optionsRef.current = options;

  const ultimaPistaVerificadaRef = useRef<string>('');

  useEffect(() => {
    const el = audioRef?.current;
    if (!el || optionsRef.current.habilitado === false) return;

    const triggerSegundos = optionsRef.current.segundosTranscurridosTrigger ?? 10;

    const onTimeUpdate = () => {
      if (el.paused || el.currentTime <= triggerSegundos) return;

      const sig = proximaRef.current;
      if (!sig) return;

      const idClave = (sig.nombre || sig.title || '').trim();
      if (!idClave || ultimaPistaVerificadaRef.current === idClave || cachePrebufferCompletados.has(idClave)) {
        return;
      }

      ultimaPistaVerificadaRef.current = idClave;
      prebufferPistaEnIndexedDB(sig, optionsRef.current).catch(() => {});
    };

    el.addEventListener('timeupdate', onTimeUpdate, { passive: true });
    return () => {
      el.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [audioRef, proximaPista?.nombre, proximaPista?.title]);
}
