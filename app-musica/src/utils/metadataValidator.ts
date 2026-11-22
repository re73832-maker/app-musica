import { obtenerUrlApi, fetchConTimeout } from './apiConfig';

export interface MusicBrainzCandidate {
  id?: string;
  title: string;
  artist?: string;
  durationSec: number;
  disambiguation?: string;
  releaseTitle?: string;
}

export interface MusicBrainzValidationResult {
  status: 'matched' | 'mismatch' | 'no_data' | 'retry_later';
  durationMatch?: boolean;
  durationExpected?: number;
  flagReason?: string;
  candidatesCount: number;
  fromCache?: boolean;
}

interface CachedMbEntry {
  timestamp: number;
  found: boolean;
  candidates: MusicBrainzCandidate[];
}

const MB_CACHE_STORAGE_KEY = 'app_musica_mb_cache_v1';
const MB_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const MB_CACHE_MAX_ENTRIES = 300;
const TOLERANCIA_SEGUNDOS = 5;

function normalizarClave(title: string, artist?: string): string {
  const t = (title || '').trim().toLowerCase();
  const a = (artist || '').trim().toLowerCase();
  return `${t}|${a}`;
}

function leerCacheLocal(): Record<string, CachedMbEntry> {
  try {
    const raw = localStorage.getItem(MB_CACHE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function guardarCacheLocal(cache: Record<string, CachedMbEntry>): void {
  try {
    const keys = Object.keys(cache);
    if (keys.length > MB_CACHE_MAX_ENTRIES) {
      keys
        .sort((a, b) => (cache[a]?.timestamp || 0) - (cache[b]?.timestamp || 0))
        .slice(0, keys.length - MB_CACHE_MAX_ENTRIES)
        .forEach((k) => {
          delete cache[k];
        });
    }
    localStorage.setItem(MB_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch (_) {}
}

function evaluarCandidatos(
  candidates: MusicBrainzCandidate[],
  durationActual: number
): MusicBrainzValidationResult {
  const validCandidates = candidates.filter(
    (c) => typeof c.durationSec === 'number' && c.durationSec > 0
  );

  if (validCandidates.length === 0) {
    return {
      status: 'no_data',
      flagReason: 'sin datos',
      candidatesCount: 0
    };
  }

  if (!durationActual || durationActual <= 0) {
    return {
      status: 'no_data',
      durationExpected: validCandidates[0].durationSec,
      flagReason: 'sin datos',
      candidatesCount: validCandidates.length
    };
  }

  // Buscar la grabación candidata más cercana a la duración real del archivo
  let mejorCandidata = validCandidates[0];
  let menorDiferencia = Math.abs(durationActual - mejorCandidata.durationSec);

  for (let i = 1; i < validCandidates.length; i++) {
    const diff = Math.abs(durationActual - validCandidates[i].durationSec);
    if (diff < menorDiferencia) {
      menorDiferencia = diff;
      mejorCandidata = validCandidates[i];
    }
  }

  if (menorDiferencia <= TOLERANCIA_SEGUNDOS) {
    // Coincide dentro de ±5 s: marca durationMatch=true pero NO verified=true
    return {
      status: 'matched',
      durationMatch: true,
      durationExpected: mejorCandidata.durationSec,
      candidatesCount: validCandidates.length
    };
  }

  return {
    status: 'mismatch',
    durationMatch: false,
    durationExpected: mejorCandidata.durationSec,
    flagReason: 'duración no coincide',
    candidatesCount: validCandidates.length
  };
}

/**
 * Valida título y artista contra el endpoint propio en servidor-musica (/api/musicbrainz/validate).
 * Falla en silencio si no hay internet o Render está dormido para reintentar después.
 */
export async function validarCancionConMusicBrainz(
  title: string,
  artist: string | undefined,
  durationActual: number
): Promise<MusicBrainzValidationResult> {
  const tituloLimpio = (title || '').trim();
  if (!tituloLimpio) {
    return { status: 'no_data', flagReason: 'sin datos', candidatesCount: 0 };
  }

  const clave = normalizarClave(tituloLimpio, artist);
  const cache = leerCacheLocal();
  const entrada = cache[clave];

  if (entrada && Date.now() - entrada.timestamp < MB_CACHE_TTL_MS) {
    const evalCache = evaluarCandidatos(entrada.candidates || [], durationActual);
    return { ...evalCache, fromCache: true };
  }

  // Sin conexión: fallar en silencio para reintentar más tarde
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { status: 'retry_later', candidatesCount: 0 };
  }

  const ruta = `/api/musicbrainz/validate?title=${encodeURIComponent(tituloLimpio)}${
    artist ? `&artist=${encodeURIComponent(artist)}` : ''
  }`;
  const url = obtenerUrlApi(ruta);
  if (!url) {
    return { status: 'retry_later', candidatesCount: 0 };
  }

  try {
    // Timeout moderado para tolerar arranque en frío de Render sin colgar la cola
    const res = await fetchConTimeout(url, { method: 'GET' }, 12000);
    if (!res.ok) {
      return { status: 'retry_later', candidatesCount: 0 };
    }

    const data = await res.json();
    if (!data || data.ok !== true) {
      return { status: 'retry_later', candidatesCount: 0 };
    }

    const candidates: MusicBrainzCandidate[] = Array.isArray(data.candidates)
      ? data.candidates
      : [];

    // Guardar en caché local solo respuestas válidas del servidor
    cache[clave] = {
      timestamp: Date.now(),
      found: Boolean(data.found),
      candidates
    };
    guardarCacheLocal(cache);

    return evaluarCandidatos(candidates, durationActual);
  } catch {
    // Render dormido, red intermitente o CORS/timeout: falla en silencio
    return { status: 'retry_later', candidatesCount: 0 };
  }
}
