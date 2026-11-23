import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import localforage from 'localforage';
import './App.css';
import { UpdatePrompt } from './components/UpdatePrompt';
import { VirtualSongList } from './components/VirtualSongList';
import { useDebounce } from './utils/useDebounce';
import { usePrebuffer, prebufferPistaEnIndexedDB } from './utils/usePrebuffer';
import { registrarMediaSessionSeekTo, sincronizarMediaSessionPosition } from './utils/mediaSessionEnhancer';
import { ColaReproduccionModal } from './components/ColaReproduccionModal';
import { useHistorialEscucha } from './utils/useHistorialEscucha';
import { EscuchadoRecientemente } from './components/EscuchadoRecientemente';
import { RevisarBiblioteca } from './components/RevisarBiblioteca';
import { PreescuchaModal, type DatosPreescucha } from './components/PreescuchaModal';
import {
  migrarBibliotecaIndexedDB,
  detectarSospechaInicial,
  esCancionParaRevisar
} from './utils/libraryMigration';
import { validarCancionConMusicBrainz } from './utils/metadataValidator';
import {
  importarArchivosMusicaPropia,
  type ProgresoImportacion
} from './utils/localMusicImporter';
import {
  notificarOtaLista,
  revisarActualizacionOta,
  type EstadoOta
} from './utils/otaUpdater';
import { SearchSuggestions } from './components/SearchSuggestions';
import { useRadioInfinita } from './utils/useRadioInfinita';
import { validarConexionStorage } from './utils/storageManager';
import {
  esAlmacenamientoNativoDisponible,
  blindarCancionEnMemoriaFisica,
  estaCancionEnMemoriaFisica,
  obtenerCancionesEnMemoriaFisica,
  recuperarBlobCancionDesdeMemoriaFisica,
  guardarRespaldoEnMemoriaFisica,
  leerRespaldoDeMemoriaFisica,
  actualizarNotificacionNativa,
  detenerNotificacionNativa,
  revocarUrlObjetoSegura,
  registrarValidadorUrlActiva
} from './utils/persistentStorageBridge';
import { audioProgress } from './utils/audioProgress';
import {
  bassBoostManager,
  smartAutomixEngine,
  liberarHardwareDeck
} from './utils/bassBoostManager';
import {
  MiniPlayerProgressBar,
  MiniPlayerTimeText,
  ExpandedPlayerScrubber,
  DrawerTimeText,
  LetrasPreviewSnippet
} from './components/PlayerProgressComponents';
import {
  obtenerUrlApi,
  obtenerBackendBaseUrl,
  guardarBackendBaseUrl,
  probarConexionBackend,
  fetchJsonSeguro,
  fetchConTimeout,
  BACKEND_URL_DEFAULT,
  esDispositivoMovil
} from './utils/apiConfig';
import {
  IconInicio,
  IconBuscar,
  IconBiblioteca,
  IconAjustes,
  IconPlay,
  IconPausa,
  IconAnterior,
  IconSiguiente,
  IconCorazon,
  IconPuntos,
  IconNota,
  IconDescargar,
  IconCola,
  IconLuna,
  IconAleatorio,
  IconRepetir,
  IconChevronAbajo,
  IconMix,
  IconVolumen,
  IconLimpiar,
  SpotifyEqualizer,
  IconCheck,
  IconSpinner,
  IconDispositivo,
  IconCompartir,
  IconMicrofono,
  IconExpandir
} from './components/SpotifyIcons';

// Base de datos local IndexedDB con respaldo de controladores
localforage.config({
  name: 'AppMusicaPapa',
  storeName: 'biblioteca_canciones',
  driver: [
    localforage.INDEXEDDB,
    localforage.WEBSQL,
    localforage.LOCALSTORAGE
  ],
  description: 'Almacenamiento permanente de canciones y listas de reproducción'
});

interface Cancion {
  nombre: string;
  blob?: Blob; // Opcional: no retenido en RAM para la biblioteca, se lee bajo demanda al reproducir/exportar
  tamano: number; // en bytes
  duracion: number; // en segundos
  favorito?: boolean;
  fecha?: number;
  caratula?: string;
  artista?: string;
  album?: string;
  exportada?: boolean; // Marca de estado para control de duplicados y sincronización
  descargada?: boolean; // Descargada explícitamente por el usuario en la app
  origen?: 'descarga' | 'local_importada' | 'cache' | 'dispositivo_permanente';
  tituloLower?: string;
  artistaLower?: string;
  verified?: boolean;
  sourceVersion?: string;
  durationExpected?: number;
  durationActual?: number;
  durationMatch?: boolean;
  flagReason?: string;
}

const _pendingStorageWrites = new Map<string, string>();
let _storageIdleScheduled = false;

export function guardarStorageDiferido(clave: string, valor: string): void {
  _pendingStorageWrites.set(clave, valor);
  if (_storageIdleScheduled) return;
  _storageIdleScheduled = true;

  const flush = () => {
    _storageIdleScheduled = false;
    _pendingStorageWrites.forEach((v, k) => {
      try {
        localStorage.setItem(k, v);
      } catch (_) {}
    });
    _pendingStorageWrites.clear();
  };

  if (typeof window !== 'undefined' && typeof (window as any).requestIdleCallback === 'function') {
    (window as any).requestIdleCallback(flush, { timeout: 400 });
  } else {
    setTimeout(flush, 120);
  }
}

export function normalizarParaBusqueda(str?: string): string {
  return (str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

interface ResultadoBusqueda {
  videoId: string;
  title: string;
  artist: string;
  author?: string;
  license?: string;
  timestamp: string;
  seconds: number;
  thumbnail: string;
  previewUrl?: string;
  streamUrl?: string;
  sourceVersion?: string;
}

interface EstadoPreview {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string;
  cargando: boolean;
  reproduciendo: boolean;
  duracion: number;
  tiempo: number;
  itemOriginal: ResultadoBusqueda;
}

interface Playlist {
  id: string;
  nombre: string;
  canciones: string[]; // Nombres de canciones
  fechaCreacion: number;
}

interface ToastInfo {
  id: number;
  mensaje: string;
  tipo: 'exito' | 'error' | 'info';
}

interface ModalConfirmacionState {
  abierto: boolean;
  titulo: string;
  mensaje: string;
  textoConfirmar?: string;
  peligroso?: boolean;
  onConfirmar: () => void;
}

type TabNavegacion = 'inicio' | 'buscar' | 'biblioteca' | 'ajustes';
type ModoRepeticion = 'off' | 'all' | 'one';
type FiltroBiblioteca = 'todas' | 'favoritas' | 'playlists' | 'revisar';
type CriterioOrden = 'recientes' | 'az' | 'za';

// Formatear segundos a mm:ss con precisión
function formatearTiempo(segundos?: number): string {
  if (!segundos || isNaN(segundos) || !isFinite(segundos) || segundos < 0) return '0:00';
  const mins = Math.floor(segundos / 60);
  const segs = Math.floor(segundos % 60);
  return `${mins}:${segs < 10 ? '0' : ''}${segs}`;
}

// Formatear bytes a MB o KB
function formatearTamano(bytes?: number): string {
  if (!bytes || isNaN(bytes) || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(0)} KB`;
}

// Convertir Blob a Base64 para respaldo
export function blobABase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Convertir Base64 a Blob de forma segura
async function dataUrlABlob(dataUrl: string): Promise<Blob> {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
    return new Blob([], { type: 'audio/mpeg' });
  }
  try {
    const respuesta = await fetch(dataUrl);
    const ab = await respuesta.arrayBuffer();
    return new Blob([ab], { type: 'audio/mpeg' });
  } catch (err) {
    console.warn('Error convirtiendo dataUrl a Blob:', err);
    return new Blob([], { type: 'audio/mpeg' });
  }
}

// Extraer duración de un Blob de audio sin fugas de memoria ni decodificadores colgados
function obtenerDuracionDeBlob(blob: Blob): Promise<number> {
  return new Promise((resolve) => {
    if (!blob || blob.size === 0) {
      resolve(0);
      return;
    }

    let url = '';
    let timeoutId: any = null;
    let finalizado = false;

    const limpiarRecursos = () => {
      if (finalizado) return;
      finalizado = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (url) {
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
        url = '';
      }
    };

    try {
      const audio = new Audio();
      url = URL.createObjectURL(blob);
      audio.preload = 'metadata';

      // Timeout de seguridad: si el codec no responde en 3.5s, cancelar sin bloquear
      timeoutId = setTimeout(() => {
        limpiarRecursos();
        audio.removeAttribute('src');
        audio.load();
        resolve(0);
      }, 3500);

      audio.onloadedmetadata = () => {
        const d = audio.duration;
        limpiarRecursos();
        audio.removeAttribute('src');
        audio.load();
        resolve(isFinite(d) && d > 0 ? d : 0);
      };

      audio.onerror = () => {
        limpiarRecursos();
        audio.removeAttribute('src');
        audio.load();
        resolve(0);
      };

      audio.src = url;
    } catch {
      limpiarRecursos();
      resolve(0);
    }
  });
}

// Interfaz y parser de letras sincronizadas estilo Spotify (LRC)
export interface LineaLetra {
  segundos: number;
  texto: string;
}

export interface InfoLetraCancion {
  id: string;
  sincronizada: boolean;
  lineas: LineaLetra[];
  textoPlano?: string;
}

export function parsearLRC(lrc: string): LineaLetra[] {
  const lineas: LineaLetra[] = [];
  const regex = /\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/;
  const rawLines = lrc.split('\n');
  for (const line of rawLines) {
    const match = regex.exec(line.trim());
    if (match) {
      const mins = parseInt(match[1], 10);
      const segs = parseInt(match[2], 10);
      const ms = parseInt(match[3], 10) / (match[3].length === 2 ? 100 : 1000);
      const texto = match[4].trim();
      if (texto) {
        lineas.push({ segundos: mins * 60 + segs + ms, texto });
      }
    }
  }
  return lineas.sort((a, b) => a.segundos - b.segundos);
}

export function limpiarTextoMetadata(texto?: string): string {
  if (!texto) return '';
  return texto
    .replace(/\.[a-zA-Z0-9]{2,5}$/, '')
    .replace(/_\d{10,}$/g, '')
    .trim();
}

export function normalizarTextoComparar(str: string): string {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function limpiarRuidoTitulo(raw: string): string {
  return (raw || '')
    .replace(/\.[a-zA-Z0-9]{2,5}$/, '')
    .replace(/\(\s*video\s*oficial\s*\)/gi, ' ')
    .replace(/\[\s*video\s*oficial\s*\]/gi, ' ')
    .replace(/\b(video\s*oficial|official\s*video|official\s*music\s*video|video\s*musical|audio\s*oficial|official\s*audio|lyric\s*video|video\s*lyric|letra\s*oficial|letra|lyrics|hd|4k|en\s*vivo|live|remastered)\b/gi, ' ')
    .replace(/[()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsearTituloYArtista(nombreArchivoOTrack: string, artistaOriginal?: string): {
  tituloLimpio: string;
  artistaLimpio: string;
  segmentosLimpios: string[];
  candidatosBusqueda: { track: string; artist: string }[];
} {
  const sinExtension = (nombreArchivoOTrack || '').replace(/\.[a-zA-Z0-9]{2,5}$/, '');
  // Extraer segmentos por guiones y limpiar cada segmento con Regex
  const partesBrutas = sinExtension.split(/\s*[-–—|]\s*/);
  const partes = partesBrutas
    .map((p) => limpiarRuidoTitulo(p))
    .filter((p) => p.length > 1);

  const todoLimpio = limpiarRuidoTitulo(sinExtension);
  let titulo = partes[0] || todoLimpio;
  let artistaMeta = limpiarRuidoTitulo(artistaOriginal || '');
  if (/^(desconocido|unknown|canal oficial|youtube|audio|music|varios|topic)$/i.test(artistaMeta)) {
    artistaMeta = '';
  }

  const candidatos: { track: string; artist: string }[] = [];
  const agregarCandidato = (track: string, artist: string) => {
    const t = track.trim();
    const a = artist.trim();
    if (!t) return;
    if (!candidatos.some((c) => c.track.toLowerCase() === t.toLowerCase() && c.artist.toLowerCase() === a.toLowerCase())) {
      candidatos.push({ track: t, artist: a });
    }
  };

  if (partes.length >= 2) {
    // Prioridad absoluta a los segmentos limpios del propio título (ej. "Mi Religion" y "T3R Elemento")
    // aunque el campo artista diga por error "Junior H"
    const segPrimero = partes[0];
    const segUltimo = partes[partes.length - 1];
    agregarCandidato(segPrimero, segUltimo);
    agregarCandidato(segUltimo, segPrimero);
    if (partes.length >= 3) {
      agregarCandidato(partes[0], partes[1]);
      agregarCandidato(partes[1], partes[0]);
    }
    // También permitir buscar el segmento de título sin forzar el artista erróneo
    agregarCandidato(segPrimero, '');
    agregarCandidato(segUltimo, '');
    if (artistaMeta) {
      agregarCandidato(segPrimero, artistaMeta);
    }
    titulo = segPrimero;
    artistaMeta = segUltimo;
  } else if (partes.length === 1) {
    titulo = partes[0];
    if (artistaMeta) {
      agregarCandidato(titulo, artistaMeta);
    }
    // Incluir candidato sin artista por si el campo artista viene equivocado
    agregarCandidato(titulo, '');
  } else if (todoLimpio) {
    agregarCandidato(todoLimpio, artistaMeta);
    agregarCandidato(todoLimpio, '');
  }

  return {
    tituloLimpio: titulo,
    artistaLimpio: artistaMeta,
    segmentosLimpios: partes.length > 0 ? partes : (todoLimpio ? [todoLimpio] : []),
    candidatosBusqueda: candidatos
  };
}

export function esCoincidenciaExactaOValida(
  itemTrack: string,
  itemArtist: string,
  targetTrack: string,
  targetArtist: string
): boolean {
  const normItemTrack = normalizarTextoComparar(limpiarRuidoTitulo(itemTrack));
  const normItemArtist = normalizarTextoComparar(limpiarRuidoTitulo(itemArtist));
  const normTargetTrack = normalizarTextoComparar(limpiarRuidoTitulo(targetTrack));
  const normTargetArtist = normalizarTextoComparar(limpiarRuidoTitulo(targetArtist));

  if (!normItemTrack || !normTargetTrack || normTargetTrack.length < 2) return false;

  // Validar que el resultado de LRCLIB coincida realmente con el título de la canción
  const trackExacto = normItemTrack === normTargetTrack;
  const longitudMin = Math.min(normItemTrack.length, normTargetTrack.length);
  const longitudMax = Math.max(normItemTrack.length, normTargetTrack.length);
  const trackContiene =
    longitudMin >= 4 &&
    longitudMin / longitudMax >= 0.55 &&
    (normItemTrack.includes(normTargetTrack) || normTargetTrack.includes(normItemTrack));

  if (!trackExacto && !trackContiene) return false;

  if (normTargetArtist) {
    const artistCoincide =
      normItemArtist.includes(normTargetArtist) ||
      normTargetArtist.includes(normItemArtist) ||
      // Equivalencias comunes como T3R Elemento <-> Tercer Elemento
      (normTargetArtist.includes('t3r') && normItemArtist.includes('tercer')) ||
      (normTargetArtist.includes('tercer') && normItemArtist.includes('t3r'));
    return artistCoincide;
  }

  return trackExacto || (trackContiene && longitudMin >= 5);
}

// =========================================================================
// OPCIONES DE FORMATOS Y CALIDADES DE DESCARGA (SCREENSHOT ESTILO SNAP/YTDL)
// =========================================================================
export interface OpcionFormatoDescarga {
  id: string;
  seccion: 'musica' | 'video';
  titulo: string;
  badge?: string;
  subtitulo: string;
  pesoAprox: string;
}

export const OPCIONES_FORMATO: OpcionFormatoDescarga[] = [
  // Música
  {
    id: 'm4a',
    seccion: 'musica',
    titulo: 'Rápido',
    subtitulo: 'M4A (128 Kbps), ideal para reproducción en dispositivos móviles',
    pesoAprox: '1,4 MB'
  },
  {
    id: 'mp3_70',
    seccion: 'musica',
    titulo: 'MP3 clásico (70K)',
    badge: 'Bajo',
    subtitulo: 'Compatible con bocina Bluetooth, teléfono móvil, coche, reloj, etc.',
    pesoAprox: '872,7 KB'
  },
  {
    id: 'mp3_128',
    seccion: 'musica',
    titulo: 'MP3 clásico (128K)',
    subtitulo: 'Compatible con bocina Bluetooth, teléfono móvil, coche, reloj, etc.',
    pesoAprox: '1,4 MB'
  },
  {
    id: 'mp3',
    seccion: 'musica',
    titulo: 'MP3 clásico',
    subtitulo: 'MP3 (160 Kbps), compatible con altavoces Bluetooth, teléfonos móviles, automóviles, relojes, etc.',
    pesoAprox: '1,6 MB'
  },
  {
    id: 'mp3_320',
    seccion: 'musica',
    titulo: 'MP3 clásico (320K)',
    badge: 'Alta Calidad',
    subtitulo: 'Compatible con bocina Bluetooth, teléfono móvil, coche, reloj, etc.',
    pesoAprox: '3,3 MB'
  },
  // Video
  {
    id: '144',
    seccion: 'video',
    titulo: 'Rápido (144p)',
    badge: 'Baja',
    subtitulo: 'Video de calidad baja para ahorro extremo de datos',
    pesoAprox: '2,6 MB'
  },
  {
    id: '240',
    seccion: 'video',
    titulo: 'Rápido (240p)',
    subtitulo: 'Calidad baja para reproducción rápida',
    pesoAprox: '3,8 MB'
  },
  {
    id: '360',
    seccion: 'video',
    titulo: 'Rápido (360p)',
    subtitulo: 'Video estándar compatible con todos los reproductores',
    pesoAprox: '5,5 MB'
  },
  {
    id: '720',
    seccion: 'video',
    titulo: 'HD (720p)',
    badge: 'Alta Calidad',
    subtitulo: 'Video en alta definición HD',
    pesoAprox: '12 MB'
  }
];

// =========================================================================
// SISTEMA DE TEMAS VISUALES Y FONDOS DINÁMICOS ANIMADOS POR CANCIÓN
// =========================================================================

export interface TemaVisualFondo {
  id: string;
  nombre: string;
  subtitulo?: string;
  imagenUrl?: string;
  colorPrincipal: string;
  colorSecundario: string;
  colorTerciario: string;
  colorFondo: string;
  filtroAnillo?: string;
}

export const TEMAS_VISUALES: TemaVisualFondo[] = [
  // --- FONDOS SAD BOYZ II & ESTATUAS GÓTICAS CON HALO NEÓN ---
  {
    id: 'sadboyz-rosa-lagrimas',
    nombre: 'Sad Boyz II Rosas & Lágrimas',
    subtitulo: 'Ángel con alas oscuras, espinas y halo neón',
    imagenUrl: '/fondos/sadboyz-rosa-lagrimas.jpg',
    colorPrincipal: '#F43F5E', // Rosa carmesí oscuro
    colorSecundario: '#FDE047', // Halo dorado
    colorTerciario: '#818CF8',
    colorFondo: '#060608',
    filtroAnillo: 'hue-rotate(340deg) saturate(3) drop-shadow(0 0 26px #F43F5E) drop-shadow(0 0 55px #FDE047aa) brightness(1.25)'
  },
  {
    id: 'angel-estatua-halo',
    nombre: 'Ángel Sad Boyz & Halo Neón',
    subtitulo: 'Estatua de mármol con alas, halo neón y enredaderas',
    imagenUrl: '/fondos/angel-estatua-halo.jpg',
    colorPrincipal: '#FDE047', // Luz dorada del halo
    colorSecundario: '#F8FAFC', // Blanco mármol
    colorTerciario: '#84CC16',
    colorFondo: '#08080A',
    filtroAnillo: 'hue-rotate(210deg) saturate(3) drop-shadow(0 0 26px #FDE047) drop-shadow(0 0 55px #F8FAFCaa) brightness(1.25)'
  },
  {
    id: 'escultura-angel-noir',
    nombre: 'Querubín Noir & Halo Neón',
    subtitulo: 'Escultura clásica con lágrimas noir y halo cian',
    imagenUrl: '/fondos/escultura-angel-noir.jpg',
    colorPrincipal: '#38BDF8', // Halo cian
    colorSecundario: '#F43F5E', // Rosas oscuras
    colorTerciario: '#E2E8F0',
    colorFondo: '#060608',
    filtroAnillo: 'drop-shadow(0 0 26px #38BDF8) drop-shadow(0 0 55px #F43F5Eaa) brightness(1.25)'
  },
  {
    id: 'escultura-angel-alas',
    nombre: 'Ángel de Mármol Gótico',
    subtitulo: 'Alas de piedra y sombras renacentistas',
    imagenUrl: '/fondos/escultura-angel-alas.jpg',
    colorPrincipal: '#E2E8F0', // Mármol blanco
    colorSecundario: '#94A3B8', // Piedra plata
    colorTerciario: '#38BDF8',
    colorFondo: '#070709',
    filtroAnillo: 'saturate(0.15) brightness(1.5) drop-shadow(0 0 24px #E2E8F0) drop-shadow(0 0 50px #94A3B8aa)'
  },
  {
    id: 'estatua-neon-cyber',
    nombre: 'Escultura Clásica Neón',
    subtitulo: 'Mármol renacentista con luces púrpuras y cian',
    imagenUrl: '/fondos/estatua-neon-cyber.jpg',
    colorPrincipal: '#A855F7', // Violeta neón
    colorSecundario: '#06B6D4', // Cian
    colorTerciario: '#F43F5E',
    colorFondo: '#07040C',
    filtroAnillo: 'hue-rotate(95deg) saturate(2.6) drop-shadow(0 0 26px #A855F7) drop-shadow(0 0 55px #06B6D4aa) brightness(1.25)'
  },

  // --- FONDOS DE CARROS & SUPERDEPORTIVOS NOIR NOCTURNOS ---
  {
    id: 'porsche-midnight',
    nombre: 'Porsche 911 GT3 RS Midnight',
    subtitulo: 'Supercar negro en autopista mojada con luces rojas',
    imagenUrl: '/fondos/porsche-midnight-noir.jpg',
    colorPrincipal: '#EF4444', // Rojo deportivo LED
    colorSecundario: '#38BDF8', // Reflejo asfalto
    colorTerciario: '#F8FAFC',
    colorFondo: '#050508',
    filtroAnillo: 'hue-rotate(175deg) saturate(3.5) drop-shadow(0 0 26px #EF4444) drop-shadow(0 0 55px #38BDF8aa) brightness(1.2)'
  },
  {
    id: 'gtr-noche-lluvia',
    nombre: 'Nissan GT-R Noche Lluvia',
    subtitulo: 'Tokio medianoche con asfalto mojado y faros LED',
    imagenUrl: '/fondos/gtr-noche-lluvia.jpg',
    colorPrincipal: '#F8FAFC', // Blanco xenón puro
    colorSecundario: '#EF4444', // Calaveras LED rojas
    colorTerciario: '#06B6D4',
    colorFondo: '#06060A',
    filtroAnillo: 'drop-shadow(0 0 26px #F8FAFC) drop-shadow(0 0 55px #EF4444aa) brightness(1.2)'
  },
  {
    id: 'gtr-drift',
    nombre: 'Nissan GT-R Drift',
    subtitulo: 'Humo noir y faros xenón en la noche',
    imagenUrl: '/fondos/gtr-drift-smoke.jpg',
    colorPrincipal: '#F8FAFC', // Xenón blanco frío puro
    colorSecundario: '#94A3B8', // Plata titanio
    colorTerciario: '#38BDF8',
    colorFondo: '#08080A',
    filtroAnillo: 'saturate(0.1) brightness(1.5) drop-shadow(0 0 24px #F8FAFC) drop-shadow(0 0 50px #94A3B8aa)'
  },
  {
    id: 'supercar-neon-night',
    nombre: 'Supercar Nocturno',
    subtitulo: 'Líneas rojas y faros xenón en la noche',
    imagenUrl: '/fondos/supercar-neon-night.jpg',
    colorPrincipal: '#EF4444', // Rojo deportivo neón
    colorSecundario: '#F8FAFC', // Xenón blanco
    colorTerciario: '#F59E0B',
    colorFondo: '#0A0505',
    filtroAnillo: 'hue-rotate(175deg) saturate(3.5) drop-shadow(0 0 26px #EF4444) drop-shadow(0 0 55px #F8FAFCaa) brightness(1.2)'
  },
  {
    id: 'retrowave-neon-drive',
    nombre: 'Retrowave Sunset Drive',
    subtitulo: 'Autopista ochentera y sol magenta',
    imagenUrl: '/fondos/retrowave-neon-drive.jpg',
    colorPrincipal: '#FF007F', // Magenta synthwave
    colorSecundario: '#F59E0B', // Ámbar atardecer
    colorTerciario: '#8B5CF6',
    colorFondo: '#0D0410',
    filtroAnillo: 'hue-rotate(125deg) saturate(3) drop-shadow(0 0 26px #FF007F) drop-shadow(0 0 55px #F59E0Baa) brightness(1.25)'
  },

  // --- PAISAJES DE OSCURIDAD, NOIR & CIUDAD NOCTURNA ---
  {
    id: 'paisaje-oscuridad-bosque',
    nombre: 'Bosque Gótico & Luna Roja',
    subtitulo: 'Niebla de medianoche, pinos negros y luna mística',
    imagenUrl: '/fondos/paisaje-oscuridad-bosque-luna.jpg',
    colorPrincipal: '#DC2626', // Rojo místico lunar
    colorSecundario: '#A855F7', // Violeta niebla
    colorTerciario: '#F43F5E',
    colorFondo: '#060408',
    filtroAnillo: 'hue-rotate(185deg) saturate(3) drop-shadow(0 0 26px #DC2626) drop-shadow(0 0 55px #A855F7aa) brightness(1.25)'
  },
  {
    id: 'bosque-luna',
    nombre: 'Bosque & Niebla Lunar',
    subtitulo: 'Pinos oscuros y bruma de medianoche',
    imagenUrl: '/fondos/bosque-niebla-luna.jpg',
    colorPrincipal: '#10B981', // Aurora esmeralda mística
    colorSecundario: '#6EE7B7', // Menta lunar
    colorTerciario: '#047857',
    colorFondo: '#030805',
    filtroAnillo: 'hue-rotate(325deg) saturate(2.6) drop-shadow(0 0 24px #10B981) drop-shadow(0 0 50px #6EE7B7aa) brightness(1.2)'
  },
  {
    id: 'ciudad-cyberpunk',
    nombre: 'Ciudad Neón Cyberpunk',
    subtitulo: 'Rascacielos futuristas y luces láser',
    imagenUrl: '/fondos/ciudad-cyberpunk.jpg',
    colorPrincipal: '#00F2FE', // Cian láser
    colorSecundario: '#FF007F', // Rosa fucsia
    colorTerciario: '#7C3AED',
    colorFondo: '#05040D',
    filtroAnillo: 'hue-rotate(135deg) saturate(2.8) drop-shadow(0 0 26px #FF007F) drop-shadow(0 0 55px #00F2FEaa) brightness(1.25)'
  },
  {
    id: 'tokyo-rain',
    nombre: 'Tokyo Rain & Luces Neón',
    subtitulo: 'Asfalto mojado y reflejos cyberpunk',
    imagenUrl: '/fondos/tokyo-rain-neon.jpg',
    colorPrincipal: '#F43F5E', // Magenta / rosa neón
    colorSecundario: '#06B6D4', // Azul eléctrico lluvia
    colorTerciario: '#A855F7',
    colorFondo: '#06060C',
    filtroAnillo: 'hue-rotate(155deg) saturate(2.8) drop-shadow(0 0 26px #F43F5E) drop-shadow(0 0 50px #06B6D4aa) brightness(1.2)'
  },
  {
    id: 'oceano-nocturno',
    nombre: 'Océano de Medianoche',
    subtitulo: 'Oleaje profundo con espuma de luna',
    imagenUrl: '/fondos/oceano-nocturno.jpg',
    colorPrincipal: '#0284C7', // Azul marino profundo
    colorSecundario: '#00F2FE', // Aguamarina neón
    colorTerciario: '#38BDF8',
    colorFondo: '#010811',
    filtroAnillo: 'hue-rotate(25deg) saturate(2) drop-shadow(0 0 24px #0284C7) drop-shadow(0 0 50px #00F2FEaa) brightness(1.2)'
  },
  {
    id: 'galaxia-cosmos',
    nombre: 'Galaxia & Cosmos Noir',
    subtitulo: 'Estrellas, nebulosa y luna creciente',
    imagenUrl: '/fondos/galaxia-cosmos.jpg',
    colorPrincipal: '#38BDF8', // Cian celeste estelar
    colorSecundario: '#F8FAFC', // Blanco luna plateado
    colorTerciario: '#818CF8',
    colorFondo: '#030712',
    filtroAnillo: 'drop-shadow(0 0 26px #38BDF8) drop-shadow(0 0 55px #818CF8aa) brightness(1.25)'
  },
  {
    id: 'nebulosa-cosmos-violeta',
    nombre: 'Nebulosa Violeta Cosmos',
    subtitulo: 'Polvo cósmico y constelaciones púrpuras',
    imagenUrl: '/fondos/nebulosa-cosmos-violeta.jpg',
    colorPrincipal: '#C084FC', // Púrpura neón
    colorSecundario: '#EC4899', // Magenta estelar
    colorTerciario: '#38BDF8',
    colorFondo: '#07030F',
    filtroAnillo: 'hue-rotate(85deg) saturate(2.8) drop-shadow(0 0 26px #C084FC) drop-shadow(0 0 55px #EC4899aa) brightness(1.25)'
  },
  {
    id: 'lofi-noche-lluvia',
    nombre: 'Lofi Chill & Lluvia Nocturna',
    subtitulo: 'Calles mojadas y luces melancólicas',
    imagenUrl: '/fondos/lofi-noche-lluvia.jpg',
    colorPrincipal: '#60A5FA', // Azul cobalto suave
    colorSecundario: '#FBBF24', // Ámbar tenue
    colorTerciario: '#34D399',
    colorFondo: '#040711',
    filtroAnillo: 'hue-rotate(30deg) saturate(2.2) drop-shadow(0 0 24px #60A5FA) drop-shadow(0 0 50px #FBBF24aa) brightness(1.2)'
  },
  {
    id: 'montana-via-lactea',
    nombre: 'Vía Láctea sobre Cumbres',
    subtitulo: 'Noche estrellada en las montañas nevadas',
    imagenUrl: '/fondos/montana-via-lactea.jpg',
    colorPrincipal: '#38BDF8', // Cian cielo estrellado
    colorSecundario: '#E2E8F0', // Plata nieve
    colorTerciario: '#6366F1',
    colorFondo: '#03060E',
    filtroAnillo: 'hue-rotate(10deg) saturate(1.8) drop-shadow(0 0 26px #38BDF8) drop-shadow(0 0 50px #E2E8F0aa) brightness(1.25)'
  },
  // --- TEMAS ORIGINALES CON AMBIENTE LÁSER NEÓN ---
  {
    id: 'vecteezy-neon-blue',
    nombre: 'Espectro Neón Vecteezy',
    subtitulo: 'Cian láser y ondas ciberespaciales',
    colorPrincipal: '#00F2FE',
    colorSecundario: '#4FACFE',
    colorTerciario: '#0072FF',
    colorFondo: '#020914',
    filtroAnillo: 'drop-shadow(0 0 24px #00F2FE) drop-shadow(0 0 50px #4FACFEaa)'
  },
  {
    id: 'cyber-neon-purple',
    nombre: 'Ondas Ultravioleta',
    subtitulo: 'Violeta cósmico y pulso magenta',
    colorPrincipal: '#B026FF',
    colorSecundario: '#FF007F',
    colorTerciario: '#00F2FE',
    colorFondo: '#0C0217',
    filtroAnillo: 'hue-rotate(90deg) saturate(2.5) drop-shadow(0 0 24px #B026FF) drop-shadow(0 0 50px #FF007Faa)'
  },
  {
    id: 'spotify-emerald',
    nombre: 'Esmeralda Neón',
    subtitulo: 'Verde Spotify eléctrico',
    colorPrincipal: '#1ED760',
    colorSecundario: '#0b5b2e',
    colorTerciario: '#10b981',
    colorFondo: '#061a10',
    filtroAnillo: 'hue-rotate(320deg) saturate(2.5) drop-shadow(0 0 24px #1ED760) drop-shadow(0 0 50px #10b981aa)'
  },
  {
    id: 'sunset-amber',
    nombre: 'Atardecer Dorado',
    subtitulo: 'Fuego y ámbar cálido',
    colorPrincipal: '#f59e0b',
    colorSecundario: '#ea580c',
    colorTerciario: '#e11d48',
    colorFondo: '#210a04',
    filtroAnillo: 'hue-rotate(220deg) saturate(2.8) drop-shadow(0 0 24px #f59e0b) drop-shadow(0 0 50px #ea580caa)'
  }
];

export function obtenerTemaPorCancion(cancion?: Cancion | null): TemaVisualFondo {
  if (!cancion) return TEMAS_VISUALES[0];
  const texto = `${cancion.nombre}_${cancion.artista || ''}`;
  let hash = 0;
  for (let i = 0; i < texto.length; i++) {
    hash = (hash << 5) - hash + texto.charCodeAt(i);
    hash |= 0;
  }
  const idx = Math.abs(hash) % TEMAS_VISUALES.length;
  return TEMAS_VISUALES[idx];
}

interface FondoAnimadoProps {
  tema: TemaVisualFondo;
  reproduciendo: boolean;
  activo?: boolean;
  modoAppRoot?: boolean;
}

const FondoAnimado: React.FC<FondoAnimadoProps> = React.memo(({ tema, reproduciendo, activo = true, modoAppRoot = false }) => {
  if (!activo) return null;

  const esMovil = useMemo(() => esDispositivoMovil(), []);
  const opacidadObjetivo = modoAppRoot ? 0.48 : 0.62;

  const [temaActual, setTemaActual] = useState<TemaVisualFondo>(tema);
  const [temaPrevio, setTemaPrevio] = useState<TemaVisualFondo | null>(null);
  const [entranteVisible, setEntranteVisible] = useState<boolean>(true);
  const [animandoCambio, setAnimandoCambio] = useState<boolean>(false);
  const timerAnimacionRef = useRef<any>(null);

  useEffect(() => {
    if (tema.id !== temaActual.id) {
      setTemaPrevio(temaActual);
      setTemaActual(tema);
      setEntranteVisible(false);
      setAnimandoCambio(true);

      const raf = requestAnimationFrame(() => {
        setEntranteVisible(true);
      });

      if (timerAnimacionRef.current) clearTimeout(timerAnimacionRef.current);
      timerAnimacionRef.current = setTimeout(() => {
        setTemaPrevio(null);
        setAnimandoCambio(false);
      }, 1300);

      return () => cancelAnimationFrame(raf);
    }
  }, [tema.id]);

  useEffect(() => {
    return () => {
      if (timerAnimacionRef.current) clearTimeout(timerAnimacionRef.current);
    };
  }, []);

  // En móvil/Capacitor: Transición cruzada suave (1.2s ease-in-out) sin backdrop-filter pesado
  if (esMovil) {
    const acento = temaActual.colorPrincipal || '#1ED760';
    return (
      <div
        className={`aura-container ${modoAppRoot ? 'aura-app-root' : ''}`}
        style={{
          position: modoAppRoot ? 'fixed' : 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 0,
          pointerEvents: 'none',
          backgroundColor: '#0b0b0f',
          overflow: 'hidden'
        }}
      >
        {temaPrevio && temaPrevio.imagenUrl && (
          <div
            key={`mob-prev-${temaPrevio.id}`}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundImage: `url(${temaPrevio.imagenUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center center',
              backgroundRepeat: 'no-repeat',
              opacity: opacidadObjetivo,
              zIndex: 1
            }}
          />
        )}
        {temaActual.imagenUrl && (
          <div
            key={`mob-curr-${temaActual.id}`}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundImage: `url(${temaActual.imagenUrl})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center center',
              backgroundRepeat: 'no-repeat',
              opacity: entranteVisible ? opacidadObjetivo : 0,
              transition: 'opacity 1.2s ease-in-out',
              zIndex: 2
            }}
          />
        )}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: temaActual.imagenUrl
              ? 'linear-gradient(180deg, rgba(10,10,14,0.68) 0%, rgba(10,10,14,0.14) 28%, rgba(10,10,14,0.14) 66%, rgba(10,10,14,0.88) 100%)'
              : `radial-gradient(ellipse at 50% -5%, ${acento}28 0%, rgba(16, 16, 20, 0.96) 72%, #0e0e12 100%)`,
            zIndex: 3
          }}
        />
      </div>
    );
  }

  return (
    <div className={`aura-container ${modoAppRoot ? 'aura-app-root' : ''} ${reproduciendo ? 'aura-playing' : 'aura-paused'}`}>
      {/* Capa de fondo saliente con desvanecimiento suave */}
      {temaPrevio && temaPrevio.imagenUrl && (
        <div
          key={`prev-${temaPrevio.id}`}
          className="fondo-wallpaper-layer"
          style={{
            backgroundImage: `url(${temaPrevio.imagenUrl})`,
            opacity: opacidadObjetivo,
            zIndex: 0
          }}
        />
      )}

      {/* Capa de fondo actual con entrada cinemática fluida */}
      {temaActual.imagenUrl && (
        <div
          key={`curr-${temaActual.id}`}
          className="fondo-wallpaper-layer"
          style={{
            backgroundImage: `url(${temaActual.imagenUrl})`,
            opacity: entranteVisible ? opacidadObjetivo : 0,
            transition: 'opacity 1.2s ease-in-out',
            zIndex: 1
          }}
        />
      )}

      {/* Destello de color neón en el instante del cambio de fondo */}
      {animandoCambio && (
        <div
          className="fondo-cambio-destello"
          style={{
            background: `radial-gradient(circle at 50% 50%, ${temaActual.colorPrincipal}44 0%, transparent 70%)`,
            zIndex: 2
          }}
        />
      )}

      {/* Orbes de luz sólo si no hay imagen fotográfica */}
      {!temaActual.imagenUrl && (
        <>
          <div
            className="aura-orb aura-orb-1"
            style={{
              backgroundColor: temaActual.colorPrincipal,
              boxShadow: `0 0 160px ${temaActual.colorPrincipal}`
            }}
          />
          <div
            className="aura-orb aura-orb-2"
            style={{
              backgroundColor: temaActual.colorSecundario,
              boxShadow: `0 0 160px ${temaActual.colorSecundario}`
            }}
          />
          <div
            className="aura-orb aura-orb-3"
            style={{
              backgroundColor: temaActual.colorTerciario,
              boxShadow: `0 0 140px ${temaActual.colorTerciario}`
            }}
          />
        </>
      )}

      {/* Capa de malla difusa y velo oscuro para legibilidad superior */}
      <div className="aura-overlay" />
    </div>
  );
});

interface CancionFilaProps {
  cancion: Cancion;
  estaSonando: boolean;
  esActual: boolean;
  reemplazando?: boolean;
  onReproducir: (cancion: Cancion) => void;
  onAlternarFavorito: (nombre: string, e: React.MouseEvent) => void;
  onAbrirMenu: (cancion: Cancion, e: React.MouseEvent) => void;
  onExportar?: (cancion: Cancion, e: React.MouseEvent) => void;
  onAgregarACola?: (cancion: Cancion, e: React.MouseEvent) => void;
  onReemplazarOriginal?: (cancion: Cancion, e: React.MouseEvent) => void;
  onEliminar?: (nombre: string, e: React.MouseEvent) => void;
}

const CancionFila = React.memo<CancionFilaProps>(({
  cancion,
  estaSonando,
  esActual,
  reemplazando,
  onReproducir,
  onAlternarFavorito,
  onAbrirMenu,
  onExportar,
  onAgregarACola,
  onReemplazarOriginal,
  onEliminar
}) => {
  return (
    <div
      onClick={() => onReproducir(cancion)}
      className={`song-row ${esActual ? 'song-activa' : ''}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        cursor: 'pointer',
        gap: '12px',
        marginBottom: '8px'
      }}
    >
      {/* Artwork & Title */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', minWidth: 0, flex: 1 }}>
        <div style={{
          width: '46px',
          height: '46px',
          backgroundColor: '#242428',
          borderRadius: '8px',
          border: '1px solid rgba(255, 255, 255, 0.15)',
          overflow: 'hidden',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0
        }}>
          {estaSonando ? (
            <SpotifyEqualizer animando={true} color="#1ED760" />
          ) : cancion.caratula ? (
            <img
              src={cancion.caratula}
              alt={cancion.nombre}
              width={46}
              height={46}
              style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => { (e.currentTarget as HTMLElement).style.display = 'none'; }}
              loading="lazy"
              decoding="async"
            />
          ) : esActual ? (
            <SpotifyEqualizer animando={false} color="#1ED760" />
          ) : (
            <IconNota size={20} color="#CBD5E1" />
          )}
        </div>

        <div style={{ minWidth: 0, flex: 1 }}>
          <p style={{
            margin: 0,
            fontSize: '14.5px',
            fontWeight: '700',
            color: estaSonando ? '#1ED760' : '#FFFFFF',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.2px'
          }}>
            {cancion.nombre}
          </p>
          <p style={{ margin: '3px 0 0 0', fontSize: '12px', color: '#CBD5E1', fontWeight: '500' }}>
            {cancion.artista ? `${cancion.artista} • ` : ''}
            {formatearTiempo(cancion.duracion)}
            {cancion.tamano > 0 ? ` • ${formatearTamano(cancion.tamano)}` : ''}
          </p>
        </div>
      </div>

      {/* Favorite, Export MP3, Add to Queue & Sleek Context Menu Button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
        {onAgregarACola && (
          <button
            onClick={(e) => onAgregarACola(cancion, e)}
            title="➕ Agregar a la fila de reproducción"
            style={{
              background: 'rgba(30, 215, 96, 0.08)',
              border: '1px solid rgba(30, 215, 96, 0.25)',
              borderRadius: '500px',
              cursor: 'pointer',
              padding: '4px 8px',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              color: '#1ED760',
              fontSize: '11px',
              fontWeight: '700',
              transition: 'all 0.15s ease'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(30, 215, 96, 0.18)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(30, 215, 96, 0.08)'; }}
          >
            <span>+ Fila</span>
          </button>
        )}

        {onExportar && (
          <button
            onClick={(e) => onExportar(cancion, e)}
            title="Guardar archivo MP3 en Descargas"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '6px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#1ED760',
              opacity: 0.85,
              transition: 'transform 0.15s ease'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.15)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
          >
            <IconDescargar size={17} color="#1ED760" />
          </button>
        )}

        <button
          onClick={(e) => onAlternarFavorito(cancion.nombre, e)}
          title={cancion.favorito ? 'Quitar de favoritos' : 'Agregar a favoritos'}
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: cancion.favorito ? '#1ED760' : '#94A3B8'
          }}
        >
          <IconCorazon size={20} lleno={cancion.favorito} />
        </button>

        {onReemplazarOriginal && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReemplazarOriginal(cancion, e);
            }}
            disabled={reemplazando}
            title="🔄 Reemplazar con versión original de estudio del artista"
            style={{
              background: reemplazando ? 'rgba(30, 215, 96, 0.2)' : 'rgba(255, 255, 255, 0.06)',
              border: '1px solid rgba(255, 255, 255, 0.14)',
              borderRadius: '50%',
              width: '30px',
              height: '30px',
              position: 'relative',
              zIndex: 5,
              cursor: reemplazando ? 'wait' : 'pointer',
              padding: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '13px',
              transition: 'transform 0.15s ease, background-color 0.15s ease'
            }}
            onMouseEnter={(e) => { if (!reemplazando) e.currentTarget.style.backgroundColor = 'rgba(30, 215, 96, 0.22)'; }}
            onMouseLeave={(e) => { if (!reemplazando) e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.06)'; }}
          >
            {reemplazando ? <IconSpinner size={14} color="#1ED760" /> : <span>🔄</span>}
          </button>
        )}

        {onEliminar && (
          <button
            onClick={(e) => onEliminar(cancion.nombre, e)}
            title="Eliminar canción"
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '5px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '13px',
              opacity: 0.78
            }}
          >
            <span>🗑️</span>
          </button>
        )}

        <button
          onClick={(e) => onAbrirMenu(cancion, e)}
          title="Opciones"
          style={{
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '6px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#94A3B8'
          }}
        >
          <IconPuntos size={20} color="#CBD5E1" />
        </button>
      </div>
    </div>
  );
}, (prev, next) => (
  prev.estaSonando === next.estaSonando &&
  prev.esActual === next.esActual &&
  prev.reemplazando === next.reemplazando &&
  prev.cancion.nombre === next.cancion.nombre &&
  prev.cancion.artista === next.cancion.artista &&
  prev.cancion.caratula === next.cancion.caratula &&
  prev.cancion.duracion === next.cancion.duracion &&
  prev.cancion.tamano === next.cancion.tamano &&
  prev.cancion.favorito === next.cancion.favorito &&
  prev.onReproducir === next.onReproducir &&
  prev.onAlternarFavorito === next.onAlternarFavorito &&
  prev.onAbrirMenu === next.onAbrirMenu &&
  prev.onExportar === next.onExportar &&
  prev.onAgregarACola === next.onAgregarACola &&
  prev.onReemplazarOriginal === next.onReemplazarOriginal &&
  prev.onEliminar === next.onEliminar
));

function App() {
  // Pestaña activa: Inicio (estilo Spotify) por defecto
  const [tabActiva, setTabActiva] = useState<TabNavegacion>('inicio');

  // Búsqueda en internet y descarga
  const [busquedaWeb, setBusquedaWeb] = useState('');
  const [descargando, setDescargando] = useState(false);
  const [textoDescarga, setTextoDescarga] = useState('');
  const [pasoDescarga, setPasoDescarga] = useState<1 | 2 | 3>(1);
  const [infoPistaDescarga, setInfoPistaDescarga] = useState<{
    title: string;
    artist?: string;
    thumbnail?: string;
    formato?: string;
  } | null>(null);
  const [resultadosBusqueda, setResultadosBusqueda] = useState<ResultadoBusqueda[]>([]);
  const [buscandoCanciones, setBuscandoCanciones] = useState(false);
  const [terminoBuscado, setTerminoBuscado] = useState('');
  const [descargandoId, setDescargandoId] = useState<string | null>(null);
  const [seleccionadosDescarga, setSeleccionadosDescarga] = useState<string[]>([]);
  const [sugerenciasVisibles, setSugerenciasVisibles] = useState(false);
  const [mostrarBotonCancelarDescarga, setMostrarBotonCancelarDescarga] = useState(false);
  const cancelDescargaRef = useRef<(() => void) | null>(null);

  // Estado de Vista Previa / Escuchar antes de descargar
  const [previewActivo, setPreviewActivo] = useState<EstadoPreview | null>(null);
  const audioPreviewRef = useRef<HTMLAudioElement | null>(null);

  // Configuración del servidor backend para descargas en cualquier dispositivo
  const [backendUrlConfig, setBackendUrlConfig] = useState(() => obtenerBackendBaseUrl() || BACKEND_URL_DEFAULT);
  const [probandoServidor, setProbandoServidor] = useState(false);
  const [estadoServidor, setEstadoServidor] = useState<{ ok: boolean; mensaje: string } | null>(null);

  // Historial de temas escuchados recientemente
  const { historial: historialEscucha, agregarAlHistorial, limpiarHistorial: limpiarHistorialEscucha } = useHistorialEscucha();

  // Interruptor de Autoplay inteligente / Radio infinita (activo por defecto)
  const [autoplayRadio, setAutoplayRadio] = useState<boolean>(() => {
    try {
      return localStorage.getItem('app_musica_autoplay_radio') !== 'false';
    } catch {
      return true;
    }
  });

  const toggleAutoplayRadio = (nuevo: boolean) => {
    setAutoplayRadio(nuevo);
    try {
      localStorage.setItem('app_musica_autoplay_radio', nuevo ? 'true' : 'false');
    } catch (_) {}
    mostrarToast(nuevo ? '✨ Autoplay activado: radio infinita' : 'Autoplay desactivado', 'info');
  };

  // Almacenamiento persistente
  const [almacenamientoProtegido, setAlmacenamientoProtegido] = useState(false);

  // Biblioteca y Playlists (Inicialización 100% síncrona desde catalogo_metadatos_ligero en < 1ms al montar)
  const [biblioteca, setBiblioteca] = useState<Cancion[]>(() => {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('catalogo_metadatos_ligero') : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const lista: Cancion[] = parsed.map((item: any) => ({
            nombre: item.nombre,
            tamano: item.tamano || 0,
            duracion: item.duracion || 0,
            favorito: !!item.favorito,
            fecha: item.fecha || Date.now(),
            caratula: item.caratula,
            artista: item.artista,
            album: item.album,
            exportada: !!item.exportada,
            descargada: item.descargada !== false,
            origen: item.origen || 'descarga',
            tituloLower: normalizarParaBusqueda(item.nombre),
            artistaLower: normalizarParaBusqueda(item.artista)
          }));
          lista.sort((a, b) => a.nombre.localeCompare(b.nombre));
          return lista;
        }
      }
    } catch (_) {}
    return [];
  });
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistSeleccionada, setPlaylistSeleccionada] = useState<Playlist | null>(null);
  const [filtroBiblioteca, setFiltroBiblioteca] = useState<FiltroBiblioteca>('todas');
  const [busquedaLocal, setBusquedaLocal] = useState('');
  const busquedaLocalDebounced = useDebounce(busquedaLocal, 180);
  const mainContentRef = useRef<HTMLElement | null>(null);
  const [criterioOrden, setCriterioOrden] = useState<CriterioOrden>('recientes');

  // Modales y Alertas modernas
  const [modalPlaylistAbierto, setModalPlaylistAbierto] = useState(false);
  const [cancionParaPlaylist, setCancionParaPlaylist] = useState<Cancion | null>(null);
  const [menuCancion, setMenuCancion] = useState<Cancion | null>(null);
  const alAbrirMenuCancion = useCallback((c: Cancion, e: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setMenuCancion(c);
  }, []);
  const [nombreNuevaPlaylist, setNombreNuevaPlaylist] = useState('');
  const [cancionesSeleccionadasPlaylist, setCancionesSeleccionadasPlaylist] = useState<string[]>([]);
  const [filtroCancionModalPlaylist, setFiltroCancionModalPlaylist] = useState('');

  // Modal para agregar canciones a una playlist existente
  const [modalAgregarAPlaylistAbierto, setModalAgregarAPlaylistAbierto] = useState(false);
  const [playlistDestinoAgregar, setPlaylistDestinoAgregar] = useState<Playlist | null>(null);
  const [cancionesSeleccionadasParaAgregar, setCancionesSeleccionadasParaAgregar] = useState<string[]>([]);
  const [filtroCancionesParaAgregar, setFiltroCancionesParaAgregar] = useState('');
  const [modalColaAbierto, setModalColaAbierto] = useState(false);
  const [modalTimerAbierto, setModalTimerAbierto] = useState(false);
  const [procesandoRespaldo, setProcesandoRespaldo] = useState(false);

  // Modal de confirmación estilizado
  const [modalConfirmacion, setModalConfirmacion] = useState<ModalConfirmacionState>({
    abierto: false,
    titulo: '',
    mensaje: '',
    textoConfirmar: 'Confirmar',
    peligroso: false,
    onConfirmar: () => {}
  });

  // Estado para detección silenciosa de nueva versión OTA en Render
  const [hayNuevaVersionOta, setHayNuevaVersionOta] = useState<boolean>(false);

  // Estado del Importador de Playlists de Spotify por Enlace
  interface PistaSpotifyImport {
    id: string;
    title: string;
    artist: string;
    thumbnail: string;
    seconds: number;
    timestamp: string;
  }
  const [modalSpotifyAbierto, setModalSpotifyAbierto] = useState<boolean>(false);
  const [urlSpotifyInput, setUrlSpotifyInput] = useState<string>('');
  const [analizandoSpotify, setAnalizandoSpotify] = useState<boolean>(false);
  const [playlistSpotifyInfo, setPlaylistSpotifyInfo] = useState<{
    playlistId: string;
    nombre: string;
    caratula: string;
    canciones: PistaSpotifyImport[];
  } | null>(null);
  const [seleccionadasSpotify, setSeleccionadasSpotify] = useState<string[]>([]);
  const [fallidasSpotifyIds, setFallidasSpotifyIds] = useState<string[]>([]);
  const [importandoColaSpotify, setImportandoColaSpotify] = useState<boolean>(false);
  const [reemplazandoCancionNombre, setReemplazandoCancionNombre] = useState<string | null>(null);
  const [reparandoBiblioteca, setReparandoBiblioteca] = useState<boolean>(false);
  const [preescuchaPendiente, setPreescuchaPendiente] = useState<DatosPreescucha | null>(null);
  const [guardandoPreescucha, setGuardandoPreescucha] = useState<boolean>(false);
  const [cancionAReemplazarClave, setCancionAReemplazarClave] = useState<string | null>(null);
  const [estadoOta, setEstadoOta] = useState<EstadoOta>('idle');
  const [mensajeOta, setMensajeOta] = useState<string>('');
  const [importandoMusicaPropia, setImportandoMusicaPropia] = useState<boolean>(false);
  const [progresoImportacion, setProgresoImportacion] = useState<ProgresoImportacion | null>(null);
  const inputImportarMusicaRef = useRef<HTMLInputElement | null>(null);
  const [modalOriginalAbierto, setModalOriginalAbierto] = useState<boolean>(false);
  const [cancionParaOriginal, setCancionParaOriginal] = useState<Cancion | null>(null);
  const [candidatosOriginales, setCandidatosOriginales] = useState<Array<{
    videoId: string;
    titulo: string;
    canal: string;
    duracionSeg: number;
    esOficial: boolean;
  }>>([]);
  const [cargandoCandidatosOriginales, setCargandoCandidatosOriginales] = useState<boolean>(false);
  const [reproduciendoPreviewOriginalId, setReproduciendoPreviewOriginalId] = useState<string | null>(null);
  const [descargandoCandidatoOriginalId, setDescargandoCandidatoOriginalId] = useState<string | null>(null);
  const previewOriginalAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewOriginalTimerRef = useRef<number | null>(null);
  const [progresoColaSpotify, setProgresoColaSpotify] = useState<{
    actual: number;
    total: number;
    tituloActual: string;
    completadas: number;
    omitidas: number;
    fallidas: number;
  } | null>(null);
  const cancelarColaSpotifyRef = useRef<boolean>(false);

  // Toasts
  const [toasts, setToasts] = useState<ToastInfo[]>([]);

  // Reproductor
  const [cancionActual, setCancionActual] = useState<Cancion | null>(null);
  const [reproduciendo, setReproduciendo] = useState(false);
  const [duracionTotal, setDuracionTotal] = useState(0);
  const duracionTotalRef = useRef(0);
  duracionTotalRef.current = duracionTotal;
  // tiempoActual desacoplado por completo: emite a audioProgress sin re-renderizar App.tsx
  const setTiempoActual = useCallback((t: number) => {
    audioProgress.emit(t, duracionTotal);
  }, [duracionTotal]);
  const [reproductorExpandido, setReproductorExpandido] = useState(false);
  const [mensajeErrorAudio, setMensajeErrorAudio] = useState<string | null>(null);
  const [arrastrandoSeek, setArrastrandoSeek] = useState(false);

  // Motor de Crossfade / Automix Continuo Estilo Spotify (Activado por defecto en 5s para mezcla fluida real)
  const [crossfadeSegundos, setCrossfadeSegundos] = useState<number>(() => {
    try {
      const g = localStorage.getItem('app_musica_crossfade_v31');
      if (g !== null) {
        const n = parseInt(g, 10);
        if ([0, 3, 5, 8, 12].includes(n)) return n;
      }
    } catch (_) {}
    return 5;
  });
  const crossfadeSegundosRef = useRef<number>(crossfadeSegundos);
  useEffect(() => {
    crossfadeSegundosRef.current = crossfadeSegundos;
  }, [crossfadeSegundos]);

  // Mix suave también al cambiar de canción manualmente (botón Siguiente / Mix Ya / DJ Mix)
  const [mixManualActivo, setMixManualActivo] = useState<boolean>(() => {
    try {
      const g = localStorage.getItem('app_musica_mix_manual_v31');
      return g !== 'false';
    } catch (_) {
      return true;
    }
  });
  const mixManualActivoRef = useRef<boolean>(mixManualActivo);
  useEffect(() => {
    mixManualActivoRef.current = mixManualActivo;
  }, [mixManualActivo]);

  // Sistema de Bass Boost Auto-Adaptativo de un solo botón (Audio Puro 0.0 dB en Off, Pre-atenuación -4.5 dB + Lowshelf 65Hz en On)
  const [bassBoostActivo, setBassBoostActivo] = useState<boolean>(() => bassBoostManager.isActivo());

  const [enTransicionMix, setEnTransicionMix] = useState(false);
  const [progresoMix, setProgresoMix] = useState<number>(0);
  const [cancionSalienteMix, setCancionSalienteMix] = useState<string>('');
  const crossfadingRef = useRef(false);
  const crossfadeIntervalRef = useRef<any>(null);
  const precargaMixRef = useRef<{
    nombre: string;
    cancion: Cancion;
    url: string;
    cueIn: number;
    cueOut: number;
    replayGainDb: number;
  } | null>(null);
  const cueOutActualRef = useRef<number>(0);
  const precargandoMixRef = useRef<boolean>(false);
  const swipeTouchStartXRef = useRef<number | null>(null);
  const swipeTouchStartYRef = useRef<number | null>(null);

  // Motor Híbrido Dual-Deck Estilo Spotify Automix (Deck A y Deck B para superposición Equal-Power)
  const deckARef = useRef<HTMLAudioElement | null>(null);
  const deckBRef = useRef<HTMLAudioElement | null>(null);
  const deckActivoRef = useRef<'A' | 'B'>('A');
  const [, setDeckActivo] = useState<'A' | 'B'>('A');
  const urlDeckARef = useRef<string | null>(null);
  const urlDeckBRef = useRef<string | null>(null);
  const decksDesbloqueadosRef = useRef<boolean>(false);
  const intentosFallidosConsecutivosRef = useRef<number>(0);
  const ultimoSkipRemotoTimestampRef = useRef<number>(0);

  // Referencias para el Watchdog Anti-Congelamiento (stall / suspend / waiting / 3.5s sin avance)
  const ultimoAvanceTimestampRef = useRef<number>(Date.now());
  const ultimoCurrentTimeRef = useRef<number>(0);
  const finPistaDetectadoTimestampRef = useRef<number>(0);
  const recuperandoStallRef = useRef<boolean>(false);
  const ignorandoPausaSalienteRef = useRef<boolean>(false);
  const pausadoPorUsuarioRef = useRef<boolean>(false);

  const programarRevocacionUrlAnterior = () => {
    // La revocación de Blob URL se maneja de forma segura tras finalizar la transición
  };

  const cambiandoPistaRef = useRef(false);
  const pistaHistorialRegistradaRef = useRef<string | null>(null);

  // Estado de paginación para modal de playlists
  const [limiteModalPlaylist, setLimiteModalPlaylist] = useState(40);

  const getActiveDeckEl = (): HTMLAudioElement | null =>
    deckActivoRef.current === 'A' ? deckARef.current : deckBRef.current;
  const getInactiveDeckEl = (): HTMLAudioElement | null =>
    deckActivoRef.current === 'A' ? deckBRef.current : deckARef.current;

  // Wake Lock API para evitar suspensión de música en móviles o bloqueo de pantalla
  const wakeLockRef = useRef<any>(null);

  const solicitarWakeLock = async () => {
    try {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible' && 'wakeLock' in navigator && !wakeLockRef.current) {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
        wakeLockRef.current.addEventListener('release', () => {
          wakeLockRef.current = null;
        });
      }
    } catch (_) {}
  };

  const soltarWakeLock = () => {
    try {
      if (wakeLockRef.current) {
        wakeLockRef.current.release();
        wakeLockRef.current = null;
      }
    } catch (_) {}
  };

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) {
        // Reproductor único activo en segundo plano: si la app pasa a segundo plano durante un crossfade,
        // consolidar inmediatamente el Deck activo único y liberar el Deck saliente para que Android no pierda la sesión multimedia.
        if (crossfadingRef.current || smartAutomixEngine.isMixing()) {
          cancelarCrossfadeRef.current();
        }
      } else if (reproduciendoRef.current) {
        solicitarWakeLock();
      }
      if (cancionActualRef.current) {
        actualizarMediaSessionRef.current();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  // Pre-desbloqueo de ambos decks y AudioContext no bloqueante en interacciones de usuario para habilitar Crossfade
  const desbloquearAmbosDecks = () => {
    try {
      bassBoostManager.asegurarActivo();
      if (!decksDesbloqueadosRef.current) {
        const inactivo = getInactiveDeckEl();
        if (inactivo && !inactivo.src) {
          inactivo.muted = true;
          inactivo.load();
          inactivo.muted = false;
          decksDesbloqueadosRef.current = true;
        }
      }
    } catch (_) {}
  };

  // Modos de reproducción
  const [modoAleatorio, setModoAleatorio] = useState<boolean>(() => {
    try {
      return localStorage.getItem('app_musica_aleatorio') === 'true';
    } catch (_) {
      return false;
    }
  });
  const [modoRepeticion, setModoRepeticion] = useState<ModoRepeticion>(() => {
    try {
      const g = localStorage.getItem('app_musica_repeticion');
      if (g === 'all' || g === 'one' || g === 'off') return g;
    } catch (_) {}
    return 'all';
  });
  const [colaReproduccion, setColaReproduccion] = useState<Cancion[]>([]);
  const [, setHistorialAleatorio] = useState<string[]>([]);
  const historialAleatorioRef = useRef<string[]>([]);
  const ultimaTransicionTimestampRef = useRef<number>(0);
  const reproduccionTokenRef = useRef<number>(0);
  const inicioPistaTimestampRef = useRef<number>(0);
  const crossfadeOrigenDeckRef = useRef<'A' | 'B' | null>(null);
  const cancionActualRef = useRef<Cancion | null>(null);
  const reproduciendoRef = useRef<boolean>(false);
  const arrastrandoSeekRef = useRef<boolean>(false);
  const colaReproduccionRef = useRef<Cancion[]>([]);
  const listaParaReproduccionRef = useRef<Cancion[]>([]);
  const listaContextoRef = useRef<Cancion[]>([]);
  const bibliotecaRef = useRef<Cancion[]>([]);
  const modoAleatorioRef = useRef<boolean>(modoAleatorio);
  const modoRepeticionRef = useRef<ModoRepeticion>(modoRepeticion);
  const playlistSeleccionadaRef = useRef<Playlist | null>(null);
  const alTerminarPistaRef = useRef<() => void>(() => {});
  const reproducirSiguienteRef = useRef<(forzarDirectoOEvento?: boolean | React.MouseEvent) => void>(() => {});
  const reproducirAnteriorRef = useRef<() => void>(() => {});
  const alternarReproduccionRef = useRef<(forzar?: boolean) => void>(() => {});
  const saltarTiempoRef = useRef<(segs: number) => void>(() => {});
  const saltarATiempoRef = useRef<(destinoSegundos: number) => void>(() => {});
  const cancelarCrossfadeRef = useRef<() => void>(() => {});
  const actualizarMediaSessionRef = useRef<() => void>(() => {});

  // Estado del Tema Visual Dinámico y Animación de Fondo
  const [temaSeleccionadoManual, setTemaSeleccionadoManual] = useState<string | null>(null);
  const [modalSelectorFondosAbierto, setModalSelectorFondosAbierto] = useState<boolean>(false);

  // Modal de Más Formatos y Calidades (Estilo Screenshot del usuario)
  const [modalFormatosAbierto, setModalFormatosAbierto] = useState<boolean>(false);
  const [itemParaDescargar, setItemParaDescargar] = useState<ResultadoBusqueda | null>(null);
  const [formatoSeleccionado, setFormatoSeleccionado] = useState<string>('mp3');
  const ultimoToqueFormatoRef = useRef<{ id: string; timestamp: number }>({ id: '', timestamp: 0 });

  const abrirSelectorFormatos = (item: ResultadoBusqueda) => {
    setItemParaDescargar(item);
    setFormatoSeleccionado('mp3');
    setModalFormatosAbierto(true);
  };

  // Intervalo de cambio de fondos (por defecto 12 segundos, configurable: 10, 12, 15, 18, 20, 30)
  const [intervaloFondosSegundos, setIntervaloFondosSegundos] = useState<number>(() => {
    try {
      const g = localStorage.getItem('app_musica_intervalo_fondos');
      if (g) {
        const n = parseInt(g, 10);
        if ([10, 12, 15, 18, 20, 30].includes(n)) return n;
      }
    } catch (_) {}
    return 12;
  });

  const cambiarIntervaloFondos = (segs: number) => {
    setIntervaloFondosSegundos(segs);
    try {
      localStorage.setItem('app_musica_intervalo_fondos', segs.toString());
    } catch (_) {}
    mostrarToast(`Fondos cambiarán cada ${segs}s`);
  };

  // Modo Carrusel activado por defecto para que vayan pasando durante la canción reproducida
  const [modoCarruselFondos, setModoCarruselFondos] = useState<boolean>(() => {
    try {
      const g = localStorage.getItem('app_musica_carrusel_fondos');
      return g !== 'false';
    } catch (_) {
      return true;
    }
  });

  const alternarModoCarruselFondos = (forzar?: boolean) => {
    setModoCarruselFondos((prev) => {
      const nuevo = forzar !== undefined ? forzar : !prev;
      try {
        localStorage.setItem('app_musica_carrusel_fondos', nuevo ? 'true' : 'false');
      } catch (_) {}
      mostrarToast(
        nuevo
          ? `🔄 Carrusel activo: los fondos irán pasando cada ${intervaloFondosSegundos}s`
          : 'Carrusel desactivado',
        'info'
      );
      return nuevo;
    });
  };

  // --- FONDOS PERSONALIZADOS SUBIDOS POR EL USUARIO ---
  const [fondosPersonalizados, setFondosPersonalizados] = useState<TemaVisualFondo[]>([]);
  const inputFondoPersonalizadoRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    localforage.getItem<TemaVisualFondo[]>('app_fondos_personalizados').then((guardados) => {
      if (Array.isArray(guardados)) {
        setFondosPersonalizados(guardados);
      }
    }).catch(console.error);
  }, []);

  const todosLosTemas = useMemo(() => {
    return [...fondosPersonalizados, ...TEMAS_VISUALES];
  }, [fondosPersonalizados]);

  const subirFondoPersonalizado = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      mostrarToast('Por favor selecciona una imagen válida', 'error');
      return;
    }

    try {
      mostrarToast('Guardando fondo personalizado...', 'info');
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        const nombreLimpio = file.name.replace(/\.[^/.]+$/, '').slice(0, 24);
        const nuevoFondo: TemaVisualFondo = {
          id: `custom-${Date.now()}`,
          nombre: nombreLimpio || 'Fondo Propio',
          subtitulo: 'Fondo personalizado subido por ti',
          imagenUrl: dataUrl,
          colorPrincipal: '#38BDF8',
          colorSecundario: '#A855F7',
          colorTerciario: '#10B981',
          colorFondo: '#05070E',
          filtroAnillo: 'drop-shadow(0 0 26px #38BDF8) drop-shadow(0 0 55px #A855F7aa) brightness(1.25)'
        };

        const nuevaLista = [nuevoFondo, ...fondosPersonalizados];
        setFondosPersonalizados(nuevaLista);
        await localforage.setItem('app_fondos_personalizados', nuevaLista);

        setTemaSeleccionadoManual(nuevoFondo.id);
        mostrarToast('¡Fondo personalizado agregado con éxito!', 'exito');
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error('Error subiendo fondo:', err);
      mostrarToast('Error al procesar la imagen', 'error');
    } finally {
      if (e.target) e.target.value = '';
    }
  };

  const eliminarFondoPersonalizado = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    pedirConfirmacion({
      titulo: '¿Eliminar fondo personalizado?',
      mensaje: '¿Estás seguro de que deseas quitar este fondo de tu colección?',
      textoConfirmar: 'Eliminar',
      peligroso: true,
      onConfirmar: async () => {
        const nuevaLista = fondosPersonalizados.filter((f) => f.id !== id);
        setFondosPersonalizados(nuevaLista);
        await localforage.setItem('app_fondos_personalizados', nuevaLista);
        if (temaSeleccionadoManual === id) {
          setTemaSeleccionadoManual(null);
        }
        mostrarToast('Fondo personalizado eliminado');
      }
    });
  };

  const [animacionFondoActiva, setAnimacionFondoActiva] = useState<boolean>(() => {
    try {
      const g = localStorage.getItem('app_musica_fondo_animado');
      return g !== 'false';
    } catch (_) {
      return true;
    }
  });

  const avanzarSiguienteFondo = useCallback(() => {
    setTemaSeleccionadoManual((prevTemaId) => {
      const fondosConFoto = todosLosTemas.filter((t) => t.imagenUrl);
      if (fondosConFoto.length === 0) return prevTemaId;
      const idxActual = fondosConFoto.findIndex((t) => t.id === prevTemaId);
      const siguiente = fondosConFoto[(idxActual + 1) % fondosConFoto.length];
      return siguiente.id;
    });
  }, [todosLosTemas]);

  const temaVisualActual = useMemo<TemaVisualFondo>(() => {
    if (temaSeleccionadoManual) {
      const temaEncontrado = todosLosTemas.find((t) => t.id === temaSeleccionadoManual);
      if (temaEncontrado) return temaEncontrado;
    }
    return obtenerTemaPorCancion(cancionActual);
  }, [cancionActual, temaSeleccionadoManual, todosLosTemas]);

  // Contador regresivo en tiempo real para el paso de fondos
  const [tiempoRestanteFondo] = useState<number>(intervaloFondosSegundos);

  // Carrusel dinámico de fondos cada 12s mientras suena la música
  useEffect(() => {
    if (!modoCarruselFondos || !reproduciendo) return;

    const duracionMs = Math.max(10, intervaloFondosSegundos) * 1000;
    const timer = setInterval(() => {
      avanzarSiguienteFondo();
    }, duracionMs);

    return () => clearInterval(timer);
  }, [modoCarruselFondos, reproduciendo, intervaloFondosSegundos, avanzarSiguienteFondo]);

  // También rotar al siguiente fondo suavemente al cambiar de pista cuando el carrusel está activo
  useEffect(() => {
    if (modoCarruselFondos && cancionActual?.nombre) {
      avanzarSiguienteFondo();
    }
  }, [cancionActual?.nombre]);

  // --- SISTEMA DE LETRAS SINCRONIZADAS ESTILO SPOTIFY (LRCLIB API) ---
  const [infoLetra, setInfoLetra] = useState<InfoLetraCancion | null>(null);
  const [cargandoLetras, setCargandoLetras] = useState<boolean>(false);
  const [modalLetrasAbierto, setModalLetrasAbierto] = useState<boolean>(false);
  const listaLetrasRef = useRef<HTMLDivElement | null>(null);

  const cargarLetrasCancion = async (cancion: Cancion | null, forzarRefresco: boolean = false) => {
    if (!cancion) {
      setInfoLetra(null);
      return;
    }

    const cacheKey = `lyrics_${cancion.nombre}`;
    if (!forzarRefresco) {
      try {
        const enCache: any = await localforage.getItem(cacheKey);
        if (enCache && enCache.verificadaV3 === true && (enCache.lineas || enCache.textoPlano)) {
          setInfoLetra(enCache);
          return;
        } else if (enCache) {
          await localforage.removeItem(cacheKey);
        }
      } catch (_) {}
    }

    // Si no está en caché y estamos offline, no intentar peticiones a red
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setCargandoLetras(false);
      return;
    }

    setCargandoLetras(true);

    try {
      const parsed = parsearTituloYArtista(cancion.nombre, cancion.artista);
      const candidatos = parsed.candidatosBusqueda;

      const procesarItemLrclib = (item: any): InfoLetraCancion | null => {
        if (!item || item.instrumental) return null;
        let lineas: LineaLetra[] = [];
        let sincronizada = false;

        if (item.syncedLyrics) {
          lineas = parsearLRC(item.syncedLyrics);
          sincronizada = lineas.length > 0;
        } else if (item.plainLyrics) {
          lineas = item.plainLyrics
            .split('\n')
            .filter((l: string) => l.trim())
            .map((t: string, idx: number) => ({
              segundos: idx * 4,
              texto: t.trim()
            }));
        }

        if (lineas.length === 0) return null;

        return {
          id: cancion.nombre,
          sincronizada,
          lineas,
          textoPlano: item.plainLyrics || item.syncedLyrics || '',
          ...({ verificadaV3: true } as any)
        };
      };

      for (const cand of candidatos) {
        if (!cand.track) continue;

        // 1. Intento exacto en LRCLIB /api/get si hay artista
        if (cand.artist) {
          try {
            const exacto = await fetchJsonSeguro<any>(
              `https://lrclib.net/api/get?track_name=${encodeURIComponent(cand.track)}&artist_name=${encodeURIComponent(cand.artist)}`
            );
            if (exacto && (exacto.syncedLyrics || exacto.plainLyrics)) {
              if (esCoincidenciaExactaOValida(exacto.trackName, exacto.artistName, cand.track, cand.artist)) {
                const info = procesarItemLrclib(exacto);
                if (info) {
                  setInfoLetra(info);
                  await localforage.setItem(cacheKey, info);
                  setCargandoLetras(false);
                  return;
                }
              }
            }
          } catch (_) {}
        }

        // 2. Búsqueda estructurada en LRCLIB /api/search?track_name=&artist_name=
        try {
          const urlSearch = cand.artist
            ? `https://lrclib.net/api/search?track_name=${encodeURIComponent(cand.track)}&artist_name=${encodeURIComponent(cand.artist)}`
            : `https://lrclib.net/api/search?track_name=${encodeURIComponent(cand.track)}`;
          const items = await fetchJsonSeguro<any[]>(urlSearch);
          if (Array.isArray(items) && items.length > 0) {
            const coincidente = items.find((item: any) =>
              (item.syncedLyrics || item.plainLyrics) &&
              esCoincidenciaExactaOValida(item.trackName, item.artistName, cand.track, cand.artist)
            );
            if (coincidente) {
              const info = procesarItemLrclib(coincidente);
              if (info) {
                setInfoLetra(info);
                await localforage.setItem(cacheKey, info);
                setCargandoLetras(false);
                return;
              }
            }
          }
        } catch (_) {}

        // 3. Búsqueda libre en LRCLIB /api/search?q=
        try {
          const q = cand.artist ? `${cand.track} ${cand.artist}` : cand.track;
          const items = await fetchJsonSeguro<any[]>(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`);
          if (Array.isArray(items) && items.length > 0) {
            const coincidente = items.find((item: any) =>
              (item.syncedLyrics || item.plainLyrics) &&
              esCoincidenciaExactaOValida(item.trackName, item.artistName, cand.track, cand.artist)
            );
            if (coincidente) {
              const info = procesarItemLrclib(coincidente);
              if (info) {
                setInfoLetra(info);
                await localforage.setItem(cacheKey, info);
                setCargandoLetras(false);
                return;
              }
            }
          }
        } catch (_) {}
      }

      // Prohibido inventar letras: borrar cualquier caché previa y mostrar estado no disponible
      try {
        await localforage.removeItem(cacheKey);
        localStorage.removeItem(cacheKey);
      } catch (_) {}
      setInfoLetra(null);
    } catch (e) {
      console.warn('Error cargando letra verificada:', e);
      setInfoLetra(null);
    } finally {
      setCargandoLetras(false);
    }
  };

  useEffect(() => {
    pistaHistorialRegistradaRef.current = null;
    if (cancionActual) {
      cargarLetrasCancion(cancionActual);
    } else {
      setInfoLetra(null);
    }
  }, [cancionActual?.nombre]);

  // Purga de seguridad única de caché previa de letras en localStorage e IndexedDB y migración a v3.0.0
  useEffect(() => {
    const purgarCachesPrevias = async () => {
      try {
        const flagEngine = localStorage.getItem('app_musica_engine_v300');
        if (!flagEngine) {
          localStorage.setItem('app_musica_crossfade', '0');
          setCrossfadeSegundos(0);
          crossfadeSegundosRef.current = 0;
          localStorage.setItem('app_musica_engine_v300', 'true');
        }
        const flag = localStorage.getItem('app_musica_lyrics_purged_v300');
        if (!flag) {
          const lsKeys: string[] = [];
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && (k.startsWith('lyrics_') || k.includes('letra'))) {
              lsKeys.push(k);
            }
          }
          lsKeys.forEach((k) => {
            try { localStorage.removeItem(k); } catch (_) {}
          });

          const keys = await localforage.keys();
          for (const k of keys) {
            if (k.startsWith('lyrics_')) {
              await localforage.removeItem(k);
            }
          }
          localStorage.setItem('app_musica_lyrics_purged_v300', 'true');
        }
      } catch (_) {}
    };
    purgarCachesPrevias();
  }, []);

  // Soporte universal para audífonos Bluetooth (JBL Tune 520BT y otros) vía eventos multimedia de teclado
  useEffect(() => {
    const manejarTeclasBluetoothMedia = (e: KeyboardEvent) => {
      const k = e.key || e.code;
      const ahora = Date.now();
      if (k === 'MediaTrackNext') {
        e.preventDefault();
        if (ahora - ultimoSkipRemotoTimestampRef.current < 550) return;
        ultimoSkipRemotoTimestampRef.current = ahora;
        reproducirSiguienteRef.current(true);
      } else if (k === 'MediaTrackPrevious') {
        e.preventDefault();
        if (ahora - ultimoSkipRemotoTimestampRef.current < 550) return;
        ultimoSkipRemotoTimestampRef.current = ahora;
        reproducirAnteriorRef.current();
      } else if (k === 'MediaPlayPause') {
        e.preventDefault();
        alternarReproduccionRef.current();
      } else if (k === 'MediaPlay') {
        e.preventDefault();
        alternarReproduccionRef.current(true);
      } else if (k === 'MediaPause') {
        e.preventDefault();
        alternarReproduccionRef.current(false);
      } else if (k === 'MediaStop') {
        e.preventDefault();
        pausadoPorUsuarioRef.current = true;
        reproduciendoRef.current = false;
        const el = getActiveDeckEl();
        if (el) el.pause();
        setReproduciendo(false);
      }
    };

    window.addEventListener('keydown', manejarTeclasBluetoothMedia);
    return () => window.removeEventListener('keydown', manejarTeclasBluetoothMedia);
  }, []);

  // Índice de verso activo: Se suscribe a audioProgress ÚNICAMENTE cuando el modal de letras está abierto
  const [lineaActivaIndex, setLineaActivaIndex] = useState<number>(0);

  useEffect(() => {
    if (!modalLetrasAbierto || !infoLetra?.sincronizada || !infoLetra?.lineas || infoLetra.lineas.length === 0) return;
    return audioProgress.subscribe((curr) => {
      const lineas = infoLetra.lineas!;
      for (let i = lineas.length - 1; i >= 0; i--) {
        if (curr >= lineas[i].segundos - 0.25) {
          setLineaActivaIndex((prev) => (prev !== i ? i : prev));
          break;
        }
      }
    });
  }, [modalLetrasAbierto, infoLetra]);

  // Auto-scroll suave de la letra en pantalla completa al cambiar de verso
  useEffect(() => {
    if (!modalLetrasAbierto || lineaActivaIndex < 0 || !listaLetrasRef.current) return;
    const elActivo = listaLetrasRef.current.children[lineaActivaIndex] as HTMLElement;
    if (elActivo) {
      elActivo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [lineaActivaIndex, modalLetrasAbierto]);

  const alternarTemaVisual = () => {
    // Al presionar el botón de fondo, abre el selector visual directo
    setModalSelectorFondosAbierto(true);
  };

  // Control de Volumen y Velocidad Estilo Spotify
  const [volumen, setVolumen] = useState<number>(() => {
    try {
      const v = localStorage.getItem('app_musica_volumen');
      if (v !== null) return Math.max(0, Math.min(1, parseFloat(v)));
    } catch (_) {}
    return 1;
  });
  const [silenciado, setSilenciado] = useState(false);
  const [velocidad, setVelocidad] = useState<number>(1);

  // Temporizador de Apagado (Sleep Timer)
  const [timerOpcion, setTimerOpcion] = useState<number | null>(null); // minutos o -1
  const [timerFinTimestamp, setTimerFinTimestamp] = useState<number | null>(null);
  const [timerTextoRestante, setTimerTextoRestante] = useState<string>('');

  // Estado de Conectividad de Red (Modo Offline Real)
  const [estaOnline, setEstaOnline] = useState<boolean>(() => {
    return typeof navigator !== 'undefined' ? navigator.onLine : true;
  });

  useEffect(() => {
    const alConectar = () => {
      setEstaOnline(true);
      mostrarToast('Conexión reestablecida • Modo En Línea', 'exito');
    };
    const alDesconectar = () => {
      setEstaOnline(false);
    };

    window.addEventListener('online', alConectar);
    window.addEventListener('offline', alDesconectar);

    return () => {
      window.removeEventListener('online', alConectar);
      window.removeEventListener('offline', alDesconectar);
    };
  }, []);

  const inputFileRef = useRef<HTMLInputElement | null>(null);

  // Sistema de Notificaciones Toast
  const mostrarToast = (mensaje: string, tipo: 'exito' | 'error' | 'info' = 'exito') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, mensaje, tipo }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2500);
  };

  // Diálogo de Confirmación Moderno
  const pedirConfirmacion = (config: {
    titulo: string;
    mensaje: string;
    textoConfirmar?: string;
    peligroso?: boolean;
    onConfirmar: () => void;
  }) => {
    setModalConfirmacion({
      abierto: true,
      titulo: config.titulo,
      mensaje: config.mensaje,
      textoConfirmar: config.textoConfirmar || 'Confirmar',
      peligroso: !!config.peligroso,
      onConfirmar: () => {
        setModalConfirmacion((prev) => ({ ...prev, abierto: false }));
        config.onConfirmar();
      }
    });
  };

  // Inicialización, validación de conexión y persistencia (100% Offline-First)
  useEffect(() => {
    // 1. Cargar primero la biblioteca local (catalogo_metadatos_ligero + localforage) de inmediato sin esperar red
    cargarDatos();

    // 2. Si hay internet, lanzar ping silencioso a Render en segundo plano y comprobar si hay un nuevo Service Worker o versión OTA disponible
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setEstaOnline(false);
    } else {
      const baseCheck = (obtenerBackendBaseUrl() || BACKEND_URL_DEFAULT).replace(/\/$/, '');
      fetch(baseCheck + '/health?t=' + Date.now(), { cache: 'no-store' })
        .then(async (res) => {
          if (res && res.ok) {
            setEstaOnline(true);
            try {
              const data = await res.json();
              if (data && data.version && data.version !== 'v5.2.0') {
                setHayNuevaVersionOta(true);
              }
            } catch (_) {}
          }
        })
        .catch(() => {
          if (typeof navigator !== 'undefined' && !navigator.onLine) {
            setEstaOnline(false);
          }
        });

      // Comprobar también el archivo /sw.js remoto en segundo plano para detectar nuevo CACHE_NAME al instante
      fetch('/sw.js?t=' + Date.now(), { cache: 'no-store' })
        .then(async (rSw) => {
          if (rSw && rSw.ok) {
            const txt = await rSw.text();
            const m = txt.match(/CACHE_NAME\s*=\s*['"]([^'"]+)['"]/);
            if (m && m[1] && m[1] !== 'app-musica-v5.2.0') {
              setHayNuevaVersionOta(true);
            }
          }
        })
        .catch(() => {});

      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration().then((reg) => {
          if (reg) reg.update().catch(() => {});
        }).catch(() => {});
      }
    }

    // Limpieza preventiva de claves residuales ajenas (exámenes/evaluaciones) en localStorage e IndexedDB
    try {
      const examKeyRegex = /(?:examen|evaluacion|ambikon|lan[-_]?exam)/i;
      const keysAEliminar: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && examKeyRegex.test(key)) {
          keysAEliminar.push(key);
        }
      }
      keysAEliminar.forEach((k) => {
        try { localStorage.removeItem(k); } catch (_) {}
      });

      localforage.keys().then((allKeys) => {
        allKeys.forEach((k) => {
          if (examKeyRegex.test(k)) {
            localforage.removeItem(k).catch(() => {});
          }
        });
      }).catch(() => {});
    } catch (_) {}

    validarConexionStorage().then((estado) => {
      if (!estado.ok) {
        console.warn('[Storage]: Advertencia en almacenamiento local:', estado.mensaje);
      }
    });

    // Registrar validador global de URLs activas para que revocarUrlObjetoSegura jamás revoque una URL en uso
    registrarValidadorUrlActiva((urlCandidata: string) => {
      if (!urlCandidata) return false;
      const urlActivaA = urlDeckARef.current;
      const urlActivaB = urlDeckBRef.current;
      const srcA = deckARef.current?.src;
      const srcB = deckBRef.current?.src;
      const urlPrecarga = precargaMixRef.current?.url;
      return (
        urlCandidata === urlActivaA ||
        urlCandidata === urlActivaB ||
        urlCandidata === srcA ||
        urlCandidata === srcB ||
        urlCandidata === urlPrecarga
      );
    });

    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().then((persistido) => {
        setAlmacenamientoProtegido(persistido);
      }).catch(console.error);
    }

    return () => {
      if (urlDeckARef.current) {
        URL.revokeObjectURL(urlDeckARef.current);
      }
      if (urlDeckBRef.current) {
        URL.revokeObjectURL(urlDeckBRef.current);
      }
      if (crossfadeIntervalRef.current) {
        clearInterval(crossfadeIntervalRef.current);
      }
    };
  }, []);

  // Carga un Blob de audio individual bajo demanda desde IndexedDB (0 impacto en RAM de biblioteca)
  // Optimización Zero-Blob-Clone: evita re-empaquetar en un segundo Blob si ya es audio/* y libera memoria tras uso
  const obtenerBlobCancionBajoDemanda = async (nombre: string): Promise<Blob | null> => {
    try {
      const guardado: any = await localforage.getItem(nombre);
      if (guardado) {
        let b: Blob | null = null;
        if (guardado instanceof Blob) b = guardado;
        else if (guardado && typeof guardado === 'object' && guardado.blob instanceof Blob) b = guardado.blob;
        if (b && b.size > 0) {
          // Zero-Blob-Clone: retornar la referencia directa sin duplicar el buffer si ya tiene MIME de audio
          return b.type && b.type.startsWith('audio/') ? b : new Blob([b], { type: 'audio/mpeg' });
        }
      }
    } catch (err) {
      console.warn(`[obtenerBlobCancionBajoDemanda] Error al leer audio de "${nombre}":`, err);
    }

    // Salvavidas: Recuperación directa desde el almacenamiento físico del teléfono (/Music/AppMusica/)
    // En Android, si la pista ya está blindada en almacenamiento físico, no clonamos el Blob en el estado de React
    try {
      if (esAlmacenamientoNativoDisponible()) {
        const blobFisico = recuperarBlobCancionDesdeMemoriaFisica(nombre);
        if (blobFisico && blobFisico.size > 0) {
          console.log(`[Storage]: Canción "${nombre}" cargada directamente del almacenamiento físico del teléfono.`);
          // Solo cachear en IndexedDB si aún no estaba presente, sin retener referencias pesadas en RAM
          localforage.setItem(nombre, {
            nombre,
            blob: blobFisico,
            tamano: blobFisico.size,
            duracion: 0,
            descargada: true,
            origen: 'dispositivo_permanente'
          }).catch(() => {});
          return blobFisico;
        }
      }
    } catch (eFisico) {
      console.warn(`[Storage]: Error en fallback físico para "${nombre}":`, eFisico);
    }

    return null;
  };

  const CLAVE_CATALOGO_LIGERO = 'catalogo_metadatos_ligero';

  // Guarda catálogo de metadatos ligero en localStorage de forma diferida (cero bloqueos en el hilo principal)
  const guardarCatalogoLigero = (catalogo: Cancion[]) => {
    try {
      const datosPlanos = catalogo.map((c) => ({
        nombre: c.nombre,
        tamano: c.tamano || 0,
        duracion: c.duracion || 0,
        favorito: !!c.favorito,
        fecha: c.fecha || Date.now(),
        caratula: c.caratula,
        artista: c.artista,
        album: c.album,
        exportada: !!c.exportada,
        descargada: c.descargada !== false,
        origen: c.origen || 'descarga',
        verified: c.verified === true,
        sourceVersion: c.sourceVersion || c.origen || 'legacy_indexeddb',
        durationExpected: c.durationExpected,
        durationActual: typeof c.durationActual === 'number' ? c.durationActual : (c.duracion || 0),
        durationMatch: typeof c.durationMatch === 'boolean' ? c.durationMatch : undefined,
        flagReason: c.flagReason
      }));
      guardarStorageDiferido(CLAVE_CATALOGO_LIGERO, JSON.stringify(datosPlanos));
    } catch (e) {
      console.warn('[Catalogo]: No se pudo guardar índice ligero en localStorage:', e);
    }
  };

  // Carga un catálogo de texto ligero de localStorage (<1ms) con índices normalizados precalculados
  const leerCatalogoLigero = (): Cancion[] | null => {
    try {
      const raw = localStorage.getItem(CLAVE_CATALOGO_LIGERO);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map((item: any) => ({
            nombre: item.nombre,
            tamano: item.tamano || 0,
            duracion: item.duracion || 0,
            favorito: !!item.favorito,
            fecha: item.fecha || Date.now(),
            caratula: item.caratula,
            artista: item.artista,
            album: item.album,
            exportada: !!item.exportada,
            descargada: item.descargada !== false,
            origen: item.origen || 'descarga',
            verified: item.verified === true,
            sourceVersion: item.sourceVersion || item.origen || 'legacy_indexeddb',
            durationExpected: typeof item.durationExpected === 'number' ? item.durationExpected : undefined,
            durationActual: typeof item.durationActual === 'number' ? item.durationActual : (item.duracion || 0),
            durationMatch: typeof item.durationMatch === 'boolean' ? item.durationMatch : undefined,
            flagReason: item.flagReason,
            tituloLower: normalizarParaBusqueda(item.nombre),
            artistaLower: normalizarParaBusqueda(item.artista)
          }));
        }
      }
    } catch (e) {
      console.warn('[Catalogo]: Error leyendo catálogo ligero:', e);
    }
    return null;
  };

  const cargarPlaylists = async () => {
    try {
      const playlistsGuardadas = (await localforage.getItem<Playlist[]>('app_playlists')) || [];
      setPlaylists(playlistsGuardadas);
    } catch (e) {
      console.error('Error al cargar playlists:', e);
    }
  };

  // Hidratación en segundo plano en lotes de 3 canciones con pausas de 50ms para 0 bloqueos
  const migrarMetadatosEnSegundoPlano = async (claves: string[]) => {
    try {
      const mapa = new Map<string, Cancion>();
      const existente = leerCatalogoLigero() || [];
      for (const c of existente) {
        mapa.set(c.nombre, c);
      }

      const BATCH = 3;
      for (let i = 0; i < claves.length; i += BATCH) {
        const lote = claves.slice(i, i + BATCH);
        await Promise.all(
          lote.map(async (clave) => {
            try {
              const valor: any = await localforage.getItem(clave);
              if (!valor) return;
              let tamano = 0;
              let duracion = 0;
              let caratula: string | undefined = undefined;
              let artista: string | undefined = undefined;
              let favorito = false;
              let exportada = false;
              let fecha = Date.now();
              let origen: 'descarga' | 'local_importada' | 'cache' | 'dispositivo_permanente' = 'descarga';
              let verified = false;
              let sourceVersion = 'legacy_indexeddb';
              let durationExpected: number | undefined = undefined;
              let durationActual = 0;
              let flagReason: string | undefined = undefined;

              if (valor instanceof Blob) {
                tamano = valor.size;
                sourceVersion = 'legacy_blob';
                flagReason = detectarSospechaInicial(clave);
              } else if (valor && typeof valor === 'object') {
                const b = valor.blob;
                tamano = valor.tamano || (b instanceof Blob ? b.size : 0);
                duracion = valor.duracion || 0;
                caratula = valor.caratula;
                artista = valor.artista;
                favorito = !!valor.favorito;
                exportada = !!valor.exportada;
                fecha = valor.fecha || Date.now();
                origen = valor.origen || 'descarga';
                verified = valor.verified === true;
                sourceVersion = valor.sourceVersion || origen;
                durationExpected = typeof valor.durationExpected === 'number' ? valor.durationExpected : undefined;
                durationActual = typeof valor.durationActual === 'number' ? valor.durationActual : duracion;
                flagReason = valor.flagReason || (!verified ? detectarSospechaInicial(clave, artista) : undefined);
                const durationMatchVal = typeof valor.durationMatch === 'boolean' ? valor.durationMatch : undefined;

                mapa.set(clave, {
                  nombre: clave,
                  tamano,
                  duracion,
                  caratula,
                  artista,
                  favorito,
                  exportada,
                  fecha,
                  descargada: true,
                  origen,
                  verified,
                  sourceVersion,
                  durationExpected,
                  durationActual,
                  durationMatch: durationMatchVal,
                  flagReason
                });
                return;
              }

              mapa.set(clave, {
                nombre: clave,
                tamano,
                duracion,
                caratula,
                artista,
                favorito,
                exportada,
                fecha,
                descargada: true,
                origen,
                verified,
                sourceVersion,
                durationExpected,
                durationActual,
                flagReason
              });
            } catch (_) {}
          })
        );
        // Ceder el hilo principal a Android WebView
        await new Promise((r) => setTimeout(r, 50));
      }

      const listaCompleta = Array.from(mapa.values());
      listaCompleta.sort((a, b) => a.nombre.localeCompare(b.nombre));
      guardarCatalogoLigero(listaCompleta);
      setBiblioteca(listaCompleta);
      setTimeout(() => {
        validarBibliotecaConMusicBrainzEnSegundoPlano(listaCompleta);
      }, 3000);
    } catch (e) {
      console.warn('[MigracionSegundoPlano]: Error:', e);
    }
  };

  const validacionMbEnCursoRef = useRef<boolean>(false);
  const reintentoMbTimerRef = useRef<number | null>(null);

  // Validación silenciosa en segundo plano contra MusicBrainz vía servidor-musica (lotes de 2)
  const validarBibliotecaConMusicBrainzEnSegundoPlano = async (listaInicial?: Cancion[]) => {
    if (validacionMbEnCursoRef.current) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    const base = listaInicial || bibliotecaRef.current;
    const pendientes = base.filter(
      (c) =>
        !c.verified &&
        typeof c.durationMatch !== 'boolean' &&
        c.flagReason !== 'sin datos' &&
        (c.durationActual ?? c.duracion) > 0
    );

    if (pendientes.length === 0) return;

    validacionMbEnCursoRef.current = true;
    let fallosRedConsecutivos = 0;

    try {
      const BATCH = 2;
      for (let i = 0; i < pendientes.length; i += BATCH) {
        const lote = pendientes.slice(i, i + BATCH);

        for (const item of lote) {
          const durReal = item.durationActual ?? item.duracion ?? 0;
          const res = await validarCancionConMusicBrainz(item.nombre, item.artista, durReal);

          if (res.status === 'retry_later') {
            fallosRedConsecutivos++;
            if (fallosRedConsecutivos >= 3) {
              // Servidor dormido o sin internet: pausar silenciosamente y reintentar después
              if (reintentoMbTimerRef.current !== null) {
                window.clearTimeout(reintentoMbTimerRef.current);
              }
              reintentoMbTimerRef.current = window.setTimeout(() => {
                reintentoMbTimerRef.current = null;
                validarBibliotecaConMusicBrainzEnSegundoPlano();
              }, 45000);
              return;
            }
            continue;
          }

          fallosRedConsecutivos = 0;

          const nuevoFlag =
            res.status === 'matched'
              ? item.flagReason === 'duración no coincide' || item.flagReason === 'sin datos'
                ? undefined
                : item.flagReason
              : res.flagReason;

          try {
            const regDb: any = await localforage.getItem(item.nombre);
            if (regDb && typeof regDb === 'object') {
              await localforage.setItem(item.nombre, {
                ...regDb,
                durationExpected:
                  typeof res.durationExpected === 'number'
                    ? res.durationExpected
                    : regDb.durationExpected,
                durationMatch:
                  typeof res.durationMatch === 'boolean' ? res.durationMatch : regDb.durationMatch,
                flagReason: nuevoFlag
                // Nunca marcar verified=true automáticamente: se reserva para confirmación manual
              });
            }
          } catch (_) {}

          setBiblioteca((prev) => {
            const nueva = prev.map((c) =>
              c.nombre === item.nombre
                ? {
                    ...c,
                    durationExpected:
                      typeof res.durationExpected === 'number'
                        ? res.durationExpected
                        : c.durationExpected,
                    durationMatch:
                      typeof res.durationMatch === 'boolean' ? res.durationMatch : c.durationMatch,
                    flagReason: nuevoFlag
                  }
                : c
            );
            guardarCatalogoLigero(nueva);
            return nueva;
          });

          if (!res.fromCache) {
            await new Promise((r) => setTimeout(r, 1150));
          }
        }

        // Ceder el hilo principal entre lotes
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      validacionMbEnCursoRef.current = false;
    }
  };

  // Cargar canciones y playlists usando ÚNICAMENTE metadatos ligeros (PROHIBIDO leer Blobs al arrancar)
  const cargarDatos = async () => {
    try {
      // 1. Lectura inmediata desde localStorage (< 5ms)
      const guardado = leerCatalogoLigero();
      if (guardado && guardado.length > 0) {
        guardado.sort((a, b) => a.nombre.localeCompare(b.nombre));
        setBiblioteca(guardado);
        await cargarPlaylists();
        // Ejecutar migración segura en segundo plano si aún no se ha corrido en esta versión
        migrarBibliotecaIndexedDB().then((res) => {
          if (!res.skipped && res.updatedMetadata && res.updatedMetadata.length > 0) {
            const listaMigrada: Cancion[] = res.updatedMetadata.map((m: any) => ({
              ...m,
              tituloLower: normalizarParaBusqueda(m.nombre),
              artistaLower: normalizarParaBusqueda(m.artista)
            }));
            listaMigrada.sort((a, b) => a.nombre.localeCompare(b.nombre));
            setBiblioteca(listaMigrada);
            guardarCatalogoLigero(listaMigrada);
            if (res.migrated > 0) {
              mostrarToast(`✓ Respaldo verificado y ${res.migrated} canciones actualizadas`, 'exito');
            }
            setTimeout(() => {
              validarBibliotecaConMusicBrainzEnSegundoPlano(listaMigrada);
            }, 3000);
          } else {
            setTimeout(() => {
              validarBibliotecaConMusicBrainzEnSegundoPlano(guardado);
            }, 3000);
          }
        }).catch(() => {});
        return;
      }

      // 2. Si no existe índice ligero (primera vez o tras limpiar caché),
      // leer ÚNICAMENTE las claves con localforage.keys() (NUNCA Blobs)
      await localforage.ready();
      const todasLasClaves = await localforage.keys();
      const clavesValidas = todasLasClaves.filter((clave) => {
        return !(
          clave.startsWith('app_') ||
          clave.startsWith('lyrics_') ||
          clave.startsWith('probe_') ||
          clave.startsWith('cache_') ||
          clave.startsWith('temp_') ||
          clave.startsWith('stream_') ||
          clave === CLAVE_CATALOGO_LIGERO
        );
      });

      if (clavesValidas.length === 0) {
        // Si no hay canciones en IndexedDB (ej. tras reinstalar la app o limpiar datos):
        // Auto-recuperación desde el almacenamiento permanente del teléfono (/Music/AppMusica/)
        if (esAlmacenamientoNativoDisponible()) {
          try {
            const cancionesFisicas = obtenerCancionesEnMemoriaFisica();
            if (cancionesFisicas.length > 0) {
              console.log(`[Storage]: ¡Auto-recuperación exitosa! ${cancionesFisicas.length} canciones físicas encontradas en el celular.`);
              const recuperadas: Cancion[] = cancionesFisicas.map((cf) => ({
                nombre: cf.nombre,
                tamano: cf.tamano,
                duracion: cf.duracion,
                favorito: false,
                fecha: cf.fechaModificado || Date.now(),
                artista: cf.artista,
                exportada: true,
                descargada: true,
                origen: 'dispositivo_permanente'
              }));
              recuperadas.sort((a, b) => a.nombre.localeCompare(b.nombre));
              setBiblioteca(recuperadas);
              guardarCatalogoLigero(recuperadas);
              mostrarToast(`✓ ¡Se recuperaron ${recuperadas.length} canciones de tu teléfono!`, 'exito');

              const respaldoFisico = leerRespaldoDeMemoriaFisica();
              if (respaldoFisico && Array.isArray(respaldoFisico.playlists) && respaldoFisico.playlists.length > 0) {
                setPlaylists(respaldoFisico.playlists);
                guardarPlaylistsEnDB(respaldoFisico.playlists).catch(() => {});
              } else {
                await cargarPlaylists();
              }
              return;
            }
          } catch (eScan) {
            console.warn('[Storage]: Error en auto-escaneo físico:', eScan);
          }
        }

        setBiblioteca([]);
        guardarCatalogoLigero([]);
        await cargarPlaylists();
        return;
      }

      // Construir catálogo inicial instantáneo solo con los nombres para desbloquear la UI de inmediato
      const catalogoInicial: Cancion[] = clavesValidas.map((k) => ({
        nombre: k,
        tamano: 0,
        duracion: 0,
        favorito: false,
        fecha: Date.now(),
        descargada: true,
        origen: 'descarga'
      }));
      catalogoInicial.sort((a, b) => a.nombre.localeCompare(b.nombre));
      setBiblioteca(catalogoInicial);
      guardarCatalogoLigero(catalogoInicial);
      await cargarPlaylists();

      // 3. Hidratación diferida en segundo plano en lotes de 3 en 3 con pausas de 50ms
      setTimeout(() => {
        migrarMetadatosEnSegundoPlano(clavesValidas);
      }, 150);
    } catch (errStorage) {
      console.error('[CargarDatos]: Error accediendo al almacenamiento:', errStorage);
    }
  };

  const guardarPlaylistsEnDB = async (nuevasPlaylists: Playlist[]) => {
    setPlaylists(nuevasPlaylists);
    await localforage.setItem('app_playlists', nuevasPlaylists);
  };

  const alternarCancionEnSeleccionPlaylist = (nombre: string) => {
    setCancionesSeleccionadasPlaylist((prev) =>
      prev.includes(nombre) ? prev.filter((n) => n !== nombre) : [...prev, nombre]
    );
  };

  const seleccionarTodasLasCancionesParaPlaylist = () => {
    if (cancionesSeleccionadasPlaylist.length === biblioteca.length) {
      setCancionesSeleccionadasPlaylist([]);
    } else {
      setCancionesSeleccionadasPlaylist(biblioteca.map((c) => c.nombre));
    }
  };

  const crearPlaylist = async () => {
    const nombre = nombreNuevaPlaylist.trim();
    if (!nombre) return;

    const listaCancionesFinal = cancionParaPlaylist
      ? [cancionParaPlaylist.nombre]
      : cancionesSeleccionadasPlaylist;

    const nueva: Playlist = {
      id: Date.now().toString(),
      nombre,
      canciones: listaCancionesFinal,
      fechaCreacion: Date.now()
    };

    const actualizadas = [...playlists, nueva];
    await guardarPlaylistsEnDB(actualizadas);
    setNombreNuevaPlaylist('');
    setCancionParaPlaylist(null);
    setCancionesSeleccionadasPlaylist([]);
    setFiltroCancionModalPlaylist('');
    setModalPlaylistAbierto(false);
    mostrarToast(`Playlist "${nombre}" creada con ${listaCancionesFinal.length} canción(es) 📁`);
  };

  const agregarCancionAPlaylist = async (playlistId: string, nombreCancion: string) => {
    const pl = playlists.find((p) => p.id === playlistId);
    if (!pl) return;

    if (pl.canciones.includes(nombreCancion)) {
      mostrarToast(`"${nombreCancion}" ya está en esta lista`, 'info');
      setModalPlaylistAbierto(false);
      return;
    }

    const actualizadas = playlists.map((p) => {
      if (p.id === playlistId) {
        return { ...p, canciones: [...p.canciones, nombreCancion] };
      }
      return p;
    });

    await guardarPlaylistsEnDB(actualizadas);
    if (playlistSeleccionada && playlistSeleccionada.id === playlistId) {
      setPlaylistSeleccionada(actualizadas.find((p) => p.id === playlistId) || null);
    }
    setCancionParaPlaylist(null);
    setModalPlaylistAbierto(false);
    mostrarToast(`Agregada a "${pl.nombre}"`);
  };

  const abrirModalAgregarAPlaylist = (pl: Playlist, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setPlaylistDestinoAgregar(pl);
    setCancionesSeleccionadasParaAgregar([]);
    setFiltroCancionesParaAgregar('');
    setModalAgregarAPlaylistAbierto(true);
  };

  const agregarVariasCancionesAPlaylist = async (playlistId: string, nombresCanciones: string[]) => {
    const pl = playlists.find((p) => p.id === playlistId);
    if (!pl) return;

    const nuevas = nombresCanciones.filter((n) => !pl.canciones.includes(n));
    if (nuevas.length === 0) {
      mostrarToast('Las canciones seleccionadas ya están en esta playlist', 'info');
      setModalAgregarAPlaylistAbierto(false);
      return;
    }

    const actualizadas = playlists.map((p) => {
      if (p.id === playlistId) {
        return { ...p, canciones: [...p.canciones, ...nuevas] };
      }
      return p;
    });

    await guardarPlaylistsEnDB(actualizadas);
    if (playlistSeleccionada && playlistSeleccionada.id === playlistId) {
      setPlaylistSeleccionada(actualizadas.find((p) => p.id === playlistId) || null);
    }
    setModalAgregarAPlaylistAbierto(false);
    setPlaylistDestinoAgregar(null);
    setCancionesSeleccionadasParaAgregar([]);
    setFiltroCancionesParaAgregar('');
    mostrarToast(`¡${nuevas.length} canción(es) añadidas a "${pl.nombre}"! 📁`, 'exito');
  };

  const quitarCancionDePlaylist = (playlistId: string, nombreCancion: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    pedirConfirmacion({
      titulo: '¿Quitar de la lista?',
      mensaje: `¿Deseas quitar "${nombreCancion}" de esta playlist?`,
      textoConfirmar: 'Quitar',
      peligroso: true,
      onConfirmar: async () => {
        const actualizadas = playlists.map((p) => {
          if (p.id === playlistId) {
            return { ...p, canciones: p.canciones.filter((c) => c !== nombreCancion) };
          }
          return p;
        });

        await guardarPlaylistsEnDB(actualizadas);
        if (playlistSeleccionada && playlistSeleccionada.id === playlistId) {
          setPlaylistSeleccionada(actualizadas.find((p) => p.id === playlistId) || null);
        }
        mostrarToast(`Pista removida de la playlist`);
      }
    });
  };

  const eliminarPlaylist = (playlistId: string, nombreLista: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    pedirConfirmacion({
      titulo: '¿Eliminar playlist?',
      mensaje: `¿Deseas eliminar la lista "${nombreLista}"? Las canciones seguirán en tu biblioteca.`,
      textoConfirmar: 'Eliminar',
      peligroso: true,
      onConfirmar: async () => {
        const actualizadas = playlists.filter((p) => p.id !== playlistId);
        await guardarPlaylistsEnDB(actualizadas);
        if (playlistSeleccionada?.id === playlistId) {
          setPlaylistSeleccionada(null);
        }
        mostrarToast(`Playlist eliminada`);
      }
    });
  };

  // Lista activa según contexto
  const listaContexto = useMemo(() => {
    if (playlistSeleccionada) {
      return biblioteca.filter((c) => playlistSeleccionada.canciones.includes(c.nombre));
    }
    if (filtroBiblioteca === 'favoritas') {
      return biblioteca.filter((c) => c.favorito);
    }
    return biblioteca;
  }, [biblioteca, playlistSeleccionada, filtroBiblioteca]);

  // Mezclas Automáticas en Inicio ("En Bucle" y "Tu Mix Diario") generadas dinámicamente de useHistorialEscucha y biblioteca local
  const cancionesEnBucle = useMemo<Cancion[]>(() => {
    if (biblioteca.length === 0) return [];
    const mapaBib = new Map<string, Cancion>();
    for (const c of biblioteca) {
      mapaBib.set(c.nombre.toLowerCase().trim(), c);
    }

    const resultado: Cancion[] = [];
    const agregadas = new Set<string>();

    // 1. Priorizar canciones de useHistorialEscucha presentes en la biblioteca
    for (const h of historialEscucha) {
      const clave = (h.nombre || '').toLowerCase().trim();
      const encontrada = mapaBib.get(clave);
      if (encontrada && !agregadas.has(encontrada.nombre)) {
        resultado.push(encontrada);
        agregadas.add(encontrada.nombre);
        if (resultado.length >= 10) return resultado;
      }
    }

    // 2. Completar con canciones favoritas
    for (const c of biblioteca) {
      if (c.favorito && !agregadas.has(c.nombre)) {
        resultado.push(c);
        agregadas.add(c.nombre);
        if (resultado.length >= 10) return resultado;
      }
    }

    // 3. Completar con las más recientes de la biblioteca hasta llegar a 10
    const ordenadasRecientes = [...biblioteca].sort((a, b) => (b.fecha || 0) - (a.fecha || 0));
    for (const c of ordenadasRecientes) {
      if (!agregadas.has(c.nombre)) {
        resultado.push(c);
        agregadas.add(c.nombre);
        if (resultado.length >= 10) return resultado;
      }
    }

    return resultado;
  }, [biblioteca, historialEscucha]);

  const tuMixDiario = useMemo<{ canciones: Cancion[]; artistasTop: string[] }>(() => {
    if (biblioteca.length === 0) return { canciones: [], artistasTop: [] };

    // Extraer artistas más frecuentes de useHistorialEscucha y favoritas
    const conteoArtistas = new Map<string, { nombreOriginal: string; puntos: number }>();
    const registrarArtista = (artRaw?: string, nombreRaw?: string, peso: number = 1) => {
      const parsed = parsearTituloYArtista(nombreRaw || '', artRaw);
      const art = (parsed.artistaLimpio || artRaw || '').trim();
      if (!art || art.length < 2) return;
      const k = art.toLowerCase();
      const actual = conteoArtistas.get(k);
      if (actual) {
        actual.puntos += peso;
      } else {
        conteoArtistas.set(k, { nombreOriginal: art, puntos: peso });
      }
    };

    for (const h of historialEscucha) {
      registrarArtista(h.artista, h.nombre, 3);
    }
    for (const c of biblioteca) {
      registrarArtista(c.artista, c.nombre, c.favorito ? 2 : 1);
    }

    const artistasOrdenados = Array.from(conteoArtistas.values())
      .sort((a, b) => b.puntos - a.puntos)
      .slice(0, 4)
      .map((a) => a.nombreOriginal);

    const mix: Cancion[] = [];
    const usados = new Set<string>();

    // Mezclar temas más escuchados ("En Bucle")
    for (const c of cancionesEnBucle.slice(0, 6)) {
      if (!usados.has(c.nombre)) {
        mix.push(c);
        usados.add(c.nombre);
      }
    }

    // Intercalar temas de tus artistas favoritos en la biblioteca
    const artistasKeys = artistasOrdenados.map((a) => a.toLowerCase());
    for (const c of biblioteca) {
      if (usados.has(c.nombre)) continue;
      const texto = `${c.artista || ''} ${c.nombre}`.toLowerCase();
      if (artistasKeys.some((ak) => texto.includes(ak))) {
        mix.push(c);
        usados.add(c.nombre);
        if (mix.length >= 18) break;
      }
    }

    // Completar hasta 18 temas con el resto de la biblioteca
    for (const c of biblioteca) {
      if (mix.length >= 18) break;
      if (!usados.has(c.nombre)) {
        mix.push(c);
        usados.add(c.nombre);
      }
    }

    return {
      canciones: mix,
      artistasTop: artistasOrdenados
    };
  }, [biblioteca, historialEscucha, cancionesEnBucle]);

  const reproducirTuMixDiario = () => {
    if (tuMixDiario.canciones.length === 0) {
      mostrarToast('Descarga canciones en Buscar para activar Tu Mix Diario', 'info');
      setTabActiva('buscar');
      return;
    }
    const plVirtual: Playlist = {
      id: 'virtual-daily-mix',
      nombre: 'Tu Mix Diario ⚡',
      canciones: tuMixDiario.canciones.map((c) => c.nombre),
      fechaCreacion: Date.now()
    };
    setPlaylistSeleccionada(plVirtual);
    setColaReproduccion(tuMixDiario.canciones.slice(1));
    colaReproduccionRef.current = tuMixDiario.canciones.slice(1);
    reproducirCancion(tuMixDiario.canciones[0]);
    mostrarToast(`🎧 Reproduciendo Tu Mix Diario (${tuMixDiario.canciones.length} canciones)`, 'exito');
  };

  const reproducirEnBucle = (cancionInicial?: Cancion) => {
    if (cancionesEnBucle.length === 0) {
      mostrarToast('Escucha o descarga música para generar tu lista En Bucle', 'info');
      setTabActiva('buscar');
      return;
    }
    const plVirtual: Playlist = {
      id: 'virtual-on-repeat',
      nombre: 'En Bucle 🔁',
      canciones: cancionesEnBucle.map((c) => c.nombre),
      fechaCreacion: Date.now()
    };
    setPlaylistSeleccionada(plVirtual);
    const inicio = cancionInicial || cancionesEnBucle[0];
    const resto = cancionesEnBucle.filter((c) => c.nombre !== inicio.nombre);
    setColaReproduccion(resto);
    colaReproduccionRef.current = resto;
    reproducirCancion(inicio);
    mostrarToast(`🔁 Reproduciendo En Bucle (${cancionesEnBucle.length} favoritas)`, 'exito');
  };

  const cancionesVisibles = useMemo(() => {
    const q = normalizarParaBusqueda(busquedaLocalDebounced);
    const filtradas = q
      ? listaContexto.filter((c) => {
          const nom = c.tituloLower ?? normalizarParaBusqueda(c.nombre);
          const art = c.artistaLower ?? normalizarParaBusqueda(c.artista);
          return nom.includes(q) || art.includes(q);
        })
      : listaContexto;

    if (criterioOrden === 'az') {
      return [...filtradas].sort((a, b) => a.nombre.localeCompare(b.nombre, undefined, { sensitivity: 'base' }));
    }
    if (criterioOrden === 'za') {
      return [...filtradas].sort((a, b) => b.nombre.localeCompare(a.nombre, undefined, { sensitivity: 'base' }));
    }
    // 'recientes': por fecha de agregado más reciente primero
    return [...filtradas].sort((a, b) => (b.fecha || 0) - (a.fecha || 0));
  }, [listaContexto, busquedaLocalDebounced, criterioOrden]);

  const listaParaReproduccion = useMemo(() => {
    if (cancionActual && cancionesVisibles.some((c) => c.nombre === cancionActual.nombre)) {
      return cancionesVisibles;
    }
    return listaContexto;
  }, [cancionesVisibles, listaContexto, cancionActual]);

  const almacenamientoTotal = useMemo(() => {
    let tot = 0;
    for (let i = 0; i < biblioteca.length; i++) {
      tot += biblioteca[i].tamano || 0;
    }
    return tot;
  }, [biblioteca]);

  // Canciones descargadas explícitamente a través de la app que aún no han sido exportadas a la memoria del dispositivo
  const cancionesPendientesExportar = useMemo(() => {
    return biblioteca.filter((c) => {
      if (c.exportada) return false;
      if (c.origen === 'local_importada' || c.origen === 'cache') return false;
      return c.descargada !== false && (c.tamano || 0) >= 50000;
    });
  }, [biblioteca]);

  // Validador de Carátula (artwork) para Android System UI:
  // Usa la carátula real HTTPS de la canción, o la imagen del artista en /artistas/... si no tiene portada propia,
  // para que Android System UI extraiga la paleta de colores y tiña la tarjeta flotante de notificaciones.
  const obtenerUrlCaratulaValida = useCallback((caratulaRaw?: string, nombreCancion?: string, artista?: string): string => {
    const origenBase = typeof window !== 'undefined' ? window.location.origin : 'https://servidor-musica-i7m3.onrender.com';
    const iconoLocal = `${origenBase}/icon-512.png`;

    const resolverArtistaLocal = (): string | null => {
      const texto = `${artista || ''} ${nombreCancion || ''}`
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');
      const mapaArtistas: [RegExp, string][] = [
        [/peso\s*pluma/, 'peso-pluma.jpg'],
        [/natanael\s*cano/, 'natanael-cano.jpg'],
        [/bad\s*bunny/, 'bad-bunny.jpg'],
        [/luis\s*miguel/, 'luis-miguel.jpg'],
        [/christian\s*nodal/, 'christian-nodal.jpg'],
        [/carin\s*leon/, 'carin-leon.jpg'],
        [/julion\s*alvarez/, 'julion-alvarez.jpg'],
        [/grupo\s*frontera/, 'grupo-frontera.jpg'],
        [/banda\s*ms/, 'banda-ms.jpg'],
        [/\bqueen\b/, 'queen.jpg']
      ];
      for (const [rx, archivo] of mapaArtistas) {
        if (rx.test(texto)) {
          return `${origenBase}/artistas/${archivo}`;
        }
      }
      return null;
    };

    if (caratulaRaw && typeof caratulaRaw === 'string') {
      const raw = caratulaRaw.trim();
      if (raw && !raw.startsWith('data:') && !raw.startsWith('blob:') && raw.length <= 2048) {
        const matchVi = raw.match(/\/vi\/([a-zA-Z0-9_-]{11})\//);
        if (matchVi && matchVi[1]) {
          return `https://i.ytimg.com/vi/${matchVi[1]}/hqdefault.jpg`;
        }
        if (raw.startsWith('/')) {
          return `${origenBase}${raw}`;
        }
        if (/^https:\/\//i.test(raw) && !/(?:nadeko\.net|yewtu\.be|invidious|jing\.rocks)/i.test(raw)) {
          return raw;
        }
      }
    }

    return resolverArtistaLocal() || iconoLocal;
  }, []);

  // Media Session API Completa para Mini Reproductor Multimedia de Android (Notificaciones, Pantalla de Bloqueo y Bluetooth)
  const actualizarMediaSessionCompleta = useCallback(() => {
    const pista = cancionActualRef.current || cancionActual;
    if (!pista) return;

    const urlCaratula = obtenerUrlCaratulaValida(pista.caratula, pista.nombre, pista.artista);
    const parsed = parsearTituloYArtista(pista.nombre, pista.artista);
    const tituloFinal = limpiarTextoMetadata(parsed.tituloLimpio || pista.nombre);
    const artistaFinal = limpiarTextoMetadata(parsed.artistaLimpio || pista.artista || 'Música');
    const plActual = playlistSeleccionadaRef.current || playlistSeleccionada;

    const el = getActiveDeckEl();
    const estaReproduciendoReal = el ? (!el.paused && !el.ended) : reproduciendoRef.current;
    const durReal = (el && isFinite(el.duration) && el.duration > 0)
      ? el.duration
      : (duracionTotalRef.current > 0 ? duracionTotalRef.current : (pista.duracion || 0));
    const posReal = (el && isFinite(el.currentTime) && el.currentTime >= 0) ? el.currentTime : 0;

    // 1. Actualizar servicio nativo de notificación Android (si el puente está disponible)
    actualizarNotificacionNativa(
      tituloFinal,
      artistaFinal,
      durReal,
      posReal,
      estaReproduciendoReal,
      urlCaratula
    );

    // 2. Registro completo de navigator.mediaSession para Android System UI / Chrome / WebView
    if (!('mediaSession' in navigator)) return;

    try {
      const tipoImagen = urlCaratula.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
      const tamanosArtwork = ['96x96', '128x128', '256x256', '512x512'];

      navigator.mediaSession.metadata = new MediaMetadata({
        title: tituloFinal,
        artist: artistaFinal,
        album: plActual ? plActual.nombre : 'App Música',
        artwork: tamanosArtwork.map((sizes) => ({
          src: urlCaratula,
          sizes,
          type: tipoImagen
        }))
      });

      if (estaReproduciendoReal) {
        navigator.mediaSession.playbackState = 'playing';
      } else if (pausadoPorUsuarioRef.current) {
        navigator.mediaSession.playbackState = 'paused';
      }

      // Controles registrados usando siempre referencias frescas (useRef) para evitar closures desactualizados
      navigator.mediaSession.setActionHandler('play', () => {
        pausadoPorUsuarioRef.current = false;
        alternarReproduccionRef.current(true);
      });

      navigator.mediaSession.setActionHandler('pause', () => {
        pausadoPorUsuarioRef.current = true;
        alternarReproduccionRef.current(false);
      });

      navigator.mediaSession.setActionHandler('previoustrack', () => {
        const ahora = Date.now();
        if (ahora - ultimoSkipRemotoTimestampRef.current < 450) return;
        ultimoSkipRemotoTimestampRef.current = ahora;
        reproducirAnteriorRef.current();
      });

      navigator.mediaSession.setActionHandler('nexttrack', () => {
        const ahora = Date.now();
        if (ahora - ultimoSkipRemotoTimestampRef.current < 450) return;
        ultimoSkipRemotoTimestampRef.current = ahora;
        reproducirSiguienteRef.current(true);
      });

      navigator.mediaSession.setActionHandler('seekbackward', (det) => {
        saltarTiempoRef.current(-(det.seekOffset || 10));
      });

      navigator.mediaSession.setActionHandler('seekforward', (det) => {
        saltarTiempoRef.current(det.seekOffset || 10);
      });

      try {
        navigator.mediaSession.setActionHandler('seekto', (det) => {
          if (det.seekTime !== undefined && !isNaN(det.seekTime)) {
            saltarATiempoRef.current(det.seekTime);
          }
        });
      } catch (_) {}

      try {
        navigator.mediaSession.setActionHandler('stop', () => {
          alternarReproduccionRef.current(false);
        });
      } catch (_) {}

      if (durReal > 0 && posReal <= durReal) {
        sincronizarMediaSessionPosition(durReal, posReal, 1, true);
      }
    } catch (e) {
      console.warn('[MediaSession]: Error actualizando metadatos:', e);
    }
  }, [cancionActual, playlistSeleccionada, reproduciendo, obtenerUrlCaratulaValida]);

  actualizarMediaSessionRef.current = actualizarMediaSessionCompleta;

  useEffect(() => {
    // Receptor de acciones remotas desde la notificación nativa y AudioFocus de Android (siempre registrado)
    window.despacharAccionRemota = (accion: string, valor: number) => {
      console.log(`[RemoteMedia]: Acción recibida desde notificación/AudioFocus: "${accion}" (${valor})`);
      const ahora = Date.now();
      if (accion === 'play') {
        pausadoPorUsuarioRef.current = false;
        alternarReproduccionRef.current(true);
      } else if (accion === 'pause') {
        pausadoPorUsuarioRef.current = true;
        alternarReproduccionRef.current(false);
      } else if (accion === 'duck') {
        const el = getActiveDeckEl();
        if (el && !silenciado) {
          const factor = valor > 0 && valor <= 100 ? valor / 100 : 0.25;
          el.volume = Math.max(0.05, Math.min(1, volumen * factor));
        }
      } else if (accion === 'unduck') {
        const el = getActiveDeckEl();
        if (el) {
          el.volume = silenciado ? 0 : volumen;
        }
      } else if (accion === 'next') {
        if (ahora - ultimoSkipRemotoTimestampRef.current < 450) return;
        ultimoSkipRemotoTimestampRef.current = ahora;
        reproducirSiguienteRef.current(true);
      } else if (accion === 'previous') {
        if (ahora - ultimoSkipRemotoTimestampRef.current < 450) return;
        ultimoSkipRemotoTimestampRef.current = ahora;
        reproducirAnteriorRef.current();
      } else if (accion === 'seek') {
        if (!isNaN(valor) && valor >= 0) {
          saltarATiempoRef.current(valor / 1000);
        }
      }
    };

    if (cancionActual) {
      actualizarMediaSessionCompleta();
    } else {
      detenerNotificacionNativa();
      if ('mediaSession' in navigator) {
        try {
          navigator.mediaSession.playbackState = 'none';
        } catch (_) {}
      }
    }
  }, [cancionActual, reproduciendo, actualizarMediaSessionCompleta]);

  // Temporizador de Apagado (Sleep Timer) con Fade Out suave
  useEffect(() => {
    if (!timerFinTimestamp) {
      setTimerTextoRestante('');
      return;
    }

    const interval = setInterval(() => {
      const ahora = Date.now();
      const difSegs = Math.max(0, Math.floor((timerFinTimestamp - ahora) / 1000));

      if (difSegs <= 0) {
        clearInterval(interval);
        desvanecerYApagar();
      } else {
        const mins = Math.floor(difSegs / 60);
        const segs = difSegs % 60;
        setTimerTextoRestante(`${mins}:${segs < 10 ? '0' : ''}${segs}`);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [timerFinTimestamp]);

  const activarSleepTimer = (minutos: number | null) => {
    if (minutos === null) {
      setTimerOpcion(null);
      setTimerFinTimestamp(null);
      setTimerTextoRestante('');
      mostrarToast('Temporizador desactivado', 'info');
    } else if (minutos === -1) {
      setTimerOpcion(-1);
      setTimerFinTimestamp(null);
      setTimerTextoRestante('Al terminar pista');
      mostrarToast('Se apagará al terminar la canción actual');
    } else {
      setTimerOpcion(minutos);
      setTimerFinTimestamp(Date.now() + minutos * 60 * 1000);
      mostrarToast(`Temporizador fijado en ${minutos} minutos`);
    }
    setModalTimerAbierto(false);
  };

  const cambiarCrossfade = (segs: number) => {
    setCrossfadeSegundos(segs);
    crossfadeSegundosRef.current = segs;
    try {
      localStorage.setItem('app_musica_crossfade_v31', segs.toString());
    } catch (_) {}
    mostrarToast(
      segs === 0
        ? 'Mixeo continuo (Crossfade) desactivado'
        : `🔀 Spotify Automix fijado en ${segs}s (Curva Equal-Power)`,
      'exito'
    );
  };

  const alternarMixManual = (forzar?: boolean) => {
    const nuevo = forzar !== undefined ? forzar : !mixManualActivo;
    setMixManualActivo(nuevo);
    mixManualActivoRef.current = nuevo;
    try {
      localStorage.setItem('app_musica_mix_manual_v31', nuevo ? 'true' : 'false');
    } catch (_) {}
    mostrarToast(
      nuevo
        ? '🎧 DJ Mix en cambios manuales: Activado (fundido suave al saltar canción)'
        : 'DJ Mix en cambios manuales: Desactivado (solo al terminar canción)',
      'info'
    );
  };

  const alternarBassBoost = (nuevoActivo?: boolean) => {
    const val = nuevoActivo !== undefined ? nuevoActivo : !bassBoostActivo;
    setBassBoostActivo(val);
    bassBoostManager.setActivo(val, [deckARef.current, deckBRef.current]);
    mostrarToast(
      val
        ? '🔊 Bass Boost Auto Activado (Graves adaptativos sin distorsión)'
        : 'Bass Boost Desactivado (Audio 100% Nativo y Puro)',
      'info'
    );
  };

  const cancelarCrossfade = () => {
    if (crossfadeIntervalRef.current) {
      clearInterval(crossfadeIntervalRef.current);
      crossfadeIntervalRef.current = null;
    }
    const deckInactivoId: 'A' | 'B' = deckActivoRef.current === 'A' ? 'B' : 'A';
    const activo = getActiveDeckEl();
    const inactivo = getInactiveDeckEl();
    smartAutomixEngine.cancelarMixActivo(
      bassBoostManager.getContext(),
      activo,
      inactivo,
      silenciado ? 0 : volumen
    );
    crossfadingRef.current = false;
    crossfadeOrigenDeckRef.current = null;
    setEnTransicionMix(false);
    setProgresoMix(0);
    setCancionSalienteMix('');
    if (activo) {
      activo.volume = silenciado ? 0 : volumen;
      bassBoostManager.resetearDetectorSilencio(activo);
    }
    if (inactivo) {
      ignorandoPausaSalienteRef.current = true;
      setTimeout(() => {
        ignorandoPausaSalienteRef.current = false;
      }, 500);
      liberarHardwareDeck(inactivo);
    }
    // Revocar cualquier ObjectURL huérfano del Deck inactivo tras 5000ms verificando que no sea igual al activo
    const urlHuerfana = deckInactivoId === 'A' ? urlDeckARef.current : urlDeckBRef.current;
    const urlActiva = deckActivoRef.current === 'A' ? urlDeckARef.current : urlDeckBRef.current;
    if (urlHuerfana) {
      if (deckInactivoId === 'A') urlDeckARef.current = null;
      else urlDeckBRef.current = null;
      if (urlHuerfana !== urlActiva) {
        revocarUrlObjetoSegura(urlHuerfana, 5000);
      }
    }
  };

  const desvanecerYApagar = () => {
    pausadoPorUsuarioRef.current = true;
    cancelarCrossfade();
    const activo = getActiveDeckEl();
    if (!activo) {
      reproduciendoRef.current = false;
      setReproduciendo(false);
      setTimerOpcion(null);
      setTimerFinTimestamp(null);
      setTimerTextoRestante('');
      return;
    }
    let vol = activo.volume;
    const fadeInterval = setInterval(() => {
      const el = getActiveDeckEl();
      if (!el || vol <= 0.05) {
        clearInterval(fadeInterval);
        pausadoPorUsuarioRef.current = true;
        reproduciendoRef.current = false;
        if (el) {
          el.pause();
          el.volume = silenciado ? 0 : volumen;
        }
        setReproduciendo(false);
        setTimerOpcion(null);
        setTimerFinTimestamp(null);
        setTimerTextoRestante('');
        soltarWakeLock();
        mostrarToast('🎵 Temporizador: Música apagada suavemente', 'info');
      } else {
        vol -= 0.1;
        el.volume = Math.max(0, vol);
      }
    }, 200);
  };

  const obtenerSiguienteCancion = (): Cancion | null => {
    // 1. Prioridad: cola manual de reproducción elegida por el usuario (leída desde Ref fresca)
    const colaActual = colaReproduccionRef.current;
    if (colaActual.length > 0) {
      return colaActual[0];
    }

    // 2. Lista base: lista de reproducción activa, contexto o biblioteca general desde Refs frescas
    const listaRep = listaParaReproduccionRef.current;
    const listaCtx = listaContextoRef.current;
    const bib = bibliotecaRef.current;
    let lista = listaRep.length > 0 ? listaRep : listaCtx;
    if (lista.length === 0) {
      lista = bib;
    }
    if (lista.length === 0) return null;

    const actual = cancionActualRef.current;
    if (!actual) {
      return lista[0];
    }

    // 3. Modo Aleatorio (Shuffle) con sincronización estricta por Ref
    if (modoAleatorioRef.current && lista.length > 1) {
      const escuchadas = historialAleatorioRef.current;
      let noEscuchadas = lista.filter(
        (c) => !escuchadas.includes(c.nombre) && c.nombre !== actual.nombre
      );

      // Si ya se escucharon todas las canciones de la lista, reiniciar ciclo
      if (noEscuchadas.length === 0) {
        historialAleatorioRef.current = [actual.nombre];
        setHistorialAleatorio([actual.nombre]);
        noEscuchadas = lista.filter((c) => c.nombre !== actual.nombre);
      }

      if (noEscuchadas.length === 0) return lista[0];
      return noEscuchadas[Math.floor(Math.random() * noEscuchadas.length)];
    }

    // 4. Modo Repetición de una sola pista
    if (modoRepeticionRef.current === 'one') {
      return actual;
    }

    // 5. Reproducción secuencial continua
    const idx = lista.findIndex((c) => c.nombre === actual.nombre);
    if (idx === -1) {
      return lista[0];
    } else if (idx < lista.length - 1) {
      return lista[idx + 1];
    } else {
      // Fin de la lista alcanzado: Bucle continuo inteligente estilo Spotify
      return lista[0];
    }
  };

  // Pre-carga inteligente en memoria de la siguiente pista (tanto en primer plano como en segundo plano / sin crossfade)
  // Garantiza que al llegar a onEnded la URL de la siguiente canción ya esté lista en RAM (0ms de espera asíncrona en IndexedDB)
  const precargarSiguienteParaMix = async () => {
    if (precargandoMixRef.current || crossfadingRef.current || smartAutomixEngine.isMixing()) return;

    const colaActual = colaReproduccionRef.current;
    // Si ya tenemos una pista precargada válida y no ha cambiado la cola manual, conservarla (evita re-sortear en modo aleatorio)
    if (precargaMixRef.current && precargaMixRef.current.url) {
      if (colaActual.length > 0) {
        if (precargaMixRef.current.nombre === colaActual[0].nombre) return;
      } else if (precargaMixRef.current.nombre !== cancionActualRef.current?.nombre) {
        return;
      }
    }

    const sig = obtenerSiguienteCancion();
    if (!sig) return;
    if (precargaMixRef.current && precargaMixRef.current.nombre === sig.nombre && precargaMixRef.current.url) return;

    precargandoMixRef.current = true;
    try {
      let blob = sig.blob;
      if (!blob || blob.size < 1000) {
        blob = (await obtenerBlobCancionBajoDemanda(sig.nombre)) || undefined;
      }
      // Si la siguiente canción aún no está guardada localmente en IndexedDB (`localforage`),
      // precargarla silenciosamente en segundo plano para transición 0ms de red
      if (!blob || blob.size < 1000) {
        blob = (await prebufferPistaEnIndexedDB(sig)) || undefined;
      }
      if (blob && blob.size >= 1000) {
        const blobAdecuado = blob.type && blob.type.startsWith('audio/')
          ? blob
          : new Blob([blob], { type: 'audio/mpeg' });
        if (precargaMixRef.current && precargaMixRef.current.url) {
          revocarUrlObjetoSegura(precargaMixRef.current.url, 5000);
        }
        const url = URL.createObjectURL(blobAdecuado);
        const analisis = await smartAutomixEngine.analizarCuePointsYReplayGain(
          sig.nombre,
          blobAdecuado,
          sig.duracion || 0
        );
        // No retener referencia pesada de Blob en el objeto cancion para reducir RAM en Android WebView
        const cancionLigera: Cancion = { ...sig, blob: undefined };
        precargaMixRef.current = {
          nombre: sig.nombre,
          cancion: cancionLigera,
          url,
          cueIn: analisis.cueIn,
          cueOut: analisis.cueOut,
          replayGainDb: analisis.replayGainDb
        };
      }
    } catch (_) {
    } finally {
      precargandoMixRef.current = false;
    }
  };

  // Motor de Crossfade / Automix Profesional Estilo Spotify con SmartAutomixEngine (Curva 128-pt C++ + Bass-Swap 220Hz->20Hz)
  const iniciarCrossfadeSpotify = async (duracionFadeManualSegs?: number, cancionForzada?: Cancion): Promise<boolean> => {
    const esManual = duracionFadeManualSegs !== undefined || Boolean(cancionForzada);
    if (cambiandoPistaRef.current) return false;

    // Protección ante spam de cambios manuales rápidos: si ya había un mix en curso y el usuario pide otro cambio manual,
    // consolidar primero el Deck activo actual y limpiar el mix anterior antes de iniciar el nuevo.
    if (crossfadingRef.current || smartAutomixEngine.isMixing()) {
      if (!esManual) return false;
      cancelarCrossfade();
    }

    if (typeof document !== 'undefined' && document.hidden) {
      // Con pantalla bloqueada / background, mantener single-deck para no perder Hardware Offload ni WakeLock
      return false;
    }

    const deckSalienteId = deckActivoRef.current;
    const deckEntranteId: 'A' | 'B' = deckSalienteId === 'A' ? 'B' : 'A';
    const elSaliente = deckSalienteId === 'A' ? deckARef.current : deckBRef.current;
    const elEntrante = deckEntranteId === 'A' ? deckARef.current : deckBRef.current;

    if (!elSaliente || !elEntrante || elSaliente.paused) return false;

    const siguiente = cancionForzada || precargaMixRef.current?.cancion || obtenerSiguienteCancion();
    if (!siguiente) return false;

    // Si es exactamente la misma canción y no estamos forzando repetición, evitar auto-mix consigo misma
    if (cancionActualRef.current && cancionActualRef.current.nombre === siguiente.nombre && bibliotecaRef.current.length > 1 && !cancionForzada) {
      return false;
    }

    crossfadingRef.current = true;
    crossfadeOrigenDeckRef.current = deckSalienteId;
    const myToken = ++reproduccionTokenRef.current;

    // Si venía de la cola manual, retirarla
    const colaActual = colaReproduccionRef.current;
    if (colaActual.length > 0 && colaActual[0].nombre === siguiente.nombre) {
      const nuevaCola = colaActual.slice(1);
      colaReproduccionRef.current = nuevaCola;
      setColaReproduccion(nuevaCola);
    }

    // Obtener URL, Cue-In, Cue-Out y ReplayGain precargados o analizarlos bajo demanda
    let urlEntrante = '';
    let cueInEntrante = 0.22;
    let cueOutEntrante = siguiente.duracion && siguiente.duracion > 6 ? siguiente.duracion - 0.8 : 0;
    let replayGainEntranteDb = 0;

    if (precargaMixRef.current && precargaMixRef.current.nombre === siguiente.nombre && precargaMixRef.current.url) {
      urlEntrante = precargaMixRef.current.url;
      cueInEntrante = precargaMixRef.current.cueIn;
      cueOutEntrante = precargaMixRef.current.cueOut;
      replayGainEntranteDb = precargaMixRef.current.replayGainDb;
      precargaMixRef.current = null;
    } else {
      let blobFinal = siguiente.blob;
      if (!blobFinal || blobFinal.size < 1000) {
        blobFinal = (await obtenerBlobCancionBajoDemanda(siguiente.nombre)) || undefined;
      }
      if (myToken !== reproduccionTokenRef.current || !blobFinal || blobFinal.size < 1000) {
        if (myToken === reproduccionTokenRef.current) {
          crossfadingRef.current = false;
          crossfadeOrigenDeckRef.current = null;
        }
        return false;
      }
      const blobAdecuado = blobFinal.type && blobFinal.type.startsWith('audio/')
        ? blobFinal
        : new Blob([blobFinal], { type: 'audio/mpeg' });
      urlEntrante = URL.createObjectURL(blobAdecuado);

      const cueCached = smartAutomixEngine.obtenerCueEnCache(siguiente.nombre);
      if (cueCached) {
        cueInEntrante = cueCached.cueIn;
        cueOutEntrante = cueCached.cueOut;
        replayGainEntranteDb = cueCached.replayGainDb;
      } else {
        // Analizar en segundo plano sin bloquear el disparo del mix manual
        smartAutomixEngine
          .analizarCuePointsYReplayGain(siguiente.nombre, blobAdecuado, siguiente.duracion || 0)
          .then((resCue) => {
            if (cancionActualRef.current?.nombre === siguiente.nombre && resCue.cueOut > 0) {
              cueOutActualRef.current = resCue.cueOut;
            }
          })
          .catch(() => {});
      }
    }

    // Si otra acción de usuario invalidó este turno mientras se leía el Blob, revocar URL huérfana y abortar
    if (myToken !== reproduccionTokenRef.current) {
      revocarUrlObjetoSegura(urlEntrante, 5000);
      return true;
    }

    const urlPreviaEntrante = deckEntranteId === 'A' ? urlDeckARef.current : urlDeckBRef.current;
    const urlSalienteARevocar = deckSalienteId === 'A' ? urlDeckARef.current : urlDeckBRef.current;
    if (deckEntranteId === 'A') urlDeckARef.current = urlEntrante;
    else urlDeckBRef.current = urlEntrante;

    if (urlPreviaEntrante && urlPreviaEntrante !== urlEntrante) {
      revocarUrlObjetoSegura(urlPreviaEntrante, 5000);
    }

    const nombreSaliente = cancionActualRef.current?.nombre || 'Pista anterior';
    const siguienteSinBlob: Cancion = { ...siguiente, blob: undefined };

    // Timeout de Seguridad de 2500ms: si elEntrante.play() tarda o si a los 2.5s el Deck entrante sigue en pausa
    // o con readyState < 2, aborta el crossfade y realiza cambio directo limpio para que la cola jamás se detenga
    const safetyMixTimer = setTimeout(() => {
      if (myToken !== reproduccionTokenRef.current) return;
      if (elEntrante.paused || elEntrante.readyState < 2) {
        console.warn('[SmartAutomix Safety Timeout 2.5s]: Deck entrante no arrancó a tiempo, ejecutando transición directa...');
        cancelarCrossfade();
        reproducirCancion(siguienteSinBlob, deckSalienteId);
      }
    }, 2500);

    try {
      pausadoPorUsuarioRef.current = false;
      elEntrante.src = urlEntrante;
      elEntrante.load();
      const volMax = silenciado ? 0 : volumen;
      elEntrante.volume = volMax;
      elEntrante.playbackRate = velocidad;

      // Saltar directamente al punto exacto de golpe musical (Cue-In dinámico)
      try {
        elEntrante.currentTime = cueInEntrante;
      } catch (_) {
        elEntrante.currentTime = 0;
      }

      desbloquearAmbosDecks();
      solicitarWakeLock();
      // Si Bass Boost está activo, conectar al grafo DSP; si está apagado, preserva Hardware Audio Offload nativo
      bassBoostManager.aplicarGanancia([deckARef.current, deckBRef.current]);
      bassBoostManager.asegurarActivo();
      bassBoostManager.prepararDeckParaNuevaPista(elEntrante, replayGainEntranteDb);

      await Promise.race([
        elEntrante.play(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout play 2200ms')), 2200))
      ]);

      // Si el usuario cambió de canción otra vez mientras play() resolvía, limpiar este deck y abortar sin encimar audio
      if (myToken !== reproduccionTokenRef.current) {
        clearTimeout(safetyMixTimer);
        ignorandoPausaSalienteRef.current = true;
        setTimeout(() => {
          ignorandoPausaSalienteRef.current = false;
        }, 500);
        liberarHardwareDeck(elEntrante);
        revocarUrlObjetoSegura(urlEntrante, 5000);
        return true;
      }

      // CRÍTICO: Cambiar el puntero maestro al deck entrante ANTES de pausar jamás elSaliente
      deckActivoRef.current = deckEntranteId;
      setDeckActivo(deckEntranteId);
      cueOutActualRef.current = cueOutEntrante;
      finPistaDetectadoTimestampRef.current = 0;
      inicioPistaTimestampRef.current = Date.now();
      ultimaTransicionTimestampRef.current = Date.now();
      ultimoAvanceTimestampRef.current = Date.now();
      ultimoCurrentTimeRef.current = elEntrante.currentTime || cueInEntrante;

      historialAleatorioRef.current = [...historialAleatorioRef.current, siguienteSinBlob.nombre];
      setHistorialAleatorio((prev) => [...prev, siguienteSinBlob.nombre]);

      cancionActualRef.current = siguienteSinBlob;
      setCancionActual(siguienteSinBlob);
      setTiempoActual(elEntrante.currentTime || cueInEntrante);
      setMensajeErrorAudio(null);
      setDuracionTotal(siguienteSinBlob.duracion && siguienteSinBlob.duracion > 0 ? siguienteSinBlob.duracion : 0);

      setCancionSalienteMix(nombreSaliente);
      setProgresoMix(0);
      setEnTransicionMix(true);
      reproduciendoRef.current = true;
      setReproduciendo(true);
      actualizarMediaSessionRef.current();

      const segsMix = duracionFadeManualSegs !== undefined
        ? Math.max(1.5, duracionFadeManualSegs)
        : Math.max(2, crossfadeSegundosRef.current || 5);

      // Ejecutar Curvas Equal-Power (Web Worker Timer en Hardware Offload o 128-pt C++ con Bass-Swap activo)
      smartAutomixEngine.ejecutarSmartMix({
        ctx: bassBoostManager.getContext(),
        elSaliente,
        elEntrante,
        duracionSegs: segsMix,
        volumenUsuario: volMax,
        replayGainEntranteDb,
        onProgress: (pct) => {
          setProgresoMix(pct);
        },
        onComplete: () => {
          clearTimeout(safetyMixTimer);
          // Asegurar que deckActivoRef ya apunta a deckEntranteId e ignorar durante 500ms el evento onPause de elSaliente
          deckActivoRef.current = deckEntranteId;
          ignorandoPausaSalienteRef.current = true;
          setTimeout(() => {
            ignorandoPausaSalienteRef.current = false;
          }, 500);
          // Liberar inmediatamente el MediaPlayer y MediaCodec nativo del Deck saliente
          liberarHardwareDeck(elSaliente);
          // Revocar el ObjectURL del Deck saliente tras 5000ms verificando que no sea igual al del Deck activo
          const urlActivaActual = deckEntranteId === 'A' ? urlDeckARef.current : urlDeckBRef.current;
          if (urlSalienteARevocar && urlSalienteARevocar !== urlEntrante && urlSalienteARevocar !== urlActivaActual) {
            if (deckSalienteId === 'A' && urlDeckARef.current === urlSalienteARevocar) {
              urlDeckARef.current = null;
            } else if (deckSalienteId === 'B' && urlDeckBRef.current === urlSalienteARevocar) {
              urlDeckBRef.current = null;
            }
            revocarUrlObjetoSegura(urlSalienteARevocar, 5000);
          }
          try {
            elEntrante.volume = silenciado ? 0 : volumen;
          } catch (_) {}
          crossfadingRef.current = false;
          crossfadeOrigenDeckRef.current = null;
          setEnTransicionMix(false);
          setProgresoMix(100);
          setCancionSalienteMix('');
        }
      });

      return true;
    } catch (errMix) {
      clearTimeout(safetyMixTimer);
      console.warn('[Spotify Automix] Falló play en deck secundario, usando transición directa:', errMix);
      ignorandoPausaSalienteRef.current = true;
      setTimeout(() => {
        ignorandoPausaSalienteRef.current = false;
      }, 500);
      liberarHardwareDeck(elEntrante);
      crossfadingRef.current = false;
      crossfadeOrigenDeckRef.current = null;
      setEnTransicionMix(false);
      // Si ya se había retirado de la cola o estábamos en transición automática, avanzar con reproducirCancion directo
      reproducirCancion(siguienteSinBlob, deckSalienteId);
      return true;
    }
  };

  // Ejecutar un SmartMix DJ instantáneo de 2.2 segundos ahora mismo hacia la siguiente canción (o una canción específica)
  const ejecutarMixManualAhora = async (cancionEspecifica?: Cancion) => {
    const activo = getActiveDeckEl();
    const durFade = 2.2;
    if (activo && !activo.paused && activo.currentTime > 0.8 && (!document || !document.hidden)) {
      const exito = await iniciarCrossfadeSpotify(durFade, cancionEspecifica);
      if (exito) return;
    }
    if (cancionEspecifica) {
      reproducirCancion(cancionEspecifica, deckActivoRef.current);
    } else {
      siguienteCancion(true);
    }
  };

  const activarModoDJ = () => {
    if (crossfadeSegundos === 0) {
      cambiarCrossfade(5);
    }
    setModoAleatorio(true);
    modoAleatorioRef.current = true;
    setMixManualActivo(true);
    mixManualActivoRef.current = true;
    try {
      localStorage.setItem('app_musica_aleatorio', 'true');
      localStorage.setItem('app_musica_mix_manual_v31', 'true');
    } catch (_) {}

    if (reproduciendo && cancionActual) {
      mostrarToast('🎧 ¡DJ Automix en vivo! Mezclando siguiente pista...', 'exito');
      ejecutarMixManualAhora();
      return;
    }

    mostrarToast(`🎧 ¡Modo DJ Automix Activado! (${crossfadeSegundos || 5}s Equal-Power Mix)`, 'exito');

    if (!reproduciendo) {
      if (cancionActual) {
        alternarReproduccion();
      } else if (listaContextoRef.current.length > 0) {
        const aleatoria = listaContextoRef.current[Math.floor(Math.random() * listaContextoRef.current.length)];
        reproducirCancion(aleatoria);
      } else if (bibliotecaRef.current.length > 0) {
        const aleatoria = bibliotecaRef.current[Math.floor(Math.random() * bibliotecaRef.current.length)];
        reproducirCancion(aleatoria);
      }
    }
  };

  // Reproducir canción (soporta transición Automix DJ de 2.2s si ya hay música sonando, o arranque directo en el deck activo)
  const reproducirCancion = async (cancion: Cancion, forzarDeck?: 'A' | 'B') => {
    // Si el usuario elige otra canción manualmente mientras una pista ya lleva >2s sonando y el Mix Manual + Crossfade están activos,
    // ejecutar un SmartMix rápido de 2.2 segundos saltando directo al Cue-In de la nueva pista
    const elActual = getActiveDeckEl();
    if (
      !forzarDeck &&
      crossfadeSegundosRef.current > 0 &&
      mixManualActivoRef.current &&
      reproduciendoRef.current &&
      elActual &&
      !elActual.paused &&
      elActual.currentTime > 2 &&
      !crossfadingRef.current &&
      !smartAutomixEngine.isMixing() &&
      (!document || !document.hidden) &&
      cancionActualRef.current?.nombre !== cancion.nombre
    ) {
      const mezclado = await iniciarCrossfadeSpotify(2.2, cancion);
      if (mezclado) return;
    }

    const myToken = ++reproduccionTokenRef.current;
    cancelarCrossfade();
    detenerPreview();

    const targetDeck: 'A' | 'B' = forzarDeck || deckActivoRef.current || 'A';
    const el = targetDeck === 'A' ? deckARef.current : deckBRef.current;
    const elOtro = targetDeck === 'A' ? deckBRef.current : deckARef.current;

    if (!el) return;

    cambiandoPistaRef.current = true;
    pausadoPorUsuarioRef.current = false;
    recuperandoStallRef.current = false;
    finPistaDetectadoTimestampRef.current = 0;
    inicioPistaTimestampRef.current = Date.now();
    ultimaTransicionTimestampRef.current = Date.now();
    ultimoAvanceTimestampRef.current = Date.now();
    ultimoCurrentTimeRef.current = 0;

    // CRÍTICO: Ignorar eventos onPause transitorios de ambos elementos mientras se carga el nuevo audio
    ignorandoPausaSalienteRef.current = true;
    setTimeout(() => {
      ignorandoPausaSalienteRef.current = false;
    }, 600);
    // Limpiar el Deck inactivo únicamente si tenía un recurso cargado
    if (elOtro && (elOtro.getAttribute('src') || (elOtro.src && elOtro.src !== window.location.href))) {
      liberarHardwareDeck(elOtro);
    }

    const cancionLigera: Cancion = { ...cancion, blob: undefined };
    // Actualizar referencias de canción actual de inmediato para que cualquier lectura síncrona sea consistente
    cancionActualRef.current = cancionLigera;
    setCancionActual(cancionLigera);
    setTiempoActual(0);
    setMensajeErrorAudio(null);
    setDuracionTotal(cancion.duracion && cancion.duracion > 0 ? cancion.duracion : 0);
    cueOutActualRef.current = cancion.duracion && cancion.duracion > 6 ? cancion.duracion - 0.8 : 0;

    const urlPreviaDeck = targetDeck === 'A' ? urlDeckARef.current : urlDeckBRef.current;

    // Verificar si ya estaba precargada en precargaMixRef
    let urlTemporal = '';
    let replayGainInicialDb = 0;
    if (precargaMixRef.current && precargaMixRef.current.nombre === cancion.nombre && precargaMixRef.current.url) {
      urlTemporal = precargaMixRef.current.url;
      cueOutActualRef.current = precargaMixRef.current.cueOut;
      replayGainInicialDb = precargaMixRef.current.replayGainDb;
      precargaMixRef.current = null;
    } else {
      let blobFinal = cancion.blob;
      if (!blobFinal || blobFinal.size < 1000) {
        blobFinal = (await obtenerBlobCancionBajoDemanda(cancion.nombre)) || undefined;
      }

      if (myToken !== reproduccionTokenRef.current) return;

      if (!blobFinal || blobFinal.size < 1000) {
        // Si estamos con internet y era una pista en cola no descargada, intentar resolver stream rápido
        if (typeof navigator !== 'undefined' && navigator.onLine) {
          try {
            const urlEnlace = obtenerUrlApi(`/api/obtener-enlace?q=${encodeURIComponent(cancion.nombre)}&artist=${encodeURIComponent(cancion.artista || '')}`);
            if (urlEnlace) {
              const data = await fetchJsonSeguro<{ downloadUrl?: string }>(urlEnlace);
              if (myToken !== reproduccionTokenRef.current) return;
              if (data && data.downloadUrl) {
                const urlProxy = obtenerUrlApi(`/api/proxy-stream?url=${encodeURIComponent(data.downloadUrl)}`);
                let streamRes = urlProxy ? await fetch(urlProxy).catch(() => null) : null;
                if (!streamRes || !streamRes.ok) {
                  streamRes = await fetch(data.downloadUrl).catch(() => null);
                }
                if (myToken !== reproduccionTokenRef.current) return;
                if (streamRes && streamRes.ok) {
                  const ct = (streamRes.headers.get('content-type') || '').toLowerCase();
                  if (!ct.includes('text/html')) {
                    blobFinal = await streamRes.blob();
                  }
                }
              }
            }
          } catch (errRadio) {
            console.warn('Error resolviendo streaming:', errRadio);
          }
        }
      }

      if (myToken !== reproduccionTokenRef.current) return;

      // Si la pista no tiene audio válido, NUNCA cortar la música en seco: saltar automáticamente a la siguiente canción disponible
      if (!blobFinal || blobFinal.size < 1000) {
        console.warn('Audio no encontrado para:', cancion.nombre, '- saltando a la siguiente pista válida');
        cambiandoPistaRef.current = false;
        intentosFallidosConsecutivosRef.current += 1;
        if (intentosFallidosConsecutivosRef.current <= 5 && bibliotecaRef.current.length > 1) {
          setTimeout(() => {
            if (myToken === reproduccionTokenRef.current) {
              reproducirSiguienteRef.current(true);
            }
          }, 120);
        } else {
          intentosFallidosConsecutivosRef.current = 0;
          mostrarToast(`No se encontró el audio de "${cancion.nombre}"`, 'info');
        }
        return;
      }

      intentosFallidosConsecutivosRef.current = 0;

      const blobAdecuado = blobFinal.type && blobFinal.type.startsWith('audio/')
        ? blobFinal
        : new Blob([blobFinal], { type: 'audio/mpeg' });

      urlTemporal = URL.createObjectURL(blobAdecuado);

      // Analizar en segundo plano Cue-Out y ReplayGain de la pista activa sin retrasar el inicio
      const cueCache = smartAutomixEngine.obtenerCueEnCache(cancion.nombre);
      if (cueCache) {
        cueOutActualRef.current = cueCache.cueOut;
        replayGainInicialDb = cueCache.replayGainDb;
      } else {
        smartAutomixEngine
          .analizarCuePointsYReplayGain(cancion.nombre, blobAdecuado, cancion.duracion || 0)
          .then((resCue) => {
            if (cancionActualRef.current?.nombre === cancion.nombre) {
              if (resCue.cueOut > 0) cueOutActualRef.current = resCue.cueOut;
              if (resCue.replayGainDb !== 0) {
                bassBoostManager.prepararDeckParaNuevaPista(el, resCue.replayGainDb);
              }
            }
          })
          .catch(() => {});
      }
    }

    if (targetDeck === 'A') urlDeckARef.current = urlTemporal;
    else urlDeckBRef.current = urlTemporal;

    // Revocar el ObjectURL previo tras 5000ms verificando que no sea igual al actual
    if (urlPreviaDeck && urlPreviaDeck !== urlTemporal) {
      revocarUrlObjetoSegura(urlPreviaDeck, 5000);
    }

    deckActivoRef.current = targetDeck;
    setDeckActivo(targetDeck);

    // Actualizar historial aleatorio en Ref y en State
    historialAleatorioRef.current = [...historialAleatorioRef.current, cancion.nombre];
    setHistorialAleatorio((prev) => [...prev, cancion.nombre]);

    // Asignación directa sobre el elemento <audio> activo
    el.src = urlTemporal;
    el.load();
    el.volume = silenciado ? 0 : volumen;
    el.playbackRate = velocidad;
    el.currentTime = 0;
    ultimoCurrentTimeRef.current = 0;
    ultimoAvanceTimestampRef.current = Date.now();

    const safetyTimeout = setTimeout(() => {
      if (myToken === reproduccionTokenRef.current) {
        cambiandoPistaRef.current = false;
      }
    }, 3500);

    const iniciarPlay = () => {
      // Asegurar que cuando Bass Boost está apagado NUNCA se conecte <audio> a createMediaElementSource()
      // y cuando está activo se reanude el AudioContext sin bloquear la promesa de audioEl.play()
      desbloquearAmbosDecks();
      solicitarWakeLock();
      if (bassBoostManager.isActivo()) {
        bassBoostManager.connectAudioElement(el).catch(() => {});
        bassBoostManager.asegurarActivo().catch(() => {});
        bassBoostManager.aplicarGanancia([deckARef.current, deckBRef.current]);
        bassBoostManager.prepararDeckParaNuevaPista(el, replayGainInicialDb).catch(() => {});
        smartAutomixEngine.resetDeckToUnity(bassBoostManager.getContext(), el);
      }

      if (myToken !== reproduccionTokenRef.current) {
        clearTimeout(safetyTimeout);
        return;
      }

      const intentarPlay = (intentosRestantes: number) => {
        if (myToken !== reproduccionTokenRef.current) {
          clearTimeout(safetyTimeout);
          return;
        }
        const playPromise = el.play();
        if (playPromise !== undefined) {
          playPromise
            .then(() => {
              if (myToken !== reproduccionTokenRef.current) return;
              clearTimeout(safetyTimeout);
              inicioPistaTimestampRef.current = Date.now();
              ultimoAvanceTimestampRef.current = Date.now();
              reproduciendoRef.current = true;
              setReproduciendo(true);
              setMensajeErrorAudio(null);
              cambiandoPistaRef.current = false;
              actualizarMediaSessionRef.current();
            })
            .catch((err) => {
              if (myToken !== reproduccionTokenRef.current) {
                clearTimeout(safetyTimeout);
                return;
              }
              console.warn('Autoplay esperando buffer o reintentando:', err);
              if (el.readyState >= 2 && intentosRestantes > 0) {
                setTimeout(() => intentarPlay(intentosRestantes - 1), 150);
                return;
              }
              const onCanPlay = () => {
                if (myToken !== reproduccionTokenRef.current) return;
                desbloquearAmbosDecks();
                solicitarWakeLock();
                el.play()
                  .then(() => {
                    if (myToken !== reproduccionTokenRef.current) return;
                    clearTimeout(safetyTimeout);
                    inicioPistaTimestampRef.current = Date.now();
                    ultimoAvanceTimestampRef.current = Date.now();
                    reproduciendoRef.current = true;
                    setReproduciendo(true);
                    setMensajeErrorAudio(null);
                    cambiandoPistaRef.current = false;
                    actualizarMediaSessionRef.current();
                  })
                  .catch((e2) => {
                    clearTimeout(safetyTimeout);
                    console.warn('Fallo en play canplay:', e2);
                    if (myToken === reproduccionTokenRef.current) {
                      setReproduciendo(false);
                      cambiandoPistaRef.current = false;
                    }
                  });
              };
              el.addEventListener('canplay', onCanPlay, { once: true });
            });
        }
      };

      intentarPlay(2);
    };

    iniciarPlay();
  };

  // Reproducción Consecutiva Determinista Estilo Spotify (usando siempre Refs frescas para Bluetooth y Automix)
  const siguienteCancion = async (forzarDirectoOEvento?: boolean | React.MouseEvent) => {
    const esClickUsuarioUI = typeof forzarDirectoOEvento === 'object' && forzarDirectoOEvento !== null;
    const elActivo = getActiveDeckEl();

    // Si el usuario pulsó Siguiente en la interfaz (no por fin de pista ni por botón remoto en pantalla apagada)
    // y tiene activo el Crossfade + Mix Manual, realizar un SmartMix rápido de 2.2 segundos saltando al Cue-In
    if (
      esClickUsuarioUI &&
      crossfadeSegundosRef.current > 0 &&
      mixManualActivoRef.current &&
      reproduciendoRef.current &&
      elActivo &&
      !elActivo.paused &&
      elActivo.currentTime > 1.5 &&
      !crossfadingRef.current &&
      !smartAutomixEngine.isMixing() &&
      (!document || !document.hidden)
    ) {
      const mezclado = await iniciarCrossfadeSpotify(2.2);
      if (mezclado) return;
    }

    cancelarCrossfade();
    const colaActual = colaReproduccionRef.current;
    let siguiente: Cancion | null = null;
    if (colaActual.length > 0) {
      siguiente = colaActual[0];
    } else if (
      modoRepeticionRef.current !== 'one' &&
      precargaMixRef.current &&
      precargaMixRef.current.cancion &&
      precargaMixRef.current.url &&
      precargaMixRef.current.nombre !== cancionActualRef.current?.nombre
    ) {
      // Usar la pista ya precargada en RAM para cambio 100% síncrono en segundo plano sin esperas de IndexedDB
      siguiente = precargaMixRef.current.cancion;
    } else {
      siguiente = obtenerSiguienteCancion();
    }

    if (siguiente) {
      if (colaActual.length > 0 && colaActual[0].nombre === siguiente.nombre) {
        const nuevaCola = colaActual.slice(1);
        colaReproduccionRef.current = nuevaCola;
        setColaReproduccion(nuevaCola);
      }
      // Cuando document.hidden === true (pantalla apagada) o fin de pista en segundo plano:
      // alternar de Deck para forzar transición atómica inmediata y liberar el decodificador MediaCodec de elSaliente
      const deckDestino: 'A' | 'B' =
        typeof document !== 'undefined' && document.hidden
          ? (deckActivoRef.current === 'A' ? 'B' : 'A')
          : deckActivoRef.current;
      reproducirCancion(siguiente, deckDestino);
    } else {
      reproduciendoRef.current = false;
      setReproduciendo(false);
      soltarWakeLock();
    }
  };
  const reproducirSiguiente = siguienteCancion;

  const anteriorCancion = () => {
    cancelarCrossfade();
    const listaRep = listaParaReproduccionRef.current;
    const listaCtx = listaContextoRef.current;
    const bib = bibliotecaRef.current;
    let lista = listaRep.length > 0 ? listaRep : listaCtx;
    if (lista.length === 0) lista = bib;
    if (lista.length === 0) return;

    const actual = cancionActualRef.current;
    if (!actual) {
      reproducirCancion(lista[0], deckActivoRef.current);
      return;
    }

    const activo = getActiveDeckEl();
    if (activo && activo.currentTime > 3) {
      activo.currentTime = 0;
      ultimoCurrentTimeRef.current = 0;
      ultimoAvanceTimestampRef.current = Date.now();
      setTiempoActual(0);
      return;
    }

    const idx = lista.findIndex((c) => c.nombre === actual.nombre);
    if (idx > 0) {
      reproducirCancion(lista[idx - 1], deckActivoRef.current);
    } else {
      reproducirCancion(lista[lista.length - 1], deckActivoRef.current);
    }
  };
  const reproducirAnterior = anteriorCancion;

  const alTerminarDeck = (deck: 'A' | 'B') => {
    const elTerminado = deck === 'A' ? deckARef.current : deckBRef.current;
    const elOtroDeck = deck === 'A' ? deckBRef.current : deckARef.current;

    // 1. Ignorar por completo cualquier evento onEnded emitido por el Deck saliente/inactivo y liberar su MediaPlayer
    if (deckActivoRef.current !== deck) {
      ignorandoPausaSalienteRef.current = true;
      setTimeout(() => {
        ignorandoPausaSalienteRef.current = false;
      }, 500);
      if (elTerminado) {
        elTerminado.pause();
        elTerminado.removeAttribute('src');
        elTerminado.load();
      }
      liberarHardwareDeck(elTerminado);
      return;
    }

    // 2. Fallback infalible en onEnded del Deck activo:
    // Si el otro Deck no está sonando activamente, forzar transición atómica inmediata a siguienteCancion()
    // y liberar el decodificador MediaCodec de elSaliente cuando document.hidden === true
    const otroReproduciendo = Boolean(
      elOtroDeck && !elOtroDeck.paused && !elOtroDeck.ended && elOtroDeck.currentTime > 0
    );

    if (!otroReproduciendo) {
      if (crossfadingRef.current || smartAutomixEngine.isMixing()) {
        cancelarCrossfade();
      }
      if (typeof document !== 'undefined' && document.hidden && elTerminado && modoRepeticionRef.current !== 'one') {
        const elSaliente = elTerminado;
        ignorandoPausaSalienteRef.current = true;
        setTimeout(() => {
          ignorandoPausaSalienteRef.current = false;
        }, 500);
        elSaliente.pause();
        elSaliente.removeAttribute('src');
        elSaliente.load();
      }
      alTerminarPista(true);
    }
  };

  const alTerminarPista = (forzarAvance: boolean = false) => {
    const ahora = Date.now();
    if (!forzarAvance && ahora - ultimaTransicionTimestampRef.current < 1200) {
      return;
    }
    ultimaTransicionTimestampRef.current = ahora;
    finPistaDetectadoTimestampRef.current = 0;

    if (timerOpcion === -1) {
      desvanecerYApagar();
      return;
    }

    if (modoRepeticionRef.current === 'one') {
      const activo = getActiveDeckEl();
      if (activo) {
        activo.currentTime = 0;
        ultimoCurrentTimeRef.current = 0;
        inicioPistaTimestampRef.current = Date.now();
        ultimoAvanceTimestampRef.current = Date.now();
        activo.play().then(() => setReproduciendo(true)).catch(console.error);
      }
      return;
    }

    // Avanzar infaliblemente a la siguiente canción
    reproducirSiguienteRef.current(true);
  };

  // Función de autorecuperación en milisegundo exacto ante stall / error / congelamiento de 3.5s
  const recuperarAudioCongelado = useCallback(async (motivo: string) => {
    if (recuperandoStallRef.current || cambiandoPistaRef.current || crossfadingRef.current || smartAutomixEngine.isMixing()) return;
    const targetDeck = deckActivoRef.current;
    const el = getActiveDeckEl();
    const cancion = cancionActualRef.current;
    if (!el || !cancion) return;

    recuperandoStallRef.current = true;
    const tiempoExacto = el.currentTime || ultimoCurrentTimeRef.current || 0;
    console.warn(`[Watchdog Anti-Congelamiento] Detectado (${motivo}) en "${cancion.nombre}" @ ${tiempoExacto.toFixed(2)}s. Recargando Blob fresco...`);

    try {
      const blobFresco = await obtenerBlobCancionBajoDemanda(cancion.nombre);
      if (blobFresco && blobFresco.size > 1000) {
        const blobAdecuado = blobFresco.type && blobFresco.type.startsWith('audio/')
          ? blobFresco
          : new Blob([blobFresco], { type: 'audio/mpeg' });
        const urlPrevia = targetDeck === 'A' ? urlDeckARef.current : urlDeckBRef.current;
        const nuevaUrl = URL.createObjectURL(blobAdecuado);
        if (targetDeck === 'A') urlDeckARef.current = nuevaUrl;
        else urlDeckBRef.current = nuevaUrl;

        if (urlPrevia && urlPrevia !== nuevaUrl) {
          revocarUrlObjetoSegura(urlPrevia, 200);
        }

        el.src = nuevaUrl;
        el.load();
        if (tiempoExacto > 0) {
          try {
            el.currentTime = tiempoExacto;
          } catch (_) {
            el.addEventListener('loadedmetadata', () => {
              try {
                el.currentTime = tiempoExacto;
              } catch (_) {}
            }, { once: true });
          }
        }
        bassBoostManager.asegurarActivo();
        await el.play();
        ultimoAvanceTimestampRef.current = Date.now();
        ultimoCurrentTimeRef.current = tiempoExacto;
        reproduciendoRef.current = true;
        setReproduciendo(true);
        recuperandoStallRef.current = false;
        return;
      }
    } catch (errRec) {
      console.warn('[Watchdog Anti-Congelamiento] Falló recarga en milisegundo exacto, saltando a siguienteCancion():', errRec);
    }

    recuperandoStallRef.current = false;
    reproducirSiguienteRef.current(true);
  }, []);

  // Watchdog Anti-Congelamiento y Garantía de Continuidad Infinita (supervisión cada 1000ms)
  useEffect(() => {
    const watchdogInterval = setInterval(() => {
      if (!reproduciendoRef.current || pausadoPorUsuarioRef.current) return;
      const el = getActiveDeckEl();
      if (!el) return;

      const ahora = Date.now();

      // Si un crossfade quedó colgado por más de 9 segundos, liberarlo para no bloquear el Watchdog
      if ((crossfadingRef.current || smartAutomixEngine.isMixing()) && ahora - ultimaTransicionTimestampRef.current > 9000) {
        cancelarCrossfade();
      }

      if (cambiandoPistaRef.current || recuperandoStallRef.current) return;

      const dur = (el.duration && isFinite(el.duration) && el.duration > 0) ? el.duration : duracionTotalRef.current;
      const cercaDelFinal = dur > 5 && dur - el.currentTime <= 0.8;

      // 1. Si la pista está a <= 0.8s del final o en el.ended === true y lleva >= 1.5s sin pasar a la siguiente canción,
      // forzar automáticamente siguienteCancion()
      if (el.ended || cercaDelFinal) {
        if (finPistaDetectadoTimestampRef.current === 0) {
          finPistaDetectadoTimestampRef.current = ahora;
        } else if (ahora - finPistaDetectadoTimestampRef.current >= 1500) {
          console.log('[Watchdog] Fin de pista retenido (>1.5s), forzando siguienteCancion()...');
          finPistaDetectadoTimestampRef.current = 0;
          if (crossfadingRef.current || smartAutomixEngine.isMixing()) {
            cancelarCrossfade();
          }
          alTerminarPistaRef.current();
          return;
        }
        if (el.ended && ahora - ultimaTransicionTimestampRef.current >= 1200) {
          finPistaDetectadoTimestampRef.current = 0;
          alTerminarPistaRef.current();
          return;
        }
      } else {
        finPistaDetectadoTimestampRef.current = 0;
      }

      if (ahora - ultimaTransicionTimestampRef.current < 2500) return;
      if (ahora - inicioPistaTimestampRef.current < 2500) return;
      if (crossfadingRef.current || smartAutomixEngine.isMixing()) return;

      // 2. Si el estado reproduciendo es true pero el elemento fue pausado inesperadamente por el sistema
      if (el.paused && !el.ended && !arrastrandoSeekRef.current && cancionActualRef.current) {
        console.log('[Watchdog] Audio en pausa inesperada en segundo plano, reanudando...');
        bassBoostManager.asegurarActivo();
        el.play()
          .then(() => {
            ultimoAvanceTimestampRef.current = Date.now();
          })
          .catch(() => {
            recuperarAudioCongelado('pausa inesperada bloqueada');
          });
        return;
      }

      // 3. Si reproduciendo es true y no está en paused, verificar si currentTime lleva >= 3.5 segundos sin avanzar
      if (!el.paused && !arrastrandoSeekRef.current && cancionActualRef.current) {
        const diffTiempo = Math.abs(el.currentTime - ultimoCurrentTimeRef.current);
        if (diffTiempo > 0.04) {
          ultimoCurrentTimeRef.current = el.currentTime;
          ultimoAvanceTimestampRef.current = ahora;
        } else if (ahora - ultimoAvanceTimestampRef.current >= 3500) {
          recuperarAudioCongelado('currentTime congelado por 3.5s');
        }
      }
    }, 1000);

    return () => clearInterval(watchdogInterval);
  }, [recuperarAudioCongelado]);

  // Handlers para eventos de audio con emisión desacoplada de tiempo + disparo de SmartAutomix con Cue-Out dinámico
  const alTiempoActualDeck = (deck: 'A' | 'B') => {
    const el = deck === 'A' ? deckARef.current : deckBRef.current;
    if (!el) return;

    if (deckActivoRef.current === deck && !cambiandoPistaRef.current) {
      const curr = el.currentTime;
      if (Math.abs(curr - ultimoCurrentTimeRef.current) > 0.04) {
        ultimoCurrentTimeRef.current = curr;
        ultimoAvanceTimestampRef.current = Date.now();
      }
      const durReal = (el.duration && isFinite(el.duration) && el.duration > 0) ? el.duration : 0;
      const dur = durReal > 0 ? durReal : duracionTotal;

      // AISLAMIENTO TOTAL: Emitir progreso directamente a los subcomponentes suscritos.
      audioProgress.emit(curr, dur);

      // Asegurar que Web Audio siga corriendo si el elemento está reproduciendo
      if (!el.paused) {
        bassBoostManager.resume();
      }

      // Monitoreo pasivo de escucha: registrar en historial UNA SOLA VEZ por pista al superar 20s
      if (
        cancionActual &&
        curr >= 20 &&
        pistaHistorialRegistradaRef.current !== cancionActual.nombre
      ) {
        pistaHistorialRegistradaRef.current = cancionActual.nombre;
        agregarAlHistorial(cancionActual, curr, dur);
      }

      // Optimización de rendimiento: Evitar re-renders masivos por milisegundos insignificantes
      if (durReal > 0 && (!duracionTotal || Math.abs(duracionTotal - durReal) > 0.5)) {
        setDuracionTotal(durReal);
      }

      // Sincronizar barra de progreso del sistema Android cada 1.5 segundos en onTimeUpdate (validando duration > 0 y position <= duration)
      const sincronizadoPos = sincronizarMediaSessionPosition(dur || 0, curr, el.playbackRate || 1);
      if (sincronizadoPos && cancionActualRef.current) {
        const pistaAct = cancionActualRef.current;
        const parsedAct = parsearTituloYArtista(pistaAct.nombre, pistaAct.artista);
        actualizarNotificacionNativa(
          limpiarTextoMetadata(parsedAct.tituloLimpio || pistaAct.nombre),
          limpiarTextoMetadata(parsedAct.artistaLimpio || pistaAct.artista || 'Música'),
          dur || 0,
          curr,
          !el.paused,
          obtenerUrlCaratulaValida(pistaAct.caratula, pistaAct.nombre, pistaAct.artista)
        );
      }

      // Pre-buffer predictivo estilo Spotify:
      // - A los >= 2s precarga en RAM si ya está en IndexedDB
      // - Cuando currentTime > 10s, verifica cuál es la siguiente canción en la cola (colaManual[0] o la siguiente de la lista/radio)
      //   y si aún no está en IndexedDB (`localforage`), la precarga en segundo plano de forma silenciosa (0ms de espera de red)
      if (curr >= 2 && !el.paused && modoRepeticionRef.current !== 'one') {
        precargarSiguienteParaMix();
      }
      if (curr > 10 && !el.paused && modoRepeticionRef.current !== 'one') {
        const sigCola = colaReproduccionRef.current[0] || obtenerSiguienteCancion();
        if (sigCola) {
          prebufferPistaEnIndexedDB(sigCola).then((blobDescargado) => {
            if (blobDescargado && (!precargaMixRef.current || precargaMixRef.current.nombre !== sigCola.nombre)) {
              precargarSiguienteParaMix();
            }
          }).catch(() => {});
        }
      }

      const restanteCancion = durReal > 0 ? durReal - curr : 0;

      // Sleep Timer inteligente: Desvanecimiento suave en los últimos 10 segundos de la pista actual
      if (timerOpcion === -1 && durReal > 10 && curr > 2) {
        if (restanteCancion <= 10 && restanteCancion > 0) {
          const factor = Math.max(0, restanteCancion / 10);
          el.volume = Math.max(0, (silenciado ? 0 : volumen) * factor);
        }
        return;
      }

      // --- MOTOR SPOTIFY AUTOMIX PRO CON CUE-OUT SEGURO (SÓLO CON PANTALLA VISIBLE Y CROSSFADE ACTIVO) ---
      const cfSegs = crossfadeSegundosRef.current;
      if (
        cfSegs > 0 &&
        durReal > cfSegs + 4 &&
        curr > 2 &&
        !el.paused &&
        !arrastrandoSeekRef.current &&
        modoRepeticionRef.current !== 'one' &&
        (typeof document === 'undefined' || !document.hidden)
      ) {
        // Limitar estrictamente puntoCueOut para que jamás recorte más de los últimos 4.5s reales de la canción
        const cueOutSeguro =
          cueOutActualRef.current > cfSegs + 4 && cueOutActualRef.current <= durReal
            ? Math.max(durReal - 4.5, cueOutActualRef.current)
            : durReal;
        const restanteHastaCueOut = Math.max(0, cueOutSeguro - curr);

        // Disparar SmartAutomix únicamente en (cueOutSeguro - crossfadeSegundos)
        if (
          restanteHastaCueOut <= cfSegs &&
          restanteCancion >= 1.2 &&
          !crossfadingRef.current &&
          !smartAutomixEngine.isMixing()
        ) {
          iniciarCrossfadeSpotify(Math.min(cfSegs, Math.max(1.8, restanteCancion - 0.2)));
        }
      }
    }
  };

  const alMetadatosDeck = (deck: 'A' | 'B') => {
    const el = deck === 'A' ? deckARef.current : deckBRef.current;
    if (deckActivoRef.current === deck && el) {
      if (isFinite(el.duration) && el.duration > 0) {
        duracionTotalRef.current = el.duration;
        setDuracionTotal(el.duration);
        if (cueOutActualRef.current <= 0 || cueOutActualRef.current > el.duration) {
          cueOutActualRef.current = Math.max(0, el.duration - 0.8);
        }
        if (el.currentTime <= el.duration) {
          sincronizarMediaSessionPosition(el.duration, el.currentTime || 0, 1, true);
        }
      }
      actualizarMediaSessionRef.current();
    }
  };

  const alStallDeck = (deck: 'A' | 'B') => {
    if (
      deckActivoRef.current !== deck ||
      !reproduciendoRef.current ||
      cambiandoPistaRef.current ||
      crossfadingRef.current ||
      smartAutomixEngine.isMixing()
    ) {
      return;
    }
    const el = getActiveDeckEl();
    if (!el || el.paused) return;
    // Si dispara stalled y en 1.2s no ha vuelto a avanzar, recargar Blob fresco en el milisegundo exacto
    const tSnapshot = el.currentTime;
    setTimeout(() => {
      const actualEl = getActiveDeckEl();
      if (reproduciendoRef.current && actualEl && Math.abs(actualEl.currentTime - tSnapshot) < 0.05) {
        recuperarAudioCongelado('evento stalled');
      }
    }, 1200);
  };

  // Recuperación automática ante errores de decodificación o reproducción
  const alErrorDeck = async (deck: 'A' | 'B', e: any) => {
    const el = deck === 'A' ? deckARef.current : deckBRef.current;
    // Ignorar por completo eventos de error de un Deck cuyo src fue vaciado por liberarHardwareDeck
    const attrSrc = el ? el.getAttribute('src') : null;
    if (
      !el ||
      !attrSrc ||
      attrSrc === '' ||
      !el.src ||
      el.src === window.location.href ||
      !el.error ||
      ignorandoPausaSalienteRef.current
    ) {
      return;
    }
    // Ignorar errores de aborto normal provocados al cambiar de src rápidamente
    if (el.error.code === 1) {
      return;
    }
    if (deckActivoRef.current !== deck) {
      return;
    }

    console.error(`Error decodificando audio en reproductor (${deck}):`, e);
    cambiandoPistaRef.current = false;
    if (crossfadingRef.current) {
      cancelarCrossfade();
    }

    await recuperarAudioCongelado('evento error');
  };

  const agregarACola = (cancion: Cancion, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setColaReproduccion((prev) => [...prev, cancion]);
    mostrarToast(`"${cancion.nombre}" agregada a la cola`, 'exito');
  };

  const agregarItemBusquedaACola = (item: ResultadoBusqueda, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const existente = biblioteca.find(
      (c) => c.nombre.trim().toLowerCase() === item.title.trim().toLowerCase()
    );
    if (existente) {
      agregarACola(existente, e);
      return;
    }
    const cancionVirtual: Cancion = {
      nombre: item.title,
      blob: new Blob([], { type: 'audio/mpeg' }),
      tamano: 0,
      duracion: item.seconds || 0,
      caratula: item.thumbnail,
      artista: item.artist
    };
    setColaReproduccion((prev) => [...prev, cancionVirtual]);
    mostrarToast(`"${item.title}" añadida a la cola`, 'exito');
  };

  const quitarDeCola = (index: number) => {
    setColaReproduccion((prev) => prev.filter((_, i) => i !== index));
    mostrarToast('Pista retirada de la cola');
  };

  const reordenarCola = (origen: number, destino: number) => {
    setColaReproduccion((prev) => {
      if (destino < 0 || destino >= prev.length) return prev;
      const nueva = [...prev];
      const [item] = nueva.splice(origen, 1);
      nueva.splice(destino, 0, item);
      return nueva;
    });
  };

  // Detener y liberar audio de vista previa
  const detenerPreview = useCallback(() => {
    if (audioPreviewRef.current) {
      try {
        audioPreviewRef.current.pause();
        audioPreviewRef.current.removeAttribute('src');
        audioPreviewRef.current.load();
      } catch (_) {}
    }
    setPreviewActivo(null);
  }, []);

  // Alternar reproducción de vista previa de una canción en búsqueda (con fallback automático a streaming completo)
  const alternarPreview = useCallback(async (item: ResultadoBusqueda) => {
    if (previewActivo && previewActivo.videoId === item.videoId) {
      if (audioPreviewRef.current) {
        if (previewActivo.reproduciendo) {
          audioPreviewRef.current.pause();
          setPreviewActivo((prev) => (prev ? { ...prev, reproduciendo: false } : null));
        } else {
          try {
            await audioPreviewRef.current.play();
            setPreviewActivo((prev) => (prev ? { ...prev, reproduciendo: true } : null));
          } catch (e) {
            console.warn('Error al reanudar previa:', e);
          }
        }
      }
      return;
    }

    // Si el reproductor principal de la biblioteca estaba sonando o en pleno SmartMix, pausarlo automáticamente al iniciar la vista previa
    if (reproduciendo || reproduciendoRef.current || crossfadingRef.current || smartAutomixEngine.isMixing()) {
      pausadoPorUsuarioRef.current = true;
      cancelarCrossfade();
      if (deckARef.current) deckARef.current.pause();
      if (deckBRef.current) deckBRef.current.pause();
      reproduciendoRef.current = false;
      setReproduciendo(false);
    }

    setPreviewActivo({
      videoId: item.videoId,
      title: item.title,
      artist: item.artist,
      thumbnail: item.thumbnail,
      cargando: true,
      reproduciendo: false,
      duracion: item.seconds || 30,
      tiempo: 0,
      itemOriginal: item
    });

    if (!audioPreviewRef.current) {
      audioPreviewRef.current = new Audio();
    }
    const audioEl = audioPreviewRef.current;

    const baseBackend = (backendUrlConfig || obtenerBackendBaseUrl() || BACKEND_URL_DEFAULT).replace(/\/$/, '');
    const tituloLimpioPreview = limpiarRuidoTitulo(item.title || '');
    const artistaLimpioPreview = limpiarRuidoTitulo(item.artist || '');
    const queryCompleta = `${tituloLimpioPreview} ${artistaLimpioPreview}`.trim() || item.title;
    const proxyDirectoBackend = `${baseBackend}/api/proxy-stream?videoId=${encodeURIComponent(item.videoId || '')}&q=${encodeURIComponent(queryCompleta)}&seconds=${item.seconds || 0}&tipo=preview`;
    const streamDirectoBackend = `${baseBackend}/api/stream?id=${encodeURIComponent(item.videoId || '')}&titulo=${encodeURIComponent(item.title)}&artist=${encodeURIComponent(item.artist || '')}&seconds=${item.seconds || 0}`;

    // Desbloqueo síncrono del elemento <audio> dentro del gesto de usuario (evita bloqueo de autoplay tras await fetch en Android WebView)
    try {
      audioEl.muted = false;
      audioEl.volume = silenciado ? 0 : volumen;
    } catch (_) {}

    const intentarReproducirUrl = async (urlCandidata: string): Promise<boolean> => {
      if (!urlCandidata) return false;
      try {
        audioEl.pause();
        audioEl.src = urlCandidata;
        audioEl.load();
        await audioEl.play();
        return true;
      } catch (e) {
        console.warn('[Preview]: Falló intento con URL:', urlCandidata, e);
        return false;
      }
    };

    try {
      // 1. Si el resultado ya trae previewUrl válido de iTunes, reproducirlo de inmediato como vista previa rápida
      if (item.previewUrl && await intentarReproducirUrl(item.previewUrl)) {
        setPreviewActivo((prev) => (prev ? { ...prev, cargando: false, reproduciendo: true } : null));
        return;
      }

      // 2. Búsqueda ultrarrápida en iTunes Search API (con título limpio y fallback solo título)
      const consultasItunes = [queryCompleta];
      if (tituloLimpioPreview && tituloLimpioPreview !== queryCompleta) {
        consultasItunes.push(tituloLimpioPreview);
      }

      for (const qItunes of consultasItunes) {
        if (!qItunes) continue;
        try {
          const cItunes = new AbortController();
          const tItunes = setTimeout(() => cItunes.abort(), 3000);
          const respItunes = await fetch(
            `https://itunes.apple.com/search?term=${encodeURIComponent(qItunes)}&media=music&entity=song&limit=3`,
            { signal: cItunes.signal }
          );
          clearTimeout(tItunes);
          if (respItunes.ok) {
            const dataItunes = await respItunes.json();
            const candidato = (dataItunes?.results || []).find((r: any) => r?.previewUrl);
            if (candidato?.previewUrl && await intentarReproducirUrl(candidato.previewUrl)) {
              setPreviewActivo((prev) => (prev ? { ...prev, cargando: false, reproduciendo: true } : null));
              return;
            }
          }
        } catch (_) {}
      }

      // 3. Si NO tiene previewUrl en iTunes, conectar automáticamente en streaming directo a través del backend
      let urlBackendResuelta = '';
      try {
        const urlObtenerEnlace = `${baseBackend}/api/obtener-enlace?videoId=${encodeURIComponent(item.videoId || '')}&q=${encodeURIComponent(item.title)}&artist=${encodeURIComponent(item.artist || '')}&seconds=${item.seconds || 0}&formato=mp3`;
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 18000);
        const resp = await fetch(urlObtenerEnlace, { signal: c.signal });
        clearTimeout(t);
        if (resp.ok) {
          const data = await resp.json();
          if (data && data.downloadUrl) {
            const rawUrl = data.downloadUrl.startsWith('http')
              ? data.downloadUrl
              : `${baseBackend}${data.downloadUrl.startsWith('/') ? '' : '/'}${data.downloadUrl}`;
            urlBackendResuelta = rawUrl.includes('/api/proxy-stream')
              ? rawUrl
              : `${baseBackend}/api/proxy-stream?url=${encodeURIComponent(rawUrl)}&tipo=preview`;
          }
        }
      } catch (_) {}

      if (urlBackendResuelta && await intentarReproducirUrl(urlBackendResuelta)) {
        setPreviewActivo((prev) => (prev ? { ...prev, cargando: false, reproduciendo: true } : null));
        return;
      }

      // 4. Streaming directo por endpoint /api/proxy-stream o /api/stream del backend
      if (await intentarReproducirUrl(proxyDirectoBackend)) {
        setPreviewActivo((prev) => (prev ? { ...prev, cargando: false, reproduciendo: true } : null));
        return;
      }

      if (await intentarReproducirUrl(streamDirectoBackend)) {
        setPreviewActivo((prev) => (prev ? { ...prev, cargando: false, reproduciendo: true } : null));
        return;
      }

      detenerPreview();
    } catch (err: any) {
      console.warn('Aviso al iniciar streaming de vista previa:', err);
      detenerPreview();
    }
  }, [previewActivo, reproduciendo, backendUrlConfig, silenciado, volumen, detenerPreview]);

  useEffect(() => {
    const el = audioPreviewRef.current;
    if (!el) return;

    const onTime = () => {
      setPreviewActivo((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          cargando: false,
          tiempo: el.currentTime,
          duracion: el.duration && isFinite(el.duration) ? el.duration : prev.duracion
        };
      });
    };

    const onEnd = () => {
      setPreviewActivo((prev) => (prev ? { ...prev, reproduciendo: false, tiempo: 0 } : null));
    };

    const onError = () => {
      // No cortar si aún está resolviendo alternativas en alternarPreview
      if (previewActivo && !previewActivo.cargando) {
        detenerPreview();
      }
    };

    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnd);
    el.addEventListener('error', onError);

    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('error', onError);
    };
  }, [detenerPreview, previewActivo?.videoId, previewActivo?.cargando]);

  // Búsqueda pública multi-proveedor de alta resiliencia (Invidious + Apple iTunes)
  const buscarCancionesPublico = async (consulta: string): Promise<ResultadoBusqueda[]> => {
    // 1. Probar Invidious (Instancias con CORS abierto)
    const invidiousHosts = [
      'https://inv.nadeko.net',
      'https://invidious.nerdvpn.de',
      'https://yewtu.be',
      'https://invidious.jing.rocks'
    ];

    for (const host of invidiousHosts) {
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 4000);
        const data = await fetchJsonSeguro<any[]>(`${host}/api/v1/search?q=${encodeURIComponent(consulta)}&type=video`, {
          signal: c.signal,
          headers: { 'Accept': 'application/json' }
        });
        clearTimeout(t);
        if (Array.isArray(data) && data.length > 0) {
          return data.slice(0, 25).map((item: any) => ({
            videoId: item.videoId || '',
            title: item.title || '',
            artist: item.author || '',
            timestamp: `${Math.floor((item.lengthSeconds || 0) / 60)}:${(item.lengthSeconds || 0) % 60 < 10 ? '0' : ''}${(item.lengthSeconds || 0) % 60}`,
            seconds: item.lengthSeconds || 0,
            thumbnail: (item.videoThumbnails && item.videoThumbnails[0]) ? item.videoThumbnails[0].url : ''
          }));
        }
      } catch (_) {}
    }

    // 2. Probar Apple iTunes Search API (Ultra fiable, sin bloqueos de IP ni límites)
    try {
      const c = new AbortController();
      const t = setTimeout(() => c.abort(), 4500);
      const data = await fetchJsonSeguro<{ results?: any[] }>(`https://itunes.apple.com/search?term=${encodeURIComponent(consulta)}&media=music&entity=song&limit=25`, {
        signal: c.signal
      });
      clearTimeout(t);
      if (data && Array.isArray(data.results) && data.results.length > 0) {
        return data.results.map((item: any) => {
          const seg = Math.round((item.trackTimeMillis || 0) / 1000);
          const min = Math.floor(seg / 60);
          const rem = seg % 60;
          return {
            videoId: `itunes_${item.trackId}`,
            title: item.trackName || '',
            artist: item.artistName || '',
            timestamp: `${min}:${rem < 10 ? '0' : ''}${rem}`,
            seconds: seg,
            thumbnail: (item.artworkUrl100 || '').replace('100x100bb', '600x600bb'),
            previewUrl: item.previewUrl || ''
          };
        });
      }
    } catch (_) {}

    return [];
  };

  // Búsqueda interactiva de canciones por nombre o grupo
  const buscarCancionesOnline = async (terminoParam?: string) => {
    const consulta = (terminoParam !== undefined ? terminoParam : busquedaWeb).trim();
    if (!consulta) return;

    if (terminoParam !== undefined) {
      setBusquedaWeb(terminoParam);
    }

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      mostrarToast('Estás en Modo Offline. Conéctate a internet para buscar música en línea.', 'info');
      return;
    }

    setBuscandoCanciones(true);
    setTerminoBuscado(consulta);
    setSeleccionadosDescarga([]);

    try {
      let items: ResultadoBusqueda[] = [];
      const urlApi = obtenerUrlApi(`/api/buscar-canciones?q=${encodeURIComponent(consulta)}`);

      // 1. Si existe endpoint válido (web o backend remoto configurado con IP/ngrok)
      if (urlApi) {
        try {
          const c = new AbortController();
          const timer = setTimeout(() => c.abort(), 6000);
          const data = await fetchJsonSeguro<{ resultados?: ResultadoBusqueda[] }>(urlApi, {
            signal: c.signal
          });
          clearTimeout(timer);

          if (data && Array.isArray(data.resultados) && data.resultados.length > 0) {
            items = data.resultados;
          }
        } catch (errLocal) {
          console.warn('Backend local no disponible o devolvió respuesta no válida, ejecutando búsqueda pública...', errLocal);
        }
      }

      // 2. Si no hay backend configurado en Android o el backend falló, activar de inmediato búsqueda pública
      if (items.length === 0) {
        items = await buscarCancionesPublico(consulta);
      }

      setResultadosBusqueda(items);

      if (items.length === 0) {
        mostrarToast(`No se encontraron canciones para "${consulta}"`, 'info');
      } else {
        mostrarToast(`Encontradas ${items.length} opciones para "${consulta}"`, 'exito');
      }
    } catch (err: any) {
      console.error('Error buscando canciones:', err);
      mostrarToast(`Error al buscar: ${err.message || err}`, 'error');
    } finally {
      setBuscandoCanciones(false);
    }
  };

  // Descarga de una canción específica elegida por el usuario con formato y calidad seleccionable
  const descargarCancionItem = async (
    item: ResultadoBusqueda,
    formatoElegido: string = 'mp3',
    forzar: boolean = false
  ) => {
    if (descargando) return;

    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      mostrarToast('Modo Offline: conéctate a internet para descargar música', 'info');
      return;
    }

    // Normalizar texto para comparaciones robustas
    const normalizar = (txt: string) =>
      (txt || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const tituloItem = normalizar(item.title);
    const artistaItem = normalizar(item.artist || '');

    const limpiarCancion = (txt: string, art: string) => {
      let t = normalizar(txt);
      if (art) {
        t = t.replace(normalizar(art), '');
      }
      return t
        .replace(/\b(video|oficial|official|audio|remix|hd|4k|lyric|lyrics|completa|en vivo|live|letra)\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const coreItem = limpiarCancion(item.title, item.artist);

    // Verificar si ya existe en biblioteca exactamente la misma canción del mismo grupo (sólo para audio)
    const esVideo = ['144', '240', '360', '720', '1080'].includes(formatoElegido);
    if (!esVideo && !forzar && coreItem.length >= 4) {
      const cancionExistente = biblioteca.find((c) => {
        const tituloExist = normalizar(c.nombre);
        if (tituloExist === tituloItem) return true;

        const coreExist = limpiarCancion(c.nombre, c.artista || '');
        if (coreExist.length < 4) return false;

        const coincidenNombres =
          coreItem === coreExist ||
          (coreItem.length > 8 && (coreItem.includes(coreExist) || coreExist.includes(coreItem)));
        if (!coincidenNombres) return false;

        const artistaExist = normalizar(c.artista || '');
        if (artistaItem && artistaExist) {
          return artistaExist.includes(artistaItem) || artistaItem.includes(artistaExist);
        }
        return true;
      });

      if (cancionExistente) {
        pedirConfirmacion({
          titulo: '¡Canción ya descargada! ⚠️',
          mensaje: `Ya tienes "${cancionExistente.nombre}" ${cancionExistente.artista ? `de ${cancionExistente.artista} ` : ''}en tu biblioteca. ¿Deseas volver a descargarla de todos modos?`,
          textoConfirmar: 'Descargar de nuevo',
          peligroso: false,
          onConfirmar: () => {
            descargarCancionItem(item, formatoElegido, true);
          }
        });
        return;
      }
    }

    setDescargando(true);
    setDescargandoId(item.videoId);
    setPasoDescarga(1);
    setTextoDescarga('Conectando con el proveedor de audio...');
    setInfoPistaDescarga({
      title: item.title,
      artist: item.artist,
      thumbnail: item.thumbnail,
      formato: formatoElegido
    });
    setMostrarBotonCancelarDescarga(false);

    const controller = new AbortController();
    cancelDescargaRef.current = () => controller.abort();

    // Timeout global amplio de 75 segundos (para permitir 60s de timeout HTTP + procesamiento)
    const timeoutId = setTimeout(() => {
      controller.abort(new Error('Tiempo de espera global agotado (>60s)'));
    }, 75000);

    // Si la petición excede 20 segundos, activar botón visible de "Cancelar"
    const cancelTimerId = setTimeout(() => {
      setMostrarBotonCancelarDescarga(true);
    }, 20000);

    try {
      let resAudio: Response | null = null;
      let dataEnlace: { downloadUrl?: string; mensaje?: string; error?: string } | null = null;

      // Resolver ID real de YouTube si la canción proviene de búsqueda Apple iTunes u otro proveedor sin ID directo
      let resolvedVideoId = item.videoId;
      const esFuenteLicenciada = resolvedVideoId?.startsWith('jamendo:') || resolvedVideoId?.startsWith('ia:');
      if (!esFuenteLicenciada && (!resolvedVideoId || resolvedVideoId.startsWith('itunes_') || resolvedVideoId.length !== 11)) {
        try {
          setTextoDescarga('Localizando pista completa en YouTube...');
          const consultaYt = `${item.title} ${item.artist || ''}`.trim();
          const urlBusqueda = obtenerUrlApi(`/api/buscar-canciones?q=${encodeURIComponent(consultaYt)}`);
          if (urlBusqueda) {
            const bData = await fetchJsonSeguro<{ resultados?: any[] }>(urlBusqueda, { signal: controller.signal }, 10000);
            const matchYt = bData?.resultados?.find((r) => r?.videoId && r.videoId.length === 11 && !r.videoId.startsWith('itunes_'));
            if (matchYt) {
              resolvedVideoId = matchYt.videoId;
            }
          }
          if (!resolvedVideoId || resolvedVideoId.startsWith('itunes_') || resolvedVideoId.length !== 11) {
            const pubRes = await buscarCancionesPublico(consultaYt);
            const matchPub = pubRes.find((r) => r?.videoId && r.videoId.length === 11 && !r.videoId.startsWith('itunes_'));
            if (matchPub) {
              resolvedVideoId = matchPub.videoId;
            }
          }
        } catch (_) {}
      }

      // -----------------------------------------------------------------------
      // INTENTO 1: Resolver enlace mediante /api/obtener-enlace (timeout 60s)
      // -----------------------------------------------------------------------
      const rutaEnlace = `/api/obtener-enlace?q=${encodeURIComponent(item.title)}&videoId=${encodeURIComponent(resolvedVideoId || item.videoId)}&seconds=${item.seconds}&artist=${encodeURIComponent(item.artist)}&formato=${encodeURIComponent(formatoElegido)}`;
      const urlEnlace = obtenerUrlApi(rutaEnlace);

      if (urlEnlace) {
        try {
          setTextoDescarga('Obteniendo enlace directo del proveedor...');
          dataEnlace = await fetchJsonSeguro<{ downloadUrl?: string }>(urlEnlace, {
            signal: controller.signal
          }, 60000);
        } catch (errEnlace: any) {
          if (controller.signal.aborted) throw errEnlace;
          console.warn('[Descarga]: Intento 1 /api/obtener-enlace falló:', errEnlace.message || errEnlace);
        }
      }

      // Si obtuvimos downloadUrl, avanzar al Paso 2 y descargar stream
      if (dataEnlace && dataEnlace.downloadUrl) {
        setPasoDescarga(2);
        setTextoDescarga(esVideo ? 'Procesando Video MP4...' : 'Descargando y convirtiendo MP3...');

        // 1.A. Resolver URL final sin duplicar /api/proxy-stream si el servidor ya devolvió una ruta de proxy
        const rawDownloadUrl = dataEnlace.downloadUrl.trim();
        const urlProxy = rawDownloadUrl.includes('/api/proxy-stream')
          ? (rawDownloadUrl.startsWith('http') ? rawDownloadUrl : obtenerUrlApi(rawDownloadUrl))
          : obtenerUrlApi(`/api/proxy-stream?url=${encodeURIComponent(rawDownloadUrl)}`);

        if (urlProxy) {
          try {
            resAudio = await fetchConTimeout(urlProxy, { signal: controller.signal }, 60000);
          } catch (errProxy: any) {
            if (controller.signal.aborted) throw errProxy;
            console.warn('[Descarga]: proxy-stream no respondió, intentando origen directo...');
          }
        }

        // 1.B. Fallback: Conectar directamente con el origen si proxy-stream falló y rawDownloadUrl es una URL externa directa
        if (
          (!resAudio || !resAudio.ok || (resAudio.headers.get('content-type') || '').toLowerCase().includes('text/html')) &&
          rawDownloadUrl.startsWith('http') &&
          !rawDownloadUrl.includes('/api/proxy-stream')
        ) {
          try {
            setTextoDescarga('Descargando pista desde origen directo...');
            resAudio = await fetchConTimeout(rawDownloadUrl, { signal: controller.signal }, 60000);
          } catch (errDirect: any) {
            if (controller.signal.aborted) throw errDirect;
            console.warn('[Descarga]: Conexión directa con origen falló:', errDirect);
          }
        }
      }

      // -----------------------------------------------------------------------
      // INTENTO 2 (Reintento Automático): Si el intento 1 falló, probar /api/descargar-cancion
      // -----------------------------------------------------------------------
      const esAudioValido = Boolean(
        resAudio &&
        resAudio.ok &&
        !((resAudio.headers.get('content-type') || '').toLowerCase().includes('text/html'))
      );

      if (!esAudioValido) {
        console.warn('[Descarga]: Aplicando REINTENTO AUTOMÁTICO vía /api/descargar-cancion...');
        setTextoDescarga('Reintentando con canal directo del servidor...');

        const rutaDescarga = `/api/descargar-cancion?q=${encodeURIComponent(item.title)}&videoId=${encodeURIComponent(resolvedVideoId || item.videoId)}&seconds=${item.seconds}&artist=${encodeURIComponent(item.artist)}&formato=${encodeURIComponent(formatoElegido)}`;
        const urlDescarga = obtenerUrlApi(rutaDescarga);

        if (urlDescarga) {
          try {
            resAudio = await fetchConTimeout(urlDescarga, { signal: controller.signal }, 60000);
            if (resAudio && resAudio.ok && !((resAudio.headers.get('content-type') || '').toLowerCase().includes('text/html'))) {
              setPasoDescarga(2);
              setTextoDescarga(esVideo ? 'Procesando Video MP4...' : 'Procesando MP3...');
            }
          } catch (errDescarga: any) {
            if (controller.signal.aborted) throw errDescarga;
            console.warn('[Descarga]: Reintento directo /api/descargar-cancion falló:', errDescarga);
          }
        }
      }

      // -----------------------------------------------------------------------
      // INTENTO 2.B (Fallback Universal): Forzar pipeline vía /api/proxy-stream
      // -----------------------------------------------------------------------
      const audioValidoTrasIntento2B = Boolean(
        resAudio &&
        resAudio.ok &&
        !((resAudio.headers.get('content-type') || '').toLowerCase().includes('text/html'))
      );

      if (!audioValidoTrasIntento2B) {
        console.warn('[Descarga]: Forzando pipeline a través de /api/proxy-stream con reintentos...');
        setTextoDescarga('Extrayendo pista completa con resolvedor universal...');
        const proxyUniversal = obtenerUrlApi(
          `/api/proxy-stream?videoId=${encodeURIComponent(resolvedVideoId || '')}&q=${encodeURIComponent(`${item.title} ${item.artist || ''}`.trim())}&artist=${encodeURIComponent(item.artist || '')}&seconds=${item.seconds || 0}&formato=${encodeURIComponent(formatoElegido)}`
        );
        if (proxyUniversal) {
          try {
            resAudio = await fetchConTimeout(proxyUniversal, { signal: controller.signal }, 60000);
            if (resAudio && resAudio.ok && !((resAudio.headers.get('content-type') || '').toLowerCase().includes('text/html'))) {
              setPasoDescarga(2);
              setTextoDescarga(esVideo ? 'Procesando Video MP4...' : 'Procesando MP3...');
            }
          } catch (errUniv: any) {
            if (controller.signal.aborted) throw errUniv;
            console.warn('[Descarga]: Fallback proxy-stream universal falló:', errUniv);
          }
        }
      }

      if (!resAudio || !resAudio.ok) {
        let mensajeServidor = dataEnlace?.mensaje || '';
        if (!mensajeServidor && resAudio) {
          try {
            const errJson = await resAudio.clone().json().catch(() => null);
            mensajeServidor = errJson?.mensaje || errJson?.error || '';
          } catch (_) {}
        }
        throw new Error(
          mensajeServidor ||
          'No se pudo extraer la pista completa. El servidor o los proveedores externos están ocupados temporalmente. Por favor, intenta de nuevo.'
        );
      }

      const audioBlob = await resAudio.blob();
      const tamanoMinimo = esVideo ? 1000000 : 650000;
      if (audioBlob.size < tamanoMinimo) {
        throw new Error(`Archivo incompleto o truncado (${(audioBlob.size / 1024).toFixed(0)} KB). Se rechazó para proteger tu biblioteca.`);
      }

      setPasoDescarga(3);
      setTextoDescarga('Guardando en almacenamiento local...');

      const tipoMime = audioBlob.type || (esVideo ? 'video/mp4' : 'audio/mpeg');
      const blobAdecuado = new Blob([audioBlob], { type: tipoMime });

      if (esVideo) {
        // Para videos, disparar descarga directa de archivo .mp4 al dispositivo
        const urlBlob = URL.createObjectURL(blobAdecuado);
        const a = document.createElement('a');
        a.href = urlBlob;
        a.download = `${item.title.replace(/[/\\?%*:|"<>]/g, '_')}.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(urlBlob), 5000);
        mostrarToast(`✓ Video descargado con éxito: "${item.title}.mp4"`, 'exito');
      } else {
        // Para música, abrir pre-escucha de 15 s antes de guardar en IndexedDB y /Music/AppMusica/
        const duracionReal = (await obtenerDuracionDeBlob(blobAdecuado)) || item.seconds || 0;
        if (duracionReal > 0 && duracionReal < 45) {
          throw new Error(`Pista truncada de vista previa detectada (${Math.round(duracionReal)}s). Solo se permiten canciones completas.`);
        }

        const claveReemplazo = cancionAReemplazarClave;
        const originalExistente = claveReemplazo
          ? bibliotecaRef.current.find((c) => c.nombre === claveReemplazo)
          : undefined;

        setPreescuchaPendiente({
          titulo: item.title,
          artista: item.artist,
          caratula: item.thumbnail,
          blob: blobAdecuado,
          duracionReal,
          duracionEsperada:
            originalExistente?.durationExpected && originalExistente.durationExpected > 0
              ? originalExistente.durationExpected
              : item.seconds > 0
              ? item.seconds
              : undefined,
          modoReemplazo: Boolean(claveReemplazo),
          reemplazarClaveOriginal: claveReemplazo || undefined,
          sourceVersion: claveReemplazo ? 'reemplazo_manual' : 'descarga_web'
        });
        mostrarToast('🎧 Escucha la vista previa de 15 s y confirma para guardar', 'info');
      }
    } catch (error: any) {
      if (error.name === 'AbortError' || error.message?.includes('cancelada') || controller.signal.aborted) {
        if (error.message?.includes('Tiempo de espera') || error.message?.includes('Timeout') || error.message?.includes('>60s')) {
          mostrarToast('Tiempo de espera agotado (>60s). Intenta con otra canción.', 'error');
        } else {
          mostrarToast('Descarga cancelada por el usuario', 'info');
        }
      } else {
        console.error('Error al descargar:', error);
        mostrarToast(`Error: ${error.message || 'No se pudo descargar la pista'}`, 'error');
      }
    } finally {
      clearTimeout(timeoutId);
      clearTimeout(cancelTimerId);
      cancelDescargaRef.current = null;
      setMostrarBotonCancelarDescarga(false);
      setDescargando(false);
      setDescargandoId(null);
      setPasoDescarga(1);
      setInfoPistaDescarga(null);
      setTextoDescarga('');
    }
  };

  // Descargar canciones seleccionadas en lote
  const descargarSeleccionadas = async () => {
    if (descargando || seleccionadosDescarga.length === 0) return;
    const items = resultadosBusqueda.filter((r) => seleccionadosDescarga.includes(r.videoId));
    for (const item of items) {
      await descargarCancionItem(item);
    }
    setSeleccionadosDescarga([]);
  };

  const alternarSeleccionDescarga = (videoId: string) => {
    setSeleccionadosDescarga((prev) =>
      prev.includes(videoId) ? prev.filter((id) => id !== videoId) : [...prev, videoId]
    );
  };

  // =========================================================================
  // IMPORTADOR DE PLAYLISTS DE SPOTIFY POR ENLACE (SIN API KEYS + COLA SECUENCIAL)
  // =========================================================================
  // Predicado único (compartido por el detector de duplicados y la purga real de reimportación)
  const coincidePistaSpotifyConCancion = (
    pista: { title: string; artist: string },
    c: { nombre: string; artista?: string; tituloLower?: string; artistaLower?: string }
  ): boolean => {
    const normTitle = normalizarParaBusqueda(pista.title);
    const normArtist = normalizarParaBusqueda(pista.artist);
    if (!normTitle || !c || !c.nombre) return false;
    const cTitle = c.tituloLower || normalizarParaBusqueda(c.nombre);
    const cArtist = c.artistaLower || normalizarParaBusqueda(c.artista);
    if (c.nombre.toLowerCase() === `${pista.title} - ${pista.artist}`.toLowerCase()) return true;
    if (cTitle === normTitle) return true;
    if (normTitle.length >= 4 && cTitle.includes(normTitle)) {
      if (!normArtist || !cArtist) return true;
      return cArtist.includes(normArtist) || normArtist.includes(cArtist) || cTitle.includes(normArtist);
    }
    return false;
  };

  const esPistaSpotifyYaEnBiblioteca = useCallback((pista: { title: string; artist: string }): boolean => {
    if (!normalizarParaBusqueda(pista.title)) return false;
    return bibliotecaRef.current.some((c) => coincidePistaSpotifyConCancion(pista, c));
  }, []);

  const analizarEnlacePlaylistSpotify = async () => {
    const enlace = urlSpotifyInput.trim();
    if (!enlace) {
      mostrarToast('Pega el enlace de una playlist de Spotify', 'info');
      return;
    }
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      mostrarToast('Conéctate a internet para importar playlists de Spotify', 'info');
      return;
    }

    setAnalizandoSpotify(true);
    setPlaylistSpotifyInfo(null);
    setSeleccionadasSpotify([]);
    setFallidasSpotifyIds([]);
    setProgresoColaSpotify(null);

    try {
      const endpoint = obtenerUrlApi('/api/spotify/playlist') || `${BACKEND_URL_DEFAULT}/api/spotify/playlist`;
      const resp = await fetchConTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: enlace })
        },
        20000
      );

      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data || data.error || !Array.isArray(data.canciones)) {
        throw new Error(data?.mensaje || 'No se pudo leer la playlist de Spotify. Asegúrate de que sea pública.');
      }

      const cancionesRecibidas: PistaSpotifyImport[] = data.canciones;
      setPlaylistSpotifyInfo({
        playlistId: data.playlistId || '',
        nombre: data.nombre || 'Playlist de Spotify',
        caratula: data.caratula || '',
        canciones: cancionesRecibidas
      });

      // Pre-seleccionar automáticamente solo las que NO estén ya descargadas en la biblioteca
      const noDuplicadas = cancionesRecibidas
        .filter((p) => !esPistaSpotifyYaEnBiblioteca(p))
        .map((p) => p.id);
      setSeleccionadasSpotify(noDuplicadas);

      mostrarToast(`✓ Playlist "${data.nombre}": ${cancionesRecibidas.length} canciones encontradas`, 'exito');
    } catch (err: any) {
      console.error('[Spotify Import]: Error analizando playlist:', err);
      mostrarToast(err?.message || 'Error al analizar el enlace de Spotify', 'error');
    } finally {
      setAnalizandoSpotify(false);
    }
  };

  const limpiarTituloParaRescateFrontend = (tituloRaw: string): string => {
    return (tituloRaw || '')
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\b(feat\.?|ft\.?|featuring|con|with)\s+[^-–—|]+$/i, ' ')
      .replace(/\s*[-–—|]\s*(remastered|version|edit|mix|mono|stereo|deluxe|bonus).*$/i, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const descargarColaSecuencialSpotify = async (
    idsForzados?: string[],
    opcionesCola?: { forzarReemplazo?: boolean; playlistsBase?: Playlist[] }
  ) => {
    if (!playlistSpotifyInfo || importandoColaSpotify) return;
    const forzarReemplazo = Boolean(opcionesCola?.forzarReemplazo);
    const playlistsBase = opcionesCola?.playlistsBase || playlists;
    const listaIdsActiva = idsForzados !== undefined ? idsForzados : seleccionadasSpotify;
    if (listaIdsActiva.length === 0) return;

    const colaAImportar = playlistSpotifyInfo.canciones.filter((c) => listaIdsActiva.includes(c.id));
    if (colaAImportar.length === 0) return;

    setImportandoColaSpotify(true);
    setFallidasSpotifyIds([]);
    cancelarColaSpotifyRef.current = false;

    let completadas = 0;
    let omitidas = 0;
    let fallidas = 0;
    const idsFallidosActuales: string[] = [];
    const nombresGuardadosEnPlaylist: string[] = [];

    const intentarDescargarPistaConConsulta = async (
      qBusqueda: string,
      artistaBusqueda: string,
      duracionSegs: number
    ): Promise<Blob | null> => {
      // estricto=1 -> el backend exige máster oficial (Deezer/iTunes) + canal Topic/VEVO/Artista + duración ±4s
      const paramsEstrictos = `&estricto=1&origen=spotify&fresco=true`;
      const rutaDirecta = `/api/descargar-cancion?q=${encodeURIComponent(qBusqueda)}&artist=${encodeURIComponent(artistaBusqueda)}&seconds=${duracionSegs || 0}&formato=mp3${paramsEstrictos}`;
      const urlDescarga = obtenerUrlApi(rutaDirecta) || `${BACKEND_URL_DEFAULT}${rutaDirecta}`;

      let resAudio: Response | null = null;
      try {
        resAudio = await fetchConTimeout(urlDescarga, {}, 55000);
      } catch (_) {}

      // 404 = "Audio oficial de estudio no disponible": no repetir la búsqueda (Cero Relleno)
      if (resAudio && resAudio.status === 404) return null;

      if (
        !resAudio ||
        !resAudio.ok ||
        (resAudio.headers.get('content-type') || '').toLowerCase().includes('text/html') ||
        (resAudio.headers.get('content-type') || '').toLowerCase().includes('application/json')
      ) {
        const rutaEnlace = `/api/obtener-enlace?q=${encodeURIComponent(qBusqueda)}&artist=${encodeURIComponent(artistaBusqueda)}&seconds=${duracionSegs || 0}&formato=mp3${paramsEstrictos}`;
        const urlEnlace = obtenerUrlApi(rutaEnlace) || `${BACKEND_URL_DEFAULT}${rutaEnlace}`;
        const dataEnlace = await fetchJsonSeguro<{ downloadUrl?: string }>(urlEnlace, {}, 45000).catch(() => null);
        if (dataEnlace && dataEnlace.downloadUrl) {
          const rawUrl = dataEnlace.downloadUrl.trim();
          const urlProxy = rawUrl.includes('/api/proxy-stream')
            ? (rawUrl.startsWith('http') ? rawUrl : (obtenerUrlApi(rawUrl) || `${BACKEND_URL_DEFAULT}${rawUrl}`))
            : (obtenerUrlApi(`/api/proxy-stream?url=${encodeURIComponent(rawUrl)}`) || `${BACKEND_URL_DEFAULT}/api/proxy-stream?url=${encodeURIComponent(rawUrl)}`);
          resAudio = await fetchConTimeout(urlProxy, {}, 55000).catch(() => null);
        }
      }

      if (!resAudio || !resAudio.ok) return null;
      const audioBlob = await resAudio.blob().catch(() => null);
      if (!audioBlob || audioBlob.size < 400000) return null;
      return audioBlob;
    };

    for (let i = 0; i < colaAImportar.length; i++) {
      if (cancelarColaSpotifyRef.current) {
        mostrarToast('Importación de Spotify detenida por el usuario', 'info');
        break;
      }

      const track = colaAImportar[i];
      setProgresoColaSpotify({
        actual: i + 1,
        total: colaAImportar.length,
        tituloActual: `${track.title} - ${track.artist}`,
        completadas,
        omitidas,
        fallidas
      });

      // Omitir duplicados si ya existe en IndexedDB / biblioteca (NUNCA en modo reimportación con purga real)
      if (!forzarReemplazo && esPistaSpotifyYaEnBiblioteca(track)) {
        omitidas++;
        const existente = bibliotecaRef.current.find((c) => coincidePistaSpotifyConCancion(track, c));
        if (existente) nombresGuardadosEnPlaylist.push(existente.nombre);
        continue;
      }

      try {
        // 1. Intento principal con título y artista exactos de Spotify (backend: máster Deezer/iTunes + Topic + ±4s)
        let audioBlob = await intentarDescargarPistaConConsulta(
          track.title,
          track.artist,
          track.seconds || 0
        );

        // 2. RESCATE AUTOMÁTICO: título sin paréntesis/featuring y artista principal (mismo filtro estricto)
        if (!audioBlob && !cancelarColaSpotifyRef.current) {
          const tituloLimpioRescate = limpiarTituloParaRescateFrontend(track.title) || track.title;
          const artistaPrincipalRescate = (track.artist || '').split(/,|&|\bfeat\.?\b|\bft\.?\b/i)[0].trim() || track.artist;
          const esDistinto =
            tituloLimpioRescate.toLowerCase() !== (track.title || '').toLowerCase() ||
            artistaPrincipalRescate.toLowerCase() !== (track.artist || '').toLowerCase();

          if (esDistinto) {
            setProgresoColaSpotify({
              actual: i + 1,
              total: colaAImportar.length,
              tituloActual: `🔄 Rescatando: ${tituloLimpioRescate} - ${artistaPrincipalRescate}`,
              completadas,
              omitidas,
              fallidas
            });

            audioBlob = await intentarDescargarPistaConConsulta(
              tituloLimpioRescate,
              artistaPrincipalRescate,
              track.seconds || 0
            );
          }
        }

        if (!audioBlob) {
          fallidas++;
          idsFallidosActuales.push(track.id);
          continue;
        }

        const blobAdecuado = new Blob([audioBlob], { type: audioBlob.type || 'audio/mpeg' });
        const duracionReal = (await obtenerDuracionDeBlob(blobAdecuado)) || track.seconds || 0;
        const nombreFinal = `${track.title} - ${track.artist}`.trim();

        const cancionNueva: Cancion = {
          nombre: nombreFinal,
          blob: blobAdecuado,
          tamano: blobAdecuado.size,
          duracion: duracionReal,
          favorito: false,
          fecha: Date.now(),
          caratula: track.thumbnail || playlistSpotifyInfo.caratula,
          artista: track.artist,
          exportada: false,
          descargada: true,
          origen: 'descarga',
          tituloLower: normalizarParaBusqueda(nombreFinal),
          artistaLower: normalizarParaBusqueda(track.artist)
        };

        await localforage.setItem(nombreFinal, cancionNueva);
        if (esAlmacenamientoNativoDisponible()) {
          blindarCancionEnMemoriaFisica(cancionNueva, blobAdecuado).catch(() => {});
        }

        const cancionLigera: Cancion = { ...cancionNueva, blob: undefined };
        setBiblioteca((prev) => {
          const sinDup = prev.filter((c) => c.nombre !== nombreFinal);
          const nuevaLista = [cancionLigera, ...sinDup];
          bibliotecaRef.current = nuevaLista;
          guardarCatalogoLigero(nuevaLista);
          return nuevaLista;
        });

        nombresGuardadosEnPlaylist.push(nombreFinal);
        completadas++;
      } catch (eTrack) {
        console.warn('[Spotify Import]: Falló descarga de pista:', track.title, eTrack);
        fallidas++;
        idsFallidosActuales.push(track.id);
      }

      await new Promise((r) => setTimeout(r, 250));
    }

    // Crear o actualizar automáticamente la Playlist local con las canciones importadas
    if (nombresGuardadosEnPlaylist.length > 0 && playlistSpotifyInfo.nombre) {
      const nombrePl = playlistSpotifyInfo.nombre;
      const existentePl = playlistsBase.find((p) => p.nombre.toLowerCase() === nombrePl.toLowerCase());
      if (existentePl) {
        const fusion = Array.from(new Set([...existentePl.canciones, ...nombresGuardadosEnPlaylist]));
        const actualizadas = playlistsBase.map((p) => (p.id === existentePl.id ? { ...p, canciones: fusion } : p));
        await guardarPlaylistsEnDB(actualizadas);
      } else {
        const nuevaPl: Playlist = {
          id: `sp_${Date.now()}`,
          nombre: nombrePl,
          canciones: nombresGuardadosEnPlaylist,
          fechaCreacion: Date.now()
        };
        await guardarPlaylistsEnDB([nuevaPl, ...playlistsBase]);
      }
    }

    setFallidasSpotifyIds(idsFallidosActuales);
    // Desmarcar automáticamente las que ya quedaron en biblioteca y dejar seleccionadas solo las fallidas si las hubo
    if (idsFallidosActuales.length > 0) {
      setSeleccionadasSpotify(idsFallidosActuales);
    } else {
      const pendientesRestantes = playlistSpotifyInfo.canciones
        .filter((p) => !esPistaSpotifyYaEnBiblioteca(p))
        .map((p) => p.id);
      setSeleccionadasSpotify(pendientesRestantes);
    }

    setImportandoColaSpotify(false);
    setProgresoColaSpotify({
      actual: colaAImportar.length,
      total: colaAImportar.length,
      tituloActual: '¡Importación finalizada!',
      completadas,
      omitidas,
      fallidas
    });

    mostrarToast(
      `🟢 Spotify Import: ${completadas} descargadas, ${omitidas} omitidas por duplicado${fallidas > 0 ? `, ${fallidas} fallidas` : ''}`,
      completadas > 0 ? 'exito' : 'info'
    );
  };

  const reintentarFallidasSpotify = () => {
    if (!playlistSpotifyInfo || importandoColaSpotify || fallidasSpotifyIds.length === 0) return;
    // Filtrar solo las fallidas que aún no estén en la biblioteca
    const idsAReintentar = playlistSpotifyInfo.canciones
      .filter((c) => fallidasSpotifyIds.includes(c.id) && !esPistaSpotifyYaEnBiblioteca(c))
      .map((c) => c.id);
    if (idsAReintentar.length === 0) {
      setFallidasSpotifyIds([]);
      mostrarToast('Todas las canciones ya están en tu biblioteca', 'exito');
      return;
    }
    setSeleccionadasSpotify(idsAReintentar);
    descargarColaSecuencialSpotify(idsAReintentar);
  };

  // Limpiar y reimportar playlist completa de Spotify:
  // Purga las canciones descargadas previamente con covers de esa playlist y las vuelve a bajar todas limpias con el filtro oficial
  const limpiarYReimportarPlaylistSpotify = () => {
    if (!playlistSpotifyInfo || importandoColaSpotify) return;
    pedirConfirmacion({
      titulo: '🧹 ¿Limpiar y reimportar playlist?',
      mensaje: `Se eliminarán las versiones actuales de las canciones de "${playlistSpotifyInfo.nombre}" y se volverán a descargar limpias con el filtro oficial de estudio (Topic / Disquera).`,
      textoConfirmar: 'Limpiar y Reimportar',
      peligroso: false,
      onConfirmar: async () => {
        try {
          const pistasSp = playlistSpotifyInfo.canciones;
          const nombresAPurgar = new Set<string>();
          const coincideConAlguna = (c: { nombre: string; artista?: string; tituloLower?: string; artistaLower?: string }) =>
            pistasSp.some((track) => coincidePistaSpotifyConCancion(track, c));

          // 1a. Estado React (biblioteca en memoria)
          for (const c of bibliotecaRef.current) {
            if (coincideConAlguna(c)) nombresAPurgar.add(c.nombre);
          }

          // 1b. Canciones que pertenecen a la playlist local con el mismo nombre
          const plExistente = playlists.find((p) => p.nombre.toLowerCase() === playlistSpotifyInfo.nombre.toLowerCase());
          if (plExistente) {
            for (const nom of plExistente.canciones) {
              if (coincideConAlguna({ nombre: nom })) nombresAPurgar.add(nom);
            }
          }

          // 1c. localStorage (catalogo_metadatos_ligero)
          let catalogoLs: Array<{ nombre: string; artista?: string }> = [];
          try {
            const rawLs = localStorage.getItem(CLAVE_CATALOGO_LIGERO);
            catalogoLs = rawLs ? JSON.parse(rawLs) : [];
            if (!Array.isArray(catalogoLs)) catalogoLs = [];
          } catch (_) {
            catalogoLs = [];
          }
          for (const c of catalogoLs) {
            if (c && c.nombre && coincideConAlguna(c)) nombresAPurgar.add(c.nombre);
          }

          // 1d. localforage (IndexedDB): claves huérfanas que no estén en el catálogo
          try {
            const claves = await localforage.keys();
            for (const k of claves) {
              if (/^(app_|lyrics_|probe_|cache_|temp_|stream_)/.test(k) || k === CLAVE_CATALOGO_LIGERO) continue;
              if (coincideConAlguna({ nombre: k })) nombresAPurgar.add(k);
            }
          } catch (_) {}

          // 2. Borrar los Blobs viejos (covers) de IndexedDB
          for (const nombreBorrar of nombresAPurgar) {
            await localforage.removeItem(nombreBorrar).catch(() => {});
            await localforage.removeItem(`lyrics_${nombreBorrar}`).catch(() => {});
          }

          // 3. Actualizar estado, catálogo ligero (escritura inmediata) y playlists
          const nuevaBib = bibliotecaRef.current.filter((c) => !nombresAPurgar.has(c.nombre));
          bibliotecaRef.current = nuevaBib;
          setBiblioteca(nuevaBib);
          guardarCatalogoLigero(nuevaBib);
          try {
            const catalogoFiltrado = catalogoLs.filter((c) => c && c.nombre && !nombresAPurgar.has(c.nombre));
            localStorage.setItem(CLAVE_CATALOGO_LIGERO, JSON.stringify(catalogoFiltrado));
          } catch (_) {}

          const playlistsLimpias = playlists.map((p) => ({
            ...p,
            canciones: p.canciones.filter((n) => !nombresAPurgar.has(n))
          }));
          await guardarPlaylistsEnDB(playlistsLimpias);

          // 4. Todas las filas del modal pasan a "no en biblioteca" y se seleccionan todas
          const todosIds = pistasSp.map((c) => c.id);
          setSeleccionadasSpotify(todosIds);
          setFallidasSpotifyIds([]);
          setProgresoColaSpotify(null);
          mostrarToast(`🧹 Purgadas ${nombresAPurgar.size} pistas previas. Descargando másters oficiales...`, 'info');

          // 5. Arrancar la cola en modo reemplazo forzado (Omitidas: 0 garantizado)
          setTimeout(() => {
            descargarColaSecuencialSpotify(todosIds, { forzarReemplazo: true, playlistsBase: playlistsLimpias });
          }, 150);
        } catch (err) {
          console.error('[Limpiar y Reimportar Spotify]: Error:', err);
          mostrarToast('Error al limpiar la playlist', 'error');
        }
      }
    });
  };

  // =========================================================================
  // MODAL "REEMPLAZAR CON AUDIO ORIGINAL" (BOTÓN 🔄 EN TU BIBLIOTECA)
  // Permite escuchar vista previa de 10s y sustituir el archivo real en IndexedDB
  // =========================================================================
  const detenerPreviewOriginalModal = useCallback(() => {
    if (previewOriginalTimerRef.current) {
      window.clearTimeout(previewOriginalTimerRef.current);
      previewOriginalTimerRef.current = null;
    }
    if (previewOriginalAudioRef.current) {
      try {
        previewOriginalAudioRef.current.pause();
        previewOriginalAudioRef.current.removeAttribute('src');
        previewOriginalAudioRef.current.load();
      } catch (_) {}
    }
    setReproduciendoPreviewOriginalId(null);
  }, []);

  const cerrarModalOriginal = useCallback(() => {
    detenerPreviewOriginalModal();
    setModalOriginalAbierto(false);
    setCancionParaOriginal(null);
    setCandidatosOriginales([]);
    setCargandoCandidatosOriginales(false);
    setDescargandoCandidatoOriginalId(null);
  }, [detenerPreviewOriginalModal]);

  const abrirSelectorOriginal = async (cancion: Cancion, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      mostrarToast('Conéctate a internet para buscar la versión original', 'info');
      return;
    }

    detenerPreviewOriginalModal();
    setCancionParaOriginal(cancion);
    setCandidatosOriginales([]);
    setModalOriginalAbierto(true);
    setCargandoCandidatosOriginales(true);

    const limpiarEtiquetasBasura = (txt: string) =>
      String(txt || '')
        .replace(/_\d{6,}/g, ' ')
        .replace(/\b\d{10,}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const parsed = parsearTituloYArtista(limpiarEtiquetasBasura(cancion.nombre), limpiarEtiquetasBasura(cancion.artista || ''));
    const tituloBusqueda = limpiarEtiquetasBasura(parsed.tituloLimpio || cancion.nombre);
    const artistaBusqueda = limpiarEtiquetasBasura(cancion.artista || parsed.artistaLimpio || '');
    const duracionRef = cancion.duracion && cancion.duracion >= 45 ? Math.round(cancion.duracion) : 0;

    try {
      const endpoint = obtenerUrlApi('/api/buscar-candidatos-oficiales') || `${BACKEND_URL_DEFAULT}/api/buscar-candidatos-oficiales`;
      const resp = await fetchConTimeout(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            titulo: tituloBusqueda,
            artista: artistaBusqueda,
            duracionSegundos: duracionRef
          })
        },
        25000
      );
      const data = await resp.json().catch(() => null);
      if (resp.ok && data && Array.isArray(data.candidatos)) {
        setCandidatosOriginales(data.candidatos);
      } else {
        mostrarToast(data?.mensaje || 'No se encontraron candidatos oficiales', 'info');
      }
    } catch (err: any) {
      console.warn('[Selector Original]: Error buscando candidatos:', err);
      mostrarToast('No se pudieron cargar los candidatos en este momento', 'error');
    } finally {
      setCargandoCandidatosOriginales(false);
    }
  };

  const escucharPreviewCandidatoOriginal = (cand: { videoId: string; titulo: string }) => {
    if (reproduciendoPreviewOriginalId === cand.videoId) {
      detenerPreviewOriginalModal();
      return;
    }

    detenerPreviewOriginalModal();

    // Pausar el reproductor principal si estaba sonando para escuchar con claridad
    const deckActivo = getActiveDeckEl();
    if (deckActivo && !deckActivo.paused) {
      deckActivo.pause();
      setReproduciendo(false);
    }

    if (!previewOriginalAudioRef.current) {
      previewOriginalAudioRef.current = new Audio();
    }
    const audio = previewOriginalAudioRef.current;
    const streamUrl =
      obtenerUrlApi(`/api/proxy-stream?videoId=${encodeURIComponent(cand.videoId)}&tipo=preview&q=${encodeURIComponent(cand.titulo)}`) ||
      `${BACKEND_URL_DEFAULT}/api/proxy-stream?videoId=${encodeURIComponent(cand.videoId)}&tipo=preview&q=${encodeURIComponent(cand.titulo)}`;

    setReproduciendoPreviewOriginalId(cand.videoId);
    audio.src = streamUrl;
    audio.volume = 0.9;
    audio.onended = () => detenerPreviewOriginalModal();
    audio.onerror = () => {
      detenerPreviewOriginalModal();
      mostrarToast('No se pudo reproducir la vista previa de este candidato', 'info');
    };
    audio.play().catch(() => {
      detenerPreviewOriginalModal();
      mostrarToast('Toca de nuevo para escuchar la vista previa', 'info');
    });

    // Vista previa automática de 10 segundos
    previewOriginalTimerRef.current = window.setTimeout(() => {
      detenerPreviewOriginalModal();
    }, 10500);
  };

  const usarCandidatoOriginal = async (cand: { videoId: string; titulo: string; canal: string; duracionSeg: number }) => {
    if (!cancionParaOriginal || descargandoCandidatoOriginalId) return;
    const cancion = cancionParaOriginal;
    detenerPreviewOriginalModal();
    setDescargandoCandidatoOriginalId(cand.videoId);
    setReemplazandoCancionNombre(cancion.nombre);

    const limpiarEtiquetasBasura = (txt: string) =>
      String(txt || '')
        .replace(/_\d{6,}/g, ' ')
        .replace(/\b\d{10,}\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    const parsed = parsearTituloYArtista(limpiarEtiquetasBasura(cancion.nombre), limpiarEtiquetasBasura(cancion.artista || ''));
    const tituloBusqueda = limpiarEtiquetasBasura(parsed.tituloLimpio || cand.titulo || cancion.nombre);
    const artistaBusqueda = limpiarEtiquetasBasura(cancion.artista || parsed.artistaLimpio || '');
    const duracionRef = cand.duracionSeg || (cancion.duracion && cancion.duracion >= 45 ? Math.round(cancion.duracion) : 0);

    try {
      const urlOficial = obtenerUrlApi('/api/resolver-oficial') || `${BACKEND_URL_DEFAULT}/api/resolver-oficial`;
      let resAudio = await fetchConTimeout(
        urlOficial,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            titulo: tituloBusqueda,
            artista: artistaBusqueda,
            duracionSegundos: duracionRef,
            videoId: cand.videoId,
            forzarOficial: true
          })
        },
        60000
      ).catch(() => null);

      if (
        !resAudio ||
        !resAudio.ok ||
        (resAudio.headers.get('content-type') || '').toLowerCase().includes('text/html') ||
        (resAudio.headers.get('content-type') || '').toLowerCase().includes('application/json')
      ) {
        const fallbackProxy =
          obtenerUrlApi(`/api/proxy-stream?videoId=${encodeURIComponent(cand.videoId)}&q=${encodeURIComponent(tituloBusqueda)}&formato=m4a`) ||
          `${BACKEND_URL_DEFAULT}/api/proxy-stream?videoId=${encodeURIComponent(cand.videoId)}&q=${encodeURIComponent(tituloBusqueda)}&formato=m4a`;
        resAudio = await fetchConTimeout(fallbackProxy, {}, 60000).catch(() => null);
      }

      if (!resAudio || !resAudio.ok) {
        throw new Error('No se pudo descargar el audio completo de este candidato');
      }

      const audioBlob = await resAudio.blob();
      if (!audioBlob || audioBlob.size <= 102400) {
        throw new Error('El archivo descargado es demasiado pequeño o inválido');
      }

      const blobAdecuado = new Blob([audioBlob], { type: audioBlob.type || 'audio/mpeg' });
      const nuevaDuracion = (await obtenerDuracionDeBlob(blobAdecuado)) || duracionRef || cancion.duracion || 0;
      const estabaSonandoEsta = cancionActualRef.current?.nombre === cancion.nombre;

      await localforage.removeItem(cancion.nombre);
      const cancionActualizada: Cancion = {
        ...cancion,
        blob: blobAdecuado,
        tamano: blobAdecuado.size,
        duracion: nuevaDuracion,
        artista: artistaBusqueda || cancion.artista,
        fecha: Date.now(),
        descargada: true,
        origen: 'descarga'
      };
      await localforage.setItem(cancion.nombre, cancionActualizada);

      if (esAlmacenamientoNativoDisponible()) {
        blindarCancionEnMemoriaFisica(cancionActualizada, blobAdecuado).catch(() => {});
      }

      const ligera: Cancion = { ...cancionActualizada, blob: undefined };
      setBiblioteca((prev) => {
        const nueva = prev.map((c) => (c.nombre === cancion.nombre ? ligera : c));
        bibliotecaRef.current = nueva;
        guardarCatalogoLigero(nueva);
        try {
          localStorage.setItem(
            CLAVE_CATALOGO_LIGERO,
            JSON.stringify(
              nueva.map((x) => ({
                nombre: x.nombre,
                tamano: x.tamano || 0,
                duracion: x.duracion || 0,
                favorito: !!x.favorito,
                fecha: x.fecha || Date.now(),
                caratula: x.caratula,
                artista: x.artista,
                exportada: !!x.exportada,
                descargada: x.descargada !== false,
                origen: x.origen || 'descarga'
              }))
            )
          );
        } catch (_) {}
        return nueva;
      });

      if (precargaMixRef.current && precargaMixRef.current.nombre === cancion.nombre) {
        precargaMixRef.current = null;
      }
      if (estabaSonandoEsta) {
        reproducirCancion(cancionActualizada);
      }

      mostrarToast(`✅ ¡Listo! ${tituloBusqueda} reemplazada con el audio original`, 'exito');
      cerrarModalOriginal();
    } catch (err: any) {
      console.warn('[Usar Candidato Original]:', err);
      mostrarToast(err?.message || 'Error al reemplazar la canción', 'error');
      setDescargandoCandidatoOriginalId(null);
    } finally {
      setReemplazandoCancionNombre(null);
    }
  };

  // Botón directo "🔄 Reemplazar con original" en cada canción de Tu Biblioteca:
  // Abre el selector con vista previa auditiva de 10s y reemplazo real en IndexedDB
  const reemplazarCancionConOriginal = async (cancion: Cancion, e?: React.MouseEvent) => {
    await abrirSelectorOriginal(cancion, e);
  };

  // Reparación masiva de Tu Biblioteca usando YouTube Music DDEX (POST /api/resolver-oficial):
  // Reemplaza archivos viejos en IndexedDB por pistas oficiales de estudio sin perder playlists ni favoritos
  const repararBibliotecaOficial = () => {
    if (reparandoBiblioteca || reemplazandoCancionNombre || descargando) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      mostrarToast('Conéctate a internet para reparar tu biblioteca con YouTube Music DDEX', 'info');
      return;
    }
    const objetivo = cancionesVisibles.length > 0 ? [...cancionesVisibles] : [...bibliotecaRef.current];
    if (objetivo.length === 0) return;

    pedirConfirmacion({
      titulo: '✨ ¿Reparar Biblioteca con YouTube Music DDEX?',
      mensaje: `Se analizarán ${objetivo.length} canciones y se reemplazarán en IndexedDB usando pistas oficiales de estudio (categoría SONG). Si una pista no se encuentra, se conservará tu archivo actual.`,
      textoConfirmar: 'Reparar Ahora',
      peligroso: false,
      onConfirmar: async () => {
        setReparandoBiblioteca(true);
        let reparadas = 0;
        let sinCambios = 0;
        const urlOficial = obtenerUrlApi('/api/resolver-oficial') || `${BACKEND_URL_DEFAULT}/api/resolver-oficial`;
        const limpiarEtiquetas = (txt: string) =>
          String(txt || '').replace(/_\d{6,}/g, ' ').replace(/\b\d{10,}\b/g, ' ').replace(/\s+/g, ' ').trim();

        try {
          for (let i = 0; i < objetivo.length; i++) {
            const c = objetivo[i];
            const parsed = parsearTituloYArtista(limpiarEtiquetas(c.nombre), limpiarEtiquetas(c.artista || ''));
            const tituloBusqueda = limpiarEtiquetas(parsed.tituloLimpio || c.nombre);
            const artistaBusqueda = limpiarEtiquetas(c.artista || parsed.artistaLimpio || '');
            const duracionRef = c.duracion && c.duracion >= 45 ? Math.round(c.duracion) : 0;

            setReemplazandoCancionNombre(c.nombre);
            mostrarToast(`✨ Reparando (${i + 1}/${objetivo.length}): ${tituloBusqueda}...`, 'info');

            const registroPrevio = await localforage.getItem(c.nombre).catch(() => null);
            await localforage.removeItem(c.nombre).catch(() => {});

            try {
              const res = await fetchConTimeout(
                urlOficial,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    titulo: tituloBusqueda,
                    artista: artistaBusqueda,
                    isrc: (c as any).isrc || '',
                    duracionSegundos: duracionRef,
                    forzarOficial: true
                  })
                },
                60000
              );

              if (!res || !res.ok) {
                if (registroPrevio) await localforage.setItem(c.nombre, registroPrevio).catch(() => {});
                sinCambios++;
                continue;
              }
              const ct = (res.headers.get('content-type') || '').toLowerCase();
              if (ct.includes('text/html') || ct.includes('application/json')) {
                if (registroPrevio) await localforage.setItem(c.nombre, registroPrevio).catch(() => {});
                sinCambios++;
                continue;
              }
              const audioBlob = await res.blob();
              if (!audioBlob || audioBlob.size <= 307200) {
                if (registroPrevio) await localforage.setItem(c.nombre, registroPrevio).catch(() => {});
                sinCambios++;
                continue;
              }

              const blobAdecuado = new Blob([audioBlob], { type: audioBlob.type || 'audio/mpeg' });
              const nuevaDuracion = (await obtenerDuracionDeBlob(blobAdecuado)) || c.duracion || 0;

              const actualizada: Cancion = {
                ...c,
                blob: blobAdecuado,
                tamano: blobAdecuado.size,
                duracion: nuevaDuracion,
                artista: artistaBusqueda || c.artista,
                fecha: Date.now(),
                descargada: true,
                origen: 'descarga',
                verified: true,
                sourceVersion: 'reemplazo_oficial',
                durationActual: nuevaDuracion,
                flagReason: undefined
              };
              await localforage.setItem(c.nombre, actualizada);

              const ligera: Cancion = { ...actualizada, blob: undefined };
              setBiblioteca((prev) => {
                const nueva = prev.map((x) => (x.nombre === c.nombre ? ligera : x));
                bibliotecaRef.current = nueva;
                guardarCatalogoLigero(nueva);
                return nueva;
              });
              if (cancionActualRef.current?.nombre === c.nombre && reproduciendoRef.current) {
                if (precargaMixRef.current && precargaMixRef.current.nombre === c.nombre) {
                  precargaMixRef.current = null;
                }
                reproducirCancion(actualizada);
              }
              reparadas++;
            } catch (_) {
              if (registroPrevio) await localforage.setItem(c.nombre, registroPrevio).catch(() => {});
              sinCambios++;
            }
          }

          mostrarToast(
            `✅ Reparación finalizada: ${reparadas} actualizadas con estudio DDEX${sinCambios > 0 ? `, ${sinCambios} sin cambios` : ''}`,
            reparadas > 0 ? 'exito' : 'info'
          );
        } finally {
          setReemplazandoCancionNombre(null);
          setReparandoBiblioteca(false);
        }
      }
    });
  };

  // Favoritos
  const alternarFavorito = async (nombre: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    const cancion = biblioteca.find((c) => c.nombre === nombre);
    if (!cancion) return;

    const nuevoEstado = !cancion.favorito;
    const actualizada = { ...cancion, favorito: nuevoEstado };
    
    try {
      const guardadoEnDb: any = await localforage.getItem(nombre);
      if (guardadoEnDb) {
        if (guardadoEnDb instanceof Blob) {
          await localforage.setItem(nombre, {
            blob: guardadoEnDb,
            favorito: nuevoEstado,
            tamano: guardadoEnDb.size,
            duracion: cancion.duracion || 0,
            fecha: cancion.fecha || Date.now(),
            caratula: cancion.caratula,
            artista: cancion.artista,
            exportada: !!cancion.exportada,
            descargada: true,
            origen: cancion.origen || 'descarga'
          });
        } else {
          await localforage.setItem(nombre, { ...guardadoEnDb, favorito: nuevoEstado });
        }
      }
    } catch (_) {}

    setBiblioteca((prev) => {
      const nueva = prev.map((c) => (c.nombre === nombre ? actualizada : c));
      guardarCatalogoLigero(nueva);
      return nueva;
    });

    if (cancionActual && cancionActual.nombre === nombre) {
      setCancionActual(actualizada);
    }

    mostrarToast(nuevoEstado ? 'Agregado a Favoritas' : 'Eliminado de Favoritas', 'info');
  };

  // Exportar a Descargas / Guardar archivo .mp3 real al teléfono o PC con recuperación de Blob e IndexedDB
  const exportarCancion = async (cancion: Cancion, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    let blobAudio: Blob | undefined = cancion.blob;
    try {
      const nombreLimpio = (cancion.nombre || 'audio').replace(/[\\/:*?"<>|]/g, '_').trim();

      // Recuperación segura del Blob si no está residente en memoria
      if (!blobAudio || blobAudio.size === 0) {
        blobAudio = (await obtenerBlobCancionBajoDemanda(cancion.nombre)) || undefined;
      }

      if (!blobAudio || blobAudio.size === 0) {
        throw new Error(`Archivo de audio no disponible o vacío para "${cancion.nombre}"`);
      }

      const blobAdecuado = blobAudio.type.startsWith('audio/')
        ? blobAudio
        : new Blob([blobAudio], { type: 'audio/mpeg' });

      // Descarga directa como archivo físico .mp3 en Descargas
      const url = URL.createObjectURL(blobAdecuado);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${nombreLimpio}.mp3`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (document.body.contains(a)) document.body.removeChild(a);
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
      }, 4000);

      // Marcar con exportada: true en IndexedDB preservando metadatos completos
      const actualizada: Cancion = { ...cancion, blob: blobAudio, exportada: true };
      await localforage.setItem(cancion.nombre, actualizada);
      setBiblioteca((prev) => {
        const nueva = prev.map((c) => (c.nombre === cancion.nombre ? actualizada : c));
        guardarCatalogoLigero(nueva);
        return nueva;
      });

      mostrarToast(`✓ "${nombreLimpio}.mp3" guardado en Descargas`, 'exito');
    } catch (err: any) {
      console.error('Error al exportar canción:', err);
      // Fallback a compartir si la descarga directa fue bloqueada por el navegador móvil
      if (typeof navigator !== 'undefined' && (navigator as any).share && blobAudio && blobAudio.size > 0) {
        try {
          const nombreLimpio = (cancion.nombre || 'audio').replace(/[\\/:*?"<>|]/g, '_').trim();
          const blobAdecuado = blobAudio.type.startsWith('audio/')
            ? blobAudio
            : new Blob([blobAudio], { type: 'audio/mpeg' });
          const archivo = new File([blobAdecuado], `${nombreLimpio}.mp3`, { type: 'audio/mpeg' });
          await (navigator as any).share({
            files: [archivo],
            title: cancion.nombre,
            text: `Audio MP3: ${cancion.nombre}`
          });
          const actualizada: Cancion = { ...cancion, blob: blobAudio, exportada: true };
          await localforage.setItem(cancion.nombre, actualizada);
          setBiblioteca((prev) => {
            const nueva = prev.map((c) => (c.nombre === cancion.nombre ? actualizada : c));
            guardarCatalogoLigero(nueva);
            return nueva;
          });
          return;
        } catch (_) {}
      }
      mostrarToast(`Error al exportar: ${err.message || err}`, 'error');
    }
  };

  // Referencias estables para optimización de renderizado en CancionFila (React.memo)
  const reproducirCancionRef = useRef(reproducirCancion);
  reproducirCancionRef.current = reproducirCancion;
  const alReproducirFila = useCallback((cancion: Cancion) => {
    reproducirCancionRef.current(cancion);
  }, []);

  const alternarFavoritoRef = useRef(alternarFavorito);
  alternarFavoritoRef.current = alternarFavorito;
  const alAlternarFavoritoFila = useCallback((nombre: string, e: React.MouseEvent) => {
    alternarFavoritoRef.current(nombre, e);
  }, []);

  const exportarCancionRef = useRef(exportarCancion);
  exportarCancionRef.current = exportarCancion;
  const alExportarFila = useCallback((cancion: Cancion, e: React.MouseEvent) => {
    exportarCancionRef.current(cancion, e);
  }, []);

  const agregarAColaRef = useRef(agregarACola);
  agregarAColaRef.current = agregarACola;
  const alAgregarAColaFila = useCallback((cancion: Cancion, e?: React.MouseEvent) => {
    agregarAColaRef.current(cancion, e);
  }, []);

  const reemplazarOriginalRef = useRef(reemplazarCancionConOriginal);
  reemplazarOriginalRef.current = reemplazarCancionConOriginal;
  const alReemplazarOriginalFila = useCallback((cancion: Cancion, e: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setCancionAReemplazarClave(cancion.nombre);
    const query = `${cancion.nombre} ${cancion.artista || ''}`.trim();
    setBusquedaWeb(query);
    setTabActiva('buscar');
    mostrarToast(`Elige una nueva versión para "${cancion.nombre}"`, 'info');
  }, []);

  const confirmarGuardarPreescucha = async (datos: DatosPreescucha) => {
    setGuardandoPreescucha(true);
    try {
      const esReemplazo = Boolean(datos.modoReemplazo && datos.reemplazarClaveOriginal);
      const claveObjetivo = esReemplazo ? datos.reemplazarClaveOriginal! : datos.titulo;
      const existenteDb: any = esReemplazo
        ? await localforage.getItem(claveObjetivo).catch(() => null)
        : null;
      const existenteLista = esReemplazo
        ? bibliotecaRef.current.find((c) => c.nombre === claveObjetivo)
        : undefined;

      const cancionFinal: Cancion = {
        nombre: claveObjetivo,
        blob: datos.blob,
        tamano: datos.blob.size,
        duracion: datos.duracionReal,
        favorito: existenteDb?.favorito ?? existenteLista?.favorito ?? false,
        fecha: Date.now(),
        caratula: datos.caratula || existenteDb?.caratula || existenteLista?.caratula,
        artista: datos.artista || existenteDb?.artista || existenteLista?.artista,
        album: existenteDb?.album || existenteLista?.album,
        exportada: existenteDb?.exportada ?? existenteLista?.exportada ?? false,
        descargada: true,
        origen: (existenteDb?.origen || existenteLista?.origen || 'descarga') as Cancion['origen'],
        verified: esReemplazo ? true : false,
        sourceVersion: datos.sourceVersion || (esReemplazo ? 'reemplazo_manual' : 'descarga_web'),
        durationExpected:
          datos.duracionEsperada && datos.duracionEsperada > 0
            ? datos.duracionEsperada
            : existenteDb?.durationExpected ?? existenteLista?.durationExpected,
        durationActual: datos.duracionReal,
        durationMatch:
          datos.duracionEsperada && datos.duracionEsperada > 0
            ? Math.abs(datos.duracionReal - datos.duracionEsperada) <= 5
            : existenteDb?.durationMatch,
        flagReason: esReemplazo ? undefined : detectarSospechaInicial(claveObjetivo, datos.artista)
      };

      await localforage.setItem(claveObjetivo, cancionFinal);

      if (esAlmacenamientoNativoDisponible()) {
        blindarCancionEnMemoriaFisica(cancionFinal, datos.blob).catch((err) =>
          console.warn('[Blindaje]: Aviso al blindar:', err)
        );
      }

      const { blob: _omitBlob, ...ligera } = cancionFinal;
      setBiblioteca((prev) => {
        const filtrada = prev.filter((c) => c.nombre !== claveObjetivo);
        const lista = esReemplazo
          ? prev.map((c) => (c.nombre === claveObjetivo ? ligera : c))
          : [ligera, ...filtrada];
        guardarCatalogoLigero(lista);
        return lista;
      });

      setPreescuchaPendiente(null);
      setCancionAReemplazarClave(null);
      mostrarToast(
        esReemplazo
          ? `✓ "${claveObjetivo}" reemplazada conservando favoritos y playlists`
          : `✓ Descarga guardada: "${claveObjetivo}"`,
        'exito'
      );
    } catch (err: any) {
      mostrarToast(`Error guardando canción: ${err?.message || 'desconocido'}`, 'error');
    } finally {
      setGuardandoPreescucha(false);
    }
  };



  // Handlers memoizados para componentes auxiliares y listas
  const alReproducirDeHistorial = useCallback((item: any) => {
    const encontrada = biblioteca.find(
      (c) => c.nombre.trim().toLowerCase() === item.nombre.trim().toLowerCase()
    );
    if (encontrada) reproducirCancionRef.current(encontrada);
  }, [biblioteca]);

  const alCerrarModalCola = useCallback(() => {
    setModalColaAbierto(false);
  }, []);

  const alSeleccionarTextoBusqueda = useCallback((texto: string) => {
    setBusquedaWeb(texto);
    setSugerenciasVisibles(false);
    buscarCancionesOnline(texto);
  }, []);

  const alSeleccionarPistaBusqueda = useCallback((pista: any) => {
    setBusquedaWeb(pista.title);
    setSugerenciasVisibles(false);
    buscarCancionesOnline(pista.title);
  }, []);

  const alCerrarSugerencias = useCallback(() => {
    setSugerenciasVisibles(false);
  }, []);

  // Exportar únicamente las pistas descargadas activas en la app sin duplicar archivos en el dispositivo
  const exportarTodasLasCancionesMp3 = async () => {
    if (procesandoRespaldo) return;

    let cancionesAExportar = biblioteca.filter((c) => {
      // 1. Omitir canciones que ya fueron exportadas físicamente al dispositivo
      if (c.exportada === true) return false;

      // 2. Omitir canciones importadas desde el almacenamiento local del teléfono (ya están en el dispositivo)
      if (c.origen === 'local_importada') return false;

      // 3. Omitir archivos residuales, de caché o sin blob de audio válido
      if (c.origen === 'cache') return false;
      if (!c.blob || c.blob.size < 50000) return false;

      // 4. Debe ser una descarga explícita de la app
      return c.descargada === true || c.origen === 'descarga' || (c.fecha && c.tamano >= 50000);
    });

    // Si la memoria aún está sincronizando la biblioteca, consultar directamente a IndexedDB con filtros estrictos
    if (cancionesAExportar.length === 0 && biblioteca.length === 0) {
      try {
        await localforage.ready();
        await localforage.iterate((valor: any, clave: string) => {
          if (
            clave.startsWith('app_') ||
            clave.startsWith('lyrics_') ||
            clave.startsWith('probe_') ||
            clave.startsWith('cache_') ||
            clave.startsWith('temp_') ||
            clave.startsWith('stream_')
          ) return;

          if (valor && typeof valor === 'object' && valor.blob && valor.blob.size >= 50000) {
            if (valor.exportada === true || valor.origen === 'local_importada' || valor.origen === 'cache') return;
            const esDescarga = valor.descargada === true || valor.origen === 'descarga' || (valor.fecha && valor.tamano >= 50000);
            if (esDescarga) {
              cancionesAExportar.push({
                nombre: clave,
                blob: valor.blob,
                tamano: valor.tamano || valor.blob.size || 0,
                duracion: valor.duracion || 0,
                caratula: valor.caratula,
                artista: valor.artista,
                favorito: !!valor.favorito,
                fecha: valor.fecha,
                exportada: false,
                descargada: true,
                origen: 'descarga'
              });
            }
          }
        });
      } catch (errDb) {
        console.warn('[Exportación]: Error leyendo canciones desde base de datos local:', errDb);
      }
    }

    if (cancionesAExportar.length === 0) {
      if (biblioteca.length === 0) {
        mostrarToast('No hay canciones descargadas en tu biblioteca para exportar', 'info');
      } else {
        mostrarToast('Todas las canciones descargadas ya están guardadas en tu dispositivo. No hay archivos nuevos por exportar.', 'info');
      }
      return;
    }

    setProcesandoRespaldo(true);
    mostrarToast(`Iniciando exportación de ${cancionesAExportar.length} pista(s) descargada(s)...`, 'info');

    let exitosas = 0;
    let fallidas = 0;

    try {
      for (let i = 0; i < cancionesAExportar.length; i++) {
        const cancion = cancionesAExportar[i];
        setTextoDescarga(`Guardando en dispositivo (${i + 1}/${cancionesAExportar.length}): "${cancion.nombre}"...`);

        try {
          let blobAudio = cancion.blob;
          if (!blobAudio || blobAudio.size === 0) {
            const guardado: any = await localforage.getItem(cancion.nombre);
            if (guardado instanceof Blob) {
              blobAudio = guardado;
            } else if (guardado && guardado.blob instanceof Blob) {
              blobAudio = guardado.blob;
            }
          }

          if (!blobAudio || blobAudio.size < 50000) {
            throw new Error(`Archivo de audio no disponible o dañado para "${cancion.nombre}"`);
          }

          const nombreLimpio = (cancion.nombre || `pista_${i + 1}`).replace(/[\\/:*?"<>|]/g, '_').trim();
          const blobAdecuado = blobAudio.type.startsWith('audio/')
            ? blobAudio
            : new Blob([blobAudio], { type: 'audio/mpeg' });

          const url = URL.createObjectURL(blobAdecuado);
          const a = document.createElement('a');
          a.href = url;
          a.download = `${nombreLimpio}.mp3`;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();

          setTimeout(() => {
            if (document.body.contains(a)) document.body.removeChild(a);
            try {
              URL.revokeObjectURL(url);
            } catch (_) {}
          }, 3500);

          // Marcar con exportada: true para evitar duplicaciones en futuros respaldos
          const cancionActualizada: Cancion = {
            ...cancion,
            blob: blobAudio,
            exportada: true
          };
          await localforage.setItem(cancion.nombre, cancionActualizada);
          setBiblioteca((prev) => {
            const nueva = prev.map((c) => (c.nombre === cancion.nombre ? cancionActualizada : c));
            guardarCatalogoLigero(nueva);
            return nueva;
          });

          exitosas++;
        } catch (errCancion: any) {
          fallidas++;
          console.warn(`[Exportación]: Aviso en canción "${cancion?.nombre || 'sin nombre'}":`, errCancion?.message || errCancion);
        }

        await new Promise((r) => setTimeout(r, 350));
      }

      if (fallidas === 0) {
        mostrarToast(`✓ ¡Se guardaron ${exitosas} canciones descargadas en tu dispositivo (.mp3)!`, 'exito');
      } else {
        mostrarToast(`✓ Exportación completada: ${exitosas} guardadas, ${fallidas} con aviso.`, 'info');
      }
    } catch (errGlobal: any) {
      console.error('Error imprevisto durante la exportación:', errGlobal);
      mostrarToast(`Aviso de exportación: ${errGlobal?.message || errGlobal}`, 'error');
    } finally {
      setProcesandoRespaldo(false);
      setTextoDescarga('');
    }
  };

  // Alias para exportación de descargas a MP3
  const descargarTodasLasCancionesMp3 = exportarTodasLasCancionesMp3;

  // Respaldo global seguro y ligero de biblioteca y listas (formato JSON como índice de texto sin duplicar archivos físicos)
  const exportarTodaLaBiblioteca = async () => {
    if (biblioteca.length === 0) {
      mostrarToast('No hay canciones en la biblioteca para respaldar', 'error');
      return;
    }

    setProcesandoRespaldo(true);
    mostrarToast('Generando índice de respaldo ligero...');

    try {
      // Exportación de índice de texto y metadatos ultra ligera (<100KB) sin duplicar archivos físicos en el teléfono
      const listaCancionesMetadatos = biblioteca.map((c) => ({
        nombre: c.nombre,
        artista: c.artista || '',
        duracion: c.duracion || 0,
        tamano: c.tamano || 0,
        favorito: !!c.favorito,
        fecha: c.fecha || Date.now(),
        caratula: c.caratula || '',
        descargada: c.descargada ?? (c.origen === 'descarga'),
        origen: c.origen || 'descarga',
        exportada: !!c.exportada
      }));

      const respaldo = {
        app: 'AppMusica',
        version: 3,
        tipo: 'indice_metadatos_ligero',
        descripcion: 'Índice de respaldo de canciones y playlists de App Música (sin archivos de audio binarios)',
        fecha: new Date().toISOString(),
        totalCanciones: biblioteca.length,
        canciones: listaCancionesMetadatos,
        playlists
      };

      const jsonStr = JSON.stringify(respaldo, null, 2);
      const blobJson = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blobJson);
      const a = document.createElement('a');
      a.href = url;
      const fechaHoy = new Date().toISOString().slice(0, 10);
      a.download = `Respaldo_Indice_Musica_${fechaHoy}.json`;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => {
        if (document.body.contains(a)) document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 4000);

      mostrarToast(`✓ Respaldo de ${biblioteca.length} canciones guardado (.json)`, 'exito');
    } catch (err: any) {
      console.error('Error al exportar respaldo:', err);
      mostrarToast('No se pudo generar el archivo de respaldo', 'error');
    } finally {
      setProcesandoRespaldo(false);
    }
  };

  // Importar música local y respaldo
  const manejarImportacionArchivos = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const archivos = e.target.files;
    if (!archivos || archivos.length === 0) return;

    setDescargando(true);
    setTextoDescarga(`Importando ${archivos.length} archivo(s)...`);

    let totalImportadas = 0;

    for (let i = 0; i < archivos.length; i++) {
      const archivo = archivos[i];

      if (archivo.name.endsWith('.json') || archivo.type === 'application/json') {
        try {
          const texto = await archivo.text();
          const datos = JSON.parse(texto);
          if (datos && Array.isArray(datos.canciones)) {
            for (const item of datos.canciones) {
              const blob = await dataUrlABlob(item.dataUrl);
              await localforage.setItem(item.nombre, {
                blob,
                tamano: item.tamano || blob.size,
                duracion: item.duracion || 0,
                favorito: !!item.favorito,
                fecha: item.fecha || Date.now()
              });
              totalImportadas++;
            }
          }
          if (datos && Array.isArray(datos.playlists)) {
            await guardarPlaylistsEnDB(datos.playlists);
          }
        } catch (err) {
          console.error('Error al importar JSON:', err);
        }
        continue;
      }

      if (archivo.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|aac|flac)$/i.test(archivo.name)) {
        try {
          const nombreLimpio = archivo.name.replace(/\.[^/.]+$/, '').trim();
          const arrayBuffer = await archivo.arrayBuffer();
          const audioBlob = new Blob([arrayBuffer], { type: 'audio/mpeg' });
          const duracion = await obtenerDuracionDeBlob(audioBlob);

          await localforage.setItem(nombreLimpio, {
            blob: audioBlob,
            tamano: audioBlob.size,
            duracion,
            favorito: false,
            fecha: Date.now(),
            exportada: true, // Ya existe en el dispositivo del usuario, no duplicar al re-exportar
            descargada: false,
            origen: 'local_importada'
          });
          totalImportadas++;
        } catch (err) {
          console.error(`Error importando audio ${archivo.name}:`, err);
        }
      }
    }

    try {
      localStorage.removeItem(CLAVE_CATALOGO_LIGERO);
    } catch (_) {}
    await cargarDatos();
    setDescargando(false);
    setTextoDescarga('');
    mostrarToast(`¡Se importaron ${totalImportadas} canciones!`);

    if (inputFileRef.current) inputFileRef.current.value = '';
    if (inputFolderRef.current) inputFolderRef.current.value = '';
  };

  // Referencia para selector de carpeta completa
  const inputFolderRef = useRef<HTMLInputElement>(null);

  // Estado para el proceso de blindaje físico
  const [blindandoMusica, setBlindandoMusica] = useState(false);
  const [progresoBlindaje, setProgresoBlindaje] = useState<{ actual: number; total: number; nombre: string } | null>(null);

  // Blindar todas las canciones de la biblioteca en /Music/AppMusica/ del teléfono
  // Inmune a desinstalaciones, borrado de datos o actualizaciones de la aplicación
  const blindarTodaLaMusicaEnDispositivo = async () => {
    if (blindandoMusica || biblioteca.length === 0) return;

    if (!esAlmacenamientoNativoDisponible()) {
      mostrarToast('📱 Guarda todas las descargas como MP3 en tu dispositivo', 'info');
      exportarTodasLasCancionesMp3();
      return;
    }

    setBlindandoMusica(true);
    mostrarToast(`Iniciando blindaje físico de ${biblioteca.length} canciones en tu teléfono...`, 'info');

    let exitosas = 0;
    let yaProtegidas = 0;
    let fallidas = 0;

    try {
      for (let i = 0; i < biblioteca.length; i++) {
        const cancion = biblioteca[i];
        setProgresoBlindaje({ actual: i + 1, total: biblioteca.length, nombre: cancion.nombre });

        // Si ya está guardada físicamente en el teléfono, no duplicar trabajo
        if (estaCancionEnMemoriaFisica(cancion.nombre)) {
          yaProtegidas++;
          continue;
        }

        try {
          let blob = cancion.blob;
          if (!blob || blob.size < 50000) {
            blob = (await obtenerBlobCancionBajoDemanda(cancion.nombre)) || undefined;
          }

          if (!blob || blob.size < 50000) {
            fallidas++;
            continue;
          }

          const res = await blindarCancionEnMemoriaFisica(cancion, blob);
          if (res.ok) {
            exitosas++;
          } else {
            fallidas++;
          }
        } catch (_) {
          fallidas++;
        }

        // Ceder el hilo para mantener la interfaz a 60 FPS
        await new Promise((r) => setTimeout(r, 60));
      }

      // Guardar también el catálogo ligero de respaldo en la carpeta pública
      guardarRespaldoEnMemoriaFisica({
        app: 'AppMusica',
        version: 4,
        fecha: new Date().toISOString(),
        totalCanciones: biblioteca.length,
        canciones: biblioteca.map((c) => ({
          nombre: c.nombre,
          tamano: c.tamano,
          duracion: c.duracion,
          artista: c.artista,
          caratula: c.caratula,
          favorito: !!c.favorito
        })),
        playlists
      });

      if (exitosas > 0) {
        mostrarToast(`✓ ¡${exitosas} canciones blindadas en tu teléfono! (${yaProtegidas} ya estaban seguras)`, 'exito');
      } else if (yaProtegidas > 0) {
        mostrarToast(`✓ ¡Todas tus canciones (${yaProtegidas}) ya están protegidas en la memoria de tu celular!`, 'exito');
      } else {
        mostrarToast('Blindaje finalizado.', 'info');
      }
    } catch (errGlobal) {
      console.error('[Blindaje]: Error en blindaje:', errGlobal);
      mostrarToast('Aviso durante el blindaje de canciones', 'error');
    } finally {
      setBlindandoMusica(false);
      setProgresoBlindaje(null);
    }
  };

  // Restaurar canciones y playlists guardadas físicamente en el teléfono
  const restaurarMusicaDesdeDispositivo = async () => {
    if (procesandoRespaldo) return;

    if (!esAlmacenamientoNativoDisponible()) {
      mostrarToast('Selecciona tu carpeta o archivos de música para restaurar', 'info');
      if (inputFolderRef.current) {
        inputFolderRef.current.click();
      } else if (inputFileRef.current) {
        inputFileRef.current.click();
      }
      return;
    }

    setProcesandoRespaldo(true);
    mostrarToast('Escaneando carpeta Música/AppMusica de tu teléfono...', 'info');

    try {
      const cancionesFisicas = obtenerCancionesEnMemoriaFisica();
      if (cancionesFisicas.length === 0) {
        mostrarToast('No se encontraron canciones en la carpeta Música/AppMusica de tu teléfono', 'info');
        return;
      }

      let agregadas = 0;
      const mapaExistentes = new Set(biblioteca.map((c) => c.nombre));
      const nuevasCanciones: Cancion[] = [];

      for (const cf of cancionesFisicas) {
        if (!mapaExistentes.has(cf.nombre)) {
          nuevasCanciones.push({
            nombre: cf.nombre,
            tamano: cf.tamano,
            duracion: cf.duracion,
            favorito: false,
            fecha: cf.fechaModificado || Date.now(),
            artista: cf.artista,
            exportada: true,
            descargada: true,
            origen: 'dispositivo_permanente'
          });
          agregadas++;
        }
      }

      const listaActualizada = [...nuevasCanciones, ...biblioteca];
      listaActualizada.sort((a, b) => a.nombre.localeCompare(b.nombre));
      setBiblioteca(listaActualizada);
      guardarCatalogoLigero(listaActualizada);

      // Restaurar playlists si están guardadas en el teléfono
      const respaldo = leerRespaldoDeMemoriaFisica();
      if (respaldo && Array.isArray(respaldo.playlists) && respaldo.playlists.length > 0) {
        setPlaylists(respaldo.playlists);
        guardarPlaylistsEnDB(respaldo.playlists).catch(() => {});
      }

      mostrarToast(`✓ ¡Restauradas! ${cancionesFisicas.length} canciones disponibles en tu teléfono (${agregadas} nuevas)`, 'exito');
    } catch (err: any) {
      console.error('[Restauración]: Error:', err);
      mostrarToast(`Aviso al restaurar: ${err?.message || err}`, 'error');
    } finally {
      setProcesandoRespaldo(false);
    }
  };

  // Versión identificadora para verificación visual OTA en vivo
  const VERSION_APP = 'v5.2.0';

  // Actualización Total mediante el Botón Interno:
  // Descarga nuevos scripts, purga el CacheStorage / ServiceWorker de forma segura
  // y fuerza una recarga limpia del WebView sin perder datos de IndexedDB
  const forzarComprobacionActualizacion = async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      mostrarToast('Modo Offline: conéctate a internet para buscar actualizaciones', 'info');
      return;
    }

    mostrarToast('Buscando actualizaciones en Render...', 'info');

    try {
      // 1. Limpieza total de CacheStorage (HTML, chunks JS, CSS) preservando IndexedDB intacto
      if (typeof window !== 'undefined' && 'caches' in window) {
        try {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
          console.log('[Actualización]: CacheStorage purgado con éxito.');
        } catch (eCache) {
          console.warn('[Actualización]: Advertencia al vaciar CacheStorage:', eCache);
        }
      }

      // 2. Destruir y desregistrar todos los Service Workers zombis
      if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
        try {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((reg) => reg.unregister()));
          console.log('[Actualización]: Service Workers zombis desregistrados con éxito.');
        } catch (eSw) {
          console.warn('[Actualización]: Advertencia al desregistrar Service Worker:', eSw);
        }
      }

      mostrarToast('✓ Actualizando a la última versión...', 'exito');

      // 3. Recarga limpia inmediata sin cambiar de origen (preserva 100% las canciones en IndexedDB)
      setTimeout(() => {
        try {
          const rutaBase = window.location.origin + window.location.pathname;
          window.location.replace(rutaBase + '?t=' + Date.now());
        } catch (_) {
          window.location.reload();
        }
      }, 400);
    } catch (e: any) {
      console.error('Error durante la actualización:', e);
      mostrarToast('Recargando aplicación...', 'info');
      try {
        const rutaBase = window.location.origin + window.location.pathname;
        window.location.replace(rutaBase + '?t=' + Date.now());
      } catch (_) {
        window.location.reload();
      }
    }
  };

  const forzarRecargaLimpia = forzarComprobacionActualizacion;

  useEffect(() => {
    notificarOtaLista().catch(() => {});
    const timerOta = window.setTimeout(() => {
      revisarActualizacionOta({
        silencioso: true,
        onEstado: (est, msg) => {
          setEstadoOta(est);
          setMensajeOta(msg);
        }
      }).catch(() => {});
    }, 2500);
    return () => window.clearTimeout(timerOta);
  }, []);

  const manejarBuscarActualizacionOta = async () => {
    try {
      const res = await revisarActualizacionOta({
        silencioso: false,
        onEstado: (est, msg) => {
          setEstadoOta(est);
          setMensajeOta(msg);
        }
      });
      if (res.usarRespaldoLegacy) {
        mostrarToast(res.mensaje || 'Actualizando desde Render...', 'info');
        await forzarComprobacionActualizacion();
        return;
      }
      if (res.estado === 'actualizada') {
        mostrarToast(res.mensaje, 'exito');
      } else if (res.estado === 'descargando') {
        mostrarToast(res.mensaje, 'info');
      } else if (res.estado === 'error') {
        mostrarToast(res.mensaje, 'error');
      }
    } catch (err: any) {
      const msg = err?.message || 'Error al buscar actualización';
      setEstadoOta('error');
      setMensajeOta(`Error: ${msg}`);
      mostrarToast(`Error: ${msg}`, 'error');
    }
  };

  // Importar música propia desde el teléfono (MP3, M4A, FLAC, OGG, WAV)
  const manejarImportarMusicaPropia = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (files.length === 0) return;

    setImportandoMusicaPropia(true);
    setProgresoImportacion({ actual: 0, total: files.length, archivo: files[0].name });
    try {
      const resumen = await importarArchivosMusicaPropia(
        files,
        bibliotecaRef.current,
        (prog) => setProgresoImportacion(prog)
      );

      if (resumen.importadas.length > 0) {
        setBiblioteca((prev) => {
          const existentes = new Set(prev.map((c) => c.nombre));
          const nuevas: Cancion[] = resumen.importadas
            .filter((imp) => !existentes.has(imp.nombre))
            .map((imp) => ({
              ...imp,
              tituloLower: normalizarParaBusqueda(imp.nombre),
              artistaLower: normalizarParaBusqueda(imp.artista)
            }));
          const combinada = [...nuevas, ...prev];
          combinada.sort((a, b) => a.nombre.localeCompare(b.nombre));
          guardarCatalogoLigero(combinada);
          return combinada;
        });
      }

      const partes: string[] = [];
      if (resumen.importadas.length > 0) partes.push(`${resumen.importadas.length} importada(s)`);
      if (resumen.duplicadas > 0) partes.push(`${resumen.duplicadas} duplicada(s) omitida(s)`);
      if (resumen.errores > 0) partes.push(`${resumen.errores} con error`);
      mostrarToast(
        partes.length > 0 ? `✓ Importación: ${partes.join(', ')}` : 'No se importaron archivos compatibles',
        resumen.importadas.length > 0 ? 'exito' : 'info'
      );
    } catch (err: any) {
      mostrarToast(`Error importando música: ${err?.message || 'desconocido'}`, 'error');
    } finally {
      setImportandoMusicaPropia(false);
      setProgresoImportacion(null);
    }
  };

  // Marcar una canción como verificada manualmente desde Revisar biblioteca
  const marcarCancionComoCorrecta = async (nombre: string) => {
    try {
      const registro: any = await localforage.getItem(nombre);
      if (registro && typeof registro === 'object') {
        const actualizadoDb = {
          ...registro,
          verified: true,
          flagReason: undefined
        };
        await localforage.setItem(nombre, actualizadoDb);
      }

      setBiblioteca((prev) => {
        const nueva = prev.map((c) =>
          c.nombre === nombre
            ? {
                ...c,
                verified: true,
                flagReason: undefined
              }
            : c
        );
        guardarCatalogoLigero(nueva);
        return nueva;
      });
      mostrarToast(`✓ "${nombre}" marcada como correcta`, 'exito');
    } catch (err: any) {
      console.warn('[RevisarBiblioteca]: Error al marcar como correcta:', err);
      mostrarToast('No se pudo actualizar el estado de verificación', 'error');
    }
  };

  // Eliminar canción con modal estilizado Spotify
  const eliminarCancion = (nombre: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    pedirConfirmacion({
      titulo: '¿Deseas eliminar esta canción?',
      mensaje: `¿Estás seguro de que deseas eliminar "${nombre}" de tu biblioteca local?`,
      textoConfirmar: 'Eliminar',
      peligroso: true,
      onConfirmar: async () => {
        try {
          await localforage.removeItem(nombre);
          localforage.removeItem(`lyrics_${nombre}`).catch(() => {});

          if (cancionActual && cancionActual.nombre === nombre) {
            cancelarCrossfade();
            const activo = getActiveDeckEl();
            if (activo) activo.pause();
            if (urlDeckARef.current) {
              URL.revokeObjectURL(urlDeckARef.current);
              urlDeckARef.current = null;
            }
            if (urlDeckBRef.current) {
              URL.revokeObjectURL(urlDeckBRef.current);
              urlDeckBRef.current = null;
            }
            setCancionActual(null);
            setReproduciendo(false);
            setTiempoActual(0);
            setDuracionTotal(0);
          }

          setBiblioteca((prev) => {
            const filtrada = prev.filter((item) => item.nombre !== nombre);
            guardarCatalogoLigero(filtrada);
            return filtrada;
          });
          const actualizadasPlaylists = playlists.map((p) => ({
            ...p,
            canciones: p.canciones.filter((c) => c !== nombre)
          }));
          await guardarPlaylistsEnDB(actualizadasPlaylists);
          mostrarToast(`Canción eliminada: "${nombre}"`, 'info');
        } catch (error) {
          console.error('Error al eliminar:', error);
        }
      }
    });
  };

  const eliminarCancionRef = useRef(eliminarCancion);
  eliminarCancionRef.current = eliminarCancion;
  const alEliminarFila = useCallback((nombre: string, e: React.MouseEvent) => {
    eliminarCancionRef.current(nombre, e);
  }, []);

  const alternarReproduccion = (forzar?: boolean | React.MouseEvent) => {
    if (!cancionActual) {
      const lista = listaParaReproduccion.length > 0 ? listaParaReproduccion : biblioteca;
      if (lista.length > 0) {
        reproducirCancion(lista[0]);
      }
      return;
    }

    const activo = getActiveDeckEl();
    const inactivo = getInactiveDeckEl();
    if (!activo) return;

    const deberiaReproducir = typeof forzar === 'boolean' ? forzar : !reproduciendo;

    if (!deberiaReproducir) {
      pausadoPorUsuarioRef.current = true;
      // Si el usuario pausa a la mitad de un SmartMix, cancelar el cruce inmediatamente,
      // consolidando el Deck entrante (actual) con ganancia 1.0 y filtro en 20 Hz y deteniendo el saliente
      if (crossfadingRef.current || smartAutomixEngine.isMixing()) {
        cancelarCrossfade();
      }
      activo.pause();
      if (inactivo) {
        try {
          inactivo.pause();
        } catch (_) {}
      }
      reproduciendoRef.current = false;
      setReproduciendo(false);
      soltarWakeLock();
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
      actualizarMediaSessionRef.current();
    } else {
      pausadoPorUsuarioRef.current = false;
      // Si se solicita forzar play (ej. eco de evento Bluetooth/notificación) y ya está reproduciendo activamente, no interrumpir
      if (typeof forzar === 'boolean' && forzar === true && !activo.paused && !activo.ended && activo.currentTime > 0) {
        setReproduciendo(true);
        if ('mediaSession' in navigator) {
          navigator.mediaSession.playbackState = 'playing';
        }
        actualizarMediaSessionRef.current();
        return;
      }
      detenerPreview();
      desbloquearAmbosDecks();
      solicitarWakeLock();
      if (bassBoostManager.isActivo()) {
        bassBoostManager.aplicarGanancia([deckARef.current, deckBRef.current]);
        bassBoostManager.resume();
        smartAutomixEngine.resetDeckToUnity(bassBoostManager.getContext(), activo);
      }
      activo.volume = silenciado ? 0 : volumen;
      const playPromise = activo.play();
      if (playPromise !== undefined) {
        playPromise
          .then(() => {
            reproduciendoRef.current = true;
            setReproduciendo(true);
            setMensajeErrorAudio(null);
            if ('mediaSession' in navigator) {
              navigator.mediaSession.playbackState = 'playing';
            }
            actualizarMediaSessionRef.current();
          })
          .catch((err) => {
            console.warn('Play en alternarReproduccion bloqueado:', err);
            reproduciendoRef.current = false;
            setReproduciendo(false);
            soltarWakeLock();
            if ('mediaSession' in navigator) {
              navigator.mediaSession.playbackState = 'paused';
            }
          });
      }
    }
  };

  const saltarTiempo = (segundos: number) => {
    cancelarCrossfade();
    const activo = getActiveDeckEl();
    if (!activo) return;
    const dur = duracionTotal || activo.duration || 0;
    const destino = Math.max(0, Math.min(dur, activo.currentTime + segundos));
    activo.currentTime = destino;
    ultimoCurrentTimeRef.current = destino;
    ultimoAvanceTimestampRef.current = Date.now();
    bassBoostManager.resetearDetectorSilencio(activo);
    setTiempoActual(destino);
  };

  const saltarATiempo = (destinoSegundos: number) => {
    cancelarCrossfade();
    const activo = getActiveDeckEl();
    if (!activo) return;
    const dur = duracionTotal || activo.duration || 0;
    const destino = Math.max(0, Math.min(dur, destinoSegundos));
    activo.currentTime = destino;
    ultimoCurrentTimeRef.current = destino;
    ultimoAvanceTimestampRef.current = Date.now();
    bassBoostManager.resetearDetectorSilencio(activo);
    setTiempoActual(destino);
  };

  const cambiarModoRepeticion = () => {
    let nuevo: ModoRepeticion;
    if (modoRepeticion === 'all') nuevo = 'one';
    else if (modoRepeticion === 'one') nuevo = 'off';
    else nuevo = 'all';

    setModoRepeticion(nuevo);
    try {
      localStorage.setItem('app_musica_repeticion', nuevo);
    } catch (_) {}

    const etiquetas = {
      all: 'Repetir todo: Reproducción automática continua activada',
      one: 'Repetir una: Se reproducirá la pista actual en bucle',
      off: 'Sin repetición: Se detendrá al finalizar la lista'
    };
    mostrarToast(etiquetas[nuevo], 'info');
  };

  const alternarModoAleatorio = () => {
    const nuevo = !modoAleatorio;
    setModoAleatorio(nuevo);
    try {
      localStorage.setItem('app_musica_aleatorio', String(nuevo));
    } catch (_) {}
    mostrarToast(nuevo ? 'Modo Aleatorio activado' : 'Modo Aleatorio desactivado', 'info');
  };

  const cambiarVolumen = (nuevoVolumen: number) => {
    const vClamped = Math.max(0, Math.min(1, nuevoVolumen));
    setVolumen(vClamped);
    if (silenciado && vClamped > 0) setSilenciado(false);
    if (!crossfadingRef.current) {
      if (deckARef.current && deckActivoRef.current === 'A') deckARef.current.volume = vClamped;
      if (deckBRef.current && deckActivoRef.current === 'B') deckBRef.current.volume = vClamped;
    }
    try {
      localStorage.setItem('app_musica_volumen', vClamped.toString());
    } catch (_) {}
  };

  const alternarSilencio = () => {
    const nuevoSilenciado = !silenciado;
    setSilenciado(nuevoSilenciado);
    if (deckARef.current) deckARef.current.volume = nuevoSilenciado ? 0 : volumen;
    if (deckBRef.current) deckBRef.current.volume = nuevoSilenciado ? 0 : volumen;
    mostrarToast(nuevoSilenciado ? 'Audio Silenciado' : `Volumen al ${Math.round(volumen * 100)}%`, 'info');
  };

  const cambiarVelocidad = (forzar?: number) => {
    const opciones = [1, 1.12, 0.88];
    let nueva = forzar;
    if (nueva === undefined) {
      const actualIdx = opciones.indexOf(velocidad);
      nueva = opciones[(actualIdx + 1) % opciones.length];
    }
    setVelocidad(nueva);
    const activo = getActiveDeckEl();
    if (activo) activo.playbackRate = nueva;
    // Sincronizar frecuencia del filtro Lowshelf en tiempo real (57.2 Hz en 0.88x, 65 Hz en 1.0x, 72.8 Hz en 1.12x)
    bassBoostManager.actualizarVelocidadReproduccion(nueva);
    const desc = nueva === 0.88 ? '0.88x (Slowed 🌙 • 57Hz DSP)' : nueva === 1.12 ? '1.12x (Sped Up ⚡ • 73Hz DSP)' : '1.0x (Normal • 65Hz DSP)';
    mostrarToast(`Velocidad: ${desc}`, 'info');
  };

  // Atajos de teclado para PC (Estilo Spotify Desktop)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      if (e.code === 'Space') {
        e.preventDefault();
        alternarReproduccionRef.current();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        if (e.shiftKey) {
          reproducirSiguienteRef.current();
        } else {
          saltarTiempoRef.current(10);
        }
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        if (e.shiftKey) {
          reproducirAnteriorRef.current();
        } else {
          saltarTiempoRef.current(-10);
        }
      } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        cambiarVolumen(Math.min(1, volumen + 0.05));
      } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        cambiarVolumen(Math.max(0, volumen - 0.05));
      } else if (e.key === 'm' || e.key === 'M') {
        alternarSilencio();
      } else if (e.key === 'l' || e.key === 'L') {
        if (cancionActual) alternarFavorito(cancionActual.nombre);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [volumen, silenciado, cancionActual]);

  cancionActualRef.current = cancionActual;
  reproduciendoRef.current = reproduciendo;
  arrastrandoSeekRef.current = arrastrandoSeek;
  colaReproduccionRef.current = colaReproduccion;
  listaParaReproduccionRef.current = listaParaReproduccion;
  listaContextoRef.current = listaContexto;
  bibliotecaRef.current = biblioteca;
  modoAleatorioRef.current = modoAleatorio;
  modoRepeticionRef.current = modoRepeticion;
  playlistSeleccionadaRef.current = playlistSeleccionada;
  alTerminarPistaRef.current = alTerminarPista;
  reproducirSiguienteRef.current = reproducirSiguiente;
  reproducirAnteriorRef.current = reproducirAnterior;
  alternarReproduccionRef.current = alternarReproduccion;
  saltarTiempoRef.current = saltarTiempo;
  saltarATiempoRef.current = saltarATiempo;
  cancelarCrossfadeRef.current = cancelarCrossfade;

  // Pre-buffering predictivo no invasivo de la próxima pista (colaManual[0] o siguiente de la lista/radio) cuando currentTime > 10s
  const proximaPistaPrebuffer = colaReproduccion[0] || obtenerSiguienteCancion();
  usePrebuffer(deckActivoRef.current === 'A' ? deckARef : deckBRef, proximaPistaPrebuffer, {
    segundosTranscurridosTrigger: 10
  });

  // Radio Infinita / Autoplay Inteligente (Smart Queue)
  useRadioInfinita({
    cancionActual,
    colaReproduccion,
    setColaReproduccion,
    reproduciendo,
    autoplayHabilitado: autoplayRadio,
    historialNombres: historialEscucha.map((h) => h.nombre),
    biblioteca,
    onRecomendacionesAgregadas: (cant) => {
      mostrarToast(`✨ ${cant} temas añadidos a la cola por Autoplay`, 'info');
    }
  });

  // Extensión no invasiva del Scrubber (SeekTo) para MediaSession API
  useEffect(() => {
    return registrarMediaSessionSeekTo({
      onSeek: (segundos) => saltarATiempo(segundos),
      getDuration: () => duracionTotalRef.current
    });
  }, []);

  return (
    <div
      className="app-shell"
      style={{
        backgroundColor: 'transparent',
        color: '#ffffff',
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        maxWidth: '100vw',
        boxSizing: 'border-box',
        position: 'relative',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
      }}
    >

      {/* --- FONDO DINÁMICO AMBIENTAL GLOBAL (SPOTIFY AMBIENT AURA) --- */}
      <FondoAnimado
        tema={temaVisualActual}
        reproduciendo={reproduciendo}
        activo={animacionFondoActiva}
        modoAppRoot={true}
      />

      {/* --- SISTEMA DE ACTUALIZACIÓN IN-APP (SERVICE WORKER CON AUTO-UPDATE) --- */}
      <UpdatePrompt
        reproduciendo={reproduciendo}
        forzarBanner={hayNuevaVersionOta}
        onActualizarClick={forzarComprobacionActualizacion}
      />

      {/* --- BANNER SUTIL Y ELEGANTE DE MODO OFFLINE REAL --- */}
      {!estaOnline && (
        <aside
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            top: 'max(8px, env(safe-area-inset-top, 8px))',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 999,
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            backgroundColor: 'rgba(24, 24, 27, 0.94)',
            color: '#e4e4e7',
            padding: '5px 14px',
            borderRadius: '500px',
            fontSize: '11.5px',
            fontWeight: '600',
            letterSpacing: '0.2px',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            boxShadow: '0 4px 18px rgba(0, 0, 0, 0.55)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            transition: 'opacity 0.3s ease, transform 0.3s ease'
          }}
        >
          <span
            style={{
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              backgroundColor: '#f59e0b',
              boxShadow: '0 0 8px rgba(245, 158, 11, 0.9)',
              display: 'inline-block'
            }}
          />
          <span>Modo sin conexión • Biblioteca local lista</span>
        </aside>
      )}

      {/* --- SISTEMA DE NOTIFICACIONES TOAST FLOTANTES ESTILO SPOTIFY --- */}
      <div style={{
        position: 'fixed',
        top: 'max(20px, env(safe-area-inset-top))',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 1000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '8px',
        pointerEvents: 'none',
        maxWidth: '90%',
        width: 'max-content'
      }}>
        {toasts.map((t) => (
          <div
            key={t.id}
            style={{
              backgroundColor: t.tipo === 'error' ? '#2f1515' : '#282828',
              border: t.tipo === 'error' ? '1px solid #ef4444' : '1px solid rgba(255, 255, 255, 0.12)',
              color: '#ffffff',
              padding: '8px 16px',
              borderRadius: '500px',
              boxShadow: '0 4px 16px rgba(0,0,0,0.6)',
              fontSize: '13px',
              fontWeight: '500',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              animation: 'toastSlide 0.25s ease-out forwards',
              pointerEvents: 'auto',
              maxWidth: '90vw',
              boxSizing: 'border-box'
            }}
          >
            <span>{t.tipo === 'error' ? '⚠️' : t.tipo === 'info' ? 'ℹ️' : '✓'}</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.mensaje}</span>
          </div>
        ))}
      </div>

      {/* --- MODAL DE CONFIRMACIÓN MODERNO ESTILO SPOTIFY --- */}
      {modalConfirmacion.abierto && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.75)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          zIndex: 900,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '20px'
        }}>
          <div style={{
            backgroundColor: '#1e1e1e',
            border: '1px solid #333333',
            borderRadius: '16px',
            padding: '24px',
            width: '100%',
            maxWidth: '380px',
            boxSizing: 'border-box',
            boxShadow: '0 20px 40px rgba(0,0,0,0.9)',
            animation: 'modalFadeIn 0.2s ease-out'
          }}>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '18px', fontWeight: 'bold' }}>
              {modalConfirmacion.titulo}
            </h3>
            <p style={{ margin: '0 0 24px 0', fontSize: '13px', color: '#b3b3b3', lineHeight: '1.4' }}>
              {modalConfirmacion.mensaje}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setModalConfirmacion((prev) => ({ ...prev, abierto: false }))}
                style={{
                  backgroundColor: '#2a2a2a',
                  color: 'white',
                  border: 'none',
                  borderRadius: '50px',
                  padding: '10px 18px',
                  fontSize: '13px',
                  fontWeight: 'bold',
                  cursor: 'pointer'
                }}
              >
                Cancelar
              </button>
              <button
                onClick={() => {
                  setModalConfirmacion((prev) => ({ ...prev, abierto: false }));
                  modalConfirmacion.onConfirmar();
                }}
                style={{
                  backgroundColor: modalConfirmacion.peligroso ? '#ef4444' : '#1DB954',
                  color: 'white',
                  border: 'none',
                  borderRadius: '50px',
                  padding: '10px 20px',
                  fontSize: '13px',
                  fontWeight: 'bold',
                  cursor: 'pointer'
                }}
              >
                {modalConfirmacion.textoConfirmar}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL SELECTOR DE FONDOS Y ESPECTRO ADAPTATIVO --- */}
      {modalSelectorFondosAbierto && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          zIndex: 950,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '16px'
        }}>
          <div style={{
            backgroundColor: '#16161a',
            border: '1px solid rgba(255, 255, 255, 0.15)',
            borderRadius: '20px',
            padding: '22px',
            width: '100%',
            maxWidth: '480px',
            maxHeight: '90vh',
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
            boxShadow: '0 24px 60px rgba(0,0,0,0.95)',
            animation: 'modalFadeIn 0.2s ease-out'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: '#FFFFFF' }}>
                  🎨 Fondos de Pantalla y Espectro
                </h3>
                <p style={{ margin: '3px 0 0 0', fontSize: '12px', color: '#94A3B8' }}>
                  El espectro neón y sus reflejos se adaptan a cada fondo
                </p>
              </div>
              <button
                onClick={() => setModalSelectorFondosAbierto(false)}
                style={{
                  background: 'rgba(255, 255, 255, 0.1)',
                  border: 'none',
                  color: '#FFFFFF',
                  borderRadius: '50%',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  fontSize: '15px'
                }}
              >
                ✕
              </button>
            </div>

            {/* Modos rápidos: Auto y Carrusel que va pasando fondos */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', marginBottom: '10px' }}>
              <button
                onClick={() => {
                  setTemaSeleccionadoManual(null);
                  alternarModoCarruselFondos(false);
                  mostrarToast('Fondo: Automático por canción', 'exito');
                }}
                style={{
                  padding: '9px 12px',
                  borderRadius: '12px',
                  border: !temaSeleccionadoManual && !modoCarruselFondos ? '1.5px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.12)',
                  backgroundColor: !temaSeleccionadoManual && !modoCarruselFondos ? 'rgba(30, 215, 96, 0.15)' : '#202024',
                  color: '#FFFFFF',
                  fontSize: '12px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px'
                }}
              >
                <span>⚡ Auto por canción</span>
              </button>

              <button
                onClick={() => alternarModoCarruselFondos()}
                style={{
                  padding: '9px 12px',
                  borderRadius: '12px',
                  border: modoCarruselFondos ? '1.5px solid #38BDF8' : '1px solid rgba(255, 255, 255, 0.12)',
                  backgroundColor: modoCarruselFondos ? 'rgba(56, 189, 248, 0.18)' : '#202024',
                  color: '#FFFFFF',
                  fontSize: '12px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px'
                }}
              >
                <span>{modoCarruselFondos ? '✓ Ir pasando (Activo)' : '🔄 Ir pasando fondos'}</span>
              </button>
            </div>

            {/* Selector interactivo de tiempo de cambio de fondos */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: '10px',
              background: 'rgba(255,255,255,0.06)',
              padding: '8px 12px',
              borderRadius: '12px',
              border: '1px solid rgba(255,255,255,0.08)'
            }}>
              <span style={{ fontSize: '11.5px', color: '#94A3B8', fontWeight: '600' }}>
                ⏱️ Tiempo entre fondos:
              </span>
              <div style={{ display: 'flex', gap: '5px' }}>
                {[10, 15, 18, 20, 30].map((segs) => {
                  const activo = intervaloFondosSegundos === segs;
                  return (
                    <button
                      key={segs}
                      onClick={() => cambiarIntervaloFondos(segs)}
                      style={{
                        backgroundColor: activo ? '#38BDF8' : '#222226',
                        color: activo ? '#040d1a' : '#E2E8F0',
                        border: activo ? '1px solid #38BDF8' : '1px solid rgba(255,255,255,0.1)',
                        borderRadius: '8px',
                        padding: '4px 8px',
                        fontSize: '11px',
                        fontWeight: '800',
                        cursor: 'pointer',
                        transition: 'all 0.15s ease'
                      }}
                    >
                      {segs}s
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Contador de tiempo restante en vivo si el carrusel está activo */}
            {modoCarruselFondos && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                marginBottom: '10px',
                padding: '6px 12px',
                borderRadius: '8px',
                backgroundColor: 'rgba(56, 189, 248, 0.12)',
                border: '1px solid rgba(56, 189, 248, 0.25)',
                color: '#38BDF8',
                fontSize: '11.5px',
                fontWeight: '700'
              }}>
                <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: '#38BDF8', display: 'inline-block', boxShadow: '0 0 6px #38BDF8' }} />
                <span>⏳ Próximo cambio de fondo en: {tiempoRestanteFondo} segundos</span>
              </div>
            )}

            {/* Input oculto y botón para subir fondo personalizado */}
            <input
              type="file"
              ref={inputFondoPersonalizadoRef}
              accept="image/*"
              style={{ display: 'none' }}
              onChange={subirFondoPersonalizado}
            />
            <button
              onClick={() => inputFondoPersonalizadoRef.current?.click()}
              style={{
                width: '100%',
                padding: '10px 14px',
                borderRadius: '12px',
                border: '1px dashed rgba(255, 255, 255, 0.35)',
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                color: '#FFFFFF',
                fontSize: '12.5px',
                fontWeight: '700',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                marginBottom: '12px',
                transition: 'background-color 0.2s'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.05)'; }}
            >
              <span>📷 Subir foto de mi galería o PC</span>
            </button>

            {/* Cuadrícula visual con fotos reales y personalizadas */}
            <div style={{
              overflowY: 'auto',
              display: 'grid',
              gridTemplateColumns: 'repeat(2, 1fr)',
              gap: '10px',
              paddingRight: '4px',
              maxHeight: '48vh'
            }}>
              {todosLosTemas.map((tema) => {
                const esActivo = temaVisualActual.id === tema.id;
                const esPersonalizado = tema.id.startsWith('custom_');
                return (
                  <div
                    key={tema.id}
                    onClick={() => {
                      setTemaSeleccionadoManual(tema.id);
                      mostrarToast(`Fondo: ${tema.nombre}`);
                    }}
                    style={{
                      position: 'relative',
                      borderRadius: '12px',
                      overflow: 'hidden',
                      height: '110px',
                      cursor: 'pointer',
                      border: esActivo ? `2px solid ${tema.colorPrincipal}` : '1px solid rgba(255, 255, 255, 0.12)',
                      boxShadow: esActivo ? `0 0 16px ${tema.colorPrincipal}66` : 'none',
                      transition: 'all 0.18s ease',
                      backgroundColor: tema.colorFondo,
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'flex-end',
                      padding: '10px',
                      boxSizing: 'border-box'
                    }}
                  >
                    {tema.imagenUrl ? (
                      <div style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        backgroundImage: `url(${tema.imagenUrl})`,
                        backgroundSize: 'cover',
                        backgroundPosition: 'center',
                        zIndex: 0
                      }} />
                    ) : (
                      <div style={{
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        right: 0,
                        bottom: 0,
                        background: `radial-gradient(circle at 50% 50%, ${tema.colorPrincipal}44 0%, ${tema.colorFondo} 100%)`,
                        zIndex: 0
                      }} />
                    )}

                    <div style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      right: 0,
                      bottom: 0,
                      background: 'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.3) 60%, transparent 100%)',
                      zIndex: 1
                    }} />

                    <div style={{ position: 'relative', zIndex: 2 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                        <span style={{
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          backgroundColor: tema.colorPrincipal,
                          boxShadow: `0 0 6px ${tema.colorPrincipal}`
                        }} />
                        <span style={{
                          fontSize: '11.5px',
                          fontWeight: '800',
                          color: '#FFFFFF',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}>
                          {tema.nombre}
                        </span>
                      </div>
                      {tema.subtitulo && (
                        <p style={{ margin: 0, fontSize: '9.5px', color: '#94A3B8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {tema.subtitulo}
                        </p>
                      )}
                    </div>

                    {esActivo && (
                      <div style={{
                        position: 'absolute',
                        top: '6px',
                        right: '6px',
                        backgroundColor: tema.colorPrincipal,
                        color: '#000000',
                        borderRadius: '50%',
                        width: '18px',
                        height: '18px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '11px',
                        fontWeight: '900',
                        zIndex: 3
                      }}>
                        ✓
                      </div>
                    )}

                    {esPersonalizado && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          eliminarFondoPersonalizado(tema.id);
                        }}
                        title="Eliminar este fondo personalizado"
                        style={{
                          position: 'absolute',
                          top: '6px',
                          left: '6px',
                          backgroundColor: 'rgba(0, 0, 0, 0.7)',
                          color: '#FF4D4F',
                          border: '1px solid rgba(255, 77, 79, 0.5)',
                          borderRadius: '50%',
                          width: '22px',
                          height: '22px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '12px',
                          fontWeight: 'bold',
                          cursor: 'pointer',
                          zIndex: 4
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL MÁS FORMATOS DE DESCARGA (SCREENSHOT 1 ESTILO SNAP/YTDL)           */}
      {/* ========================================================================= */}
      {modalFormatosAbierto && itemParaDescargar && (() => {
        const opcionActiva = OPCIONES_FORMATO.find((o) => o.id === formatoSeleccionado) || OPCIONES_FORMATO[3];
        const manejarToqueFormato = (opcionId: string) => {
          setFormatoSeleccionado(opcionId);
          const ahora = Date.now();
          if (
            ultimoToqueFormatoRef.current.id === opcionId &&
            ahora - ultimoToqueFormatoRef.current.timestamp < 380
          ) {
            ultimoToqueFormatoRef.current = { id: '', timestamp: 0 };
            const item = itemParaDescargar;
            setModalFormatosAbierto(false);
            if (item) {
              descargarCancionItem(item, opcionId);
            }
          } else {
            ultimoToqueFormatoRef.current = { id: opcionId, timestamp: ahora };
          }
        };

        return (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          zIndex: 10050,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-end',
          padding: 0
        }}>
          <div
            className="modal-formatos-box"
            style={{
              backgroundColor: '#161618',
              borderTopLeftRadius: '24px',
              borderTopRightRadius: '24px',
              border: '1px solid rgba(255, 255, 255, 0.12)',
              width: '100%',
              maxWidth: '520px',
              maxHeight: '85dvh',
              display: 'flex',
              flexDirection: 'column',
              boxSizing: 'border-box',
              boxShadow: '0 -10px 40px rgba(0,0,0,0.9)',
              animation: 'modalSlideUp 0.22s ease-out',
              overflow: 'hidden'
            }}
          >
            {/* Cabecera del modal fija arriba */}
            <div style={{
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '14px',
              padding: '18px 20px',
              borderBottom: '1px solid rgba(255,255,255,0.08)'
            }}>
              <button
                onClick={() => setModalFormatosAbierto(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#FFFFFF',
                  cursor: 'pointer',
                  padding: '4px',
                  display: 'flex',
                  alignItems: 'center',
                  fontSize: '22px',
                  lineHeight: 1
                }}
              >
                ←
              </button>
              <div style={{ overflow: 'hidden' }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: '#FFFFFF' }}>
                  Más formatos
                </h3>
                <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: '#94A3B8', maxWidth: '380px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {itemParaDescargar.title}
                </p>
              </div>
            </div>

            {/* Lista scrollable de opciones de Música y Video */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              padding: '16px 20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px'
            }}>
              {/* Sección Música */}
              <div style={{ fontSize: '13px', fontWeight: '800', color: '#94A3B8', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                Música
              </div>

              {OPCIONES_FORMATO.filter((o) => o.seccion === 'musica').map((opcion) => {
                const activo = formatoSeleccionado === opcion.id;
                return (
                  <div
                    key={opcion.id}
                    onClick={() => manejarToqueFormato(opcion.id)}
                    onDoubleClick={() => {
                      const item = itemParaDescargar;
                      setModalFormatosAbierto(false);
                      if (item) {
                        descargarCancionItem(item, opcion.id);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 14px',
                      borderRadius: '12px',
                      cursor: 'pointer',
                      backgroundColor: activo ? 'rgba(30, 215, 96, 0.14)' : 'rgba(255, 255, 255, 0.03)',
                      border: activo ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.06)',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', flex: 1, minWidth: 0, paddingRight: '12px' }}>
                      <span style={{ fontSize: '18px', color: activo ? '#1ED760' : '#888', marginTop: '1px' }}>♫</span>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '14.5px', fontWeight: '700', color: activo ? '#FFFFFF' : '#E2E8F0' }}>
                            {opcion.titulo}
                          </span>
                          {opcion.badge && (
                            <span style={{
                              fontSize: '9.5px',
                              fontWeight: '800',
                              backgroundColor: '#262628',
                              color: '#B3B3B3',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              border: '1px solid #38383a'
                            }}>
                              {opcion.badge}
                            </span>
                          )}
                        </div>
                        <p style={{ margin: '3px 0 0 0', fontSize: '11px', color: '#888', lineHeight: '1.3' }}>
                          {opcion.subtitulo}
                        </p>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
                      <span style={{ fontSize: '12px', color: '#94A3B8', fontWeight: '600' }}>
                        {opcion.pesoAprox}
                      </span>
                      {/* Radio button circle */}
                      <div style={{
                        width: '20px',
                        height: '20px',
                        borderRadius: '50%',
                        border: activo ? '2px solid #1ED760' : '2px solid #555',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: activo ? '#1ED760' : 'transparent',
                        transition: 'all 0.15s ease'
                      }}>
                        {activo && (
                          <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#000000' }} />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Sección Video */}
              <div style={{ fontSize: '13px', fontWeight: '800', color: '#94A3B8', marginTop: '14px', marginBottom: '6px', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
                Video
              </div>

              {OPCIONES_FORMATO.filter((o) => o.seccion === 'video').map((opcion) => {
                const activo = formatoSeleccionado === opcion.id;
                return (
                  <div
                    key={opcion.id}
                    onClick={() => manejarToqueFormato(opcion.id)}
                    onDoubleClick={() => {
                      const item = itemParaDescargar;
                      setModalFormatosAbierto(false);
                      if (item) {
                        descargarCancionItem(item, opcion.id);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      padding: '12px 14px',
                      borderRadius: '12px',
                      cursor: 'pointer',
                      backgroundColor: activo ? 'rgba(30, 215, 96, 0.14)' : 'rgba(255, 255, 255, 0.03)',
                      border: activo ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.06)',
                      transition: 'all 0.15s ease'
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px', flex: 1, minWidth: 0, paddingRight: '12px' }}>
                      <span style={{ fontSize: '17px', color: activo ? '#1ED760' : '#888', marginTop: '1px' }}>▷</span>
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '14.5px', fontWeight: '700', color: activo ? '#FFFFFF' : '#E2E8F0' }}>
                            {opcion.titulo}
                          </span>
                          {opcion.badge && (
                            <span style={{
                              fontSize: '9.5px',
                              fontWeight: '800',
                              backgroundColor: '#262628',
                              color: '#B3B3B3',
                              padding: '2px 6px',
                              borderRadius: '4px',
                              border: '1px solid #38383a'
                            }}>
                              {opcion.badge}
                            </span>
                          )}
                        </div>
                        <p style={{ margin: '3px 0 0 0', fontSize: '11px', color: '#888', lineHeight: '1.3' }}>
                          {opcion.subtitulo}
                        </p>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0 }}>
                      <span style={{ fontSize: '12px', color: '#94A3B8', fontWeight: '600' }}>
                        {opcion.pesoAprox}
                      </span>
                      {/* Radio button circle */}
                      <div style={{
                        width: '20px',
                        height: '20px',
                        borderRadius: '50%',
                        border: activo ? '2px solid #1ED760' : '2px solid #555',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        backgroundColor: activo ? '#1ED760' : 'transparent',
                        transition: 'all 0.15s ease'
                      }}>
                        {activo && (
                          <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#000000' }} />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Pie del modal fijo con botón verde siempre visible */}
            <div style={{
              flexShrink: 0,
              padding: '14px 20px',
              paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
              backgroundColor: '#161618',
              borderTop: '1px solid rgba(255,255,255,0.08)'
            }}>
              <button
                onClick={() => {
                  const item = itemParaDescargar;
                  const fmt = formatoSeleccionado;
                  setModalFormatosAbierto(false);
                  if (item) {
                    descargarCancionItem(item, fmt);
                  }
                }}
                style={{
                  width: '100%',
                  backgroundColor: '#1ED760',
                  color: '#000000',
                  border: 'none',
                  borderRadius: '500px',
                  padding: '14px 20px',
                  fontSize: '15px',
                  fontWeight: '900',
                  cursor: 'pointer',
                  letterSpacing: '0.3px',
                  boxShadow: '0 4px 18px rgba(30, 215, 96, 0.35)',
                  transition: 'transform 0.1s ease, filter 0.1s ease'
                }}
                onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.98)'; }}
                onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
              >
                {`⬇️ Descargar ${opcionActiva.titulo} (${opcionActiva.pesoAprox})`}
              </button>
            </div>
          </div>
        </div>
        );
      })()}

      {/* --- MODAL MODERNO DE DESCARGA ESTILO SPOTIFY CON STEPPER PASO A PASO --- */}
      {descargando && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0, 0, 0, 0.82)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          zIndex: 850,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '20px'
        }}>
          <div style={{
            backgroundColor: '#181818',
            border: '1px solid #282828',
            borderRadius: '24px',
            padding: '28px 24px',
            width: '100%',
            maxWidth: '380px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '20px',
            boxShadow: '0 24px 60px rgba(0, 0, 0, 0.95)',
            animation: 'fadeIn 0.25s ease-out'
          }}>
            {/* Header / Insignia Spotify */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', width: '100%', justifyContent: 'center' }}>
              <div style={{
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                backgroundColor: '#1ED760',
                boxShadow: '0 0 10px #1ED760',
                animation: 'pulse 1.5s infinite'
              }} />
              <span style={{ fontSize: '12px', fontWeight: '800', letterSpacing: '1px', textTransform: 'uppercase', color: '#1ED760' }}>
                Descarga en Alta Definición
              </span>
            </div>

            {/* Tarjeta de la pista */}
            {infoPistaDescarga && (
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                width: '100%',
                backgroundColor: '#202020',
                padding: '12px 14px',
                borderRadius: '16px',
                border: '1px solid #2e2e2e'
              }}>
                {infoPistaDescarga.thumbnail ? (
                  <img
                    src={infoPistaDescarga.thumbnail}
                    alt={infoPistaDescarga.title}
                    loading="lazy"
                    decoding="async"
                    style={{
                      width: '48px',
                      height: '48px',
                      borderRadius: '10px',
                      objectFit: 'cover',
                      flexShrink: 0
                    }}
                  />
                ) : (
                  <div style={{
                    width: '48px',
                    height: '48px',
                    borderRadius: '10px',
                    backgroundColor: '#282828',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0
                  }}>
                    <IconNota size={22} color="#1ED760" />
                  </div>
                )}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <p style={{
                    margin: 0,
                    fontSize: '14px',
                    fontWeight: '700',
                    color: '#FFFFFF',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}>
                    {infoPistaDescarga.title}
                  </p>
                  <p style={{
                    margin: '2px 0 0 0',
                    fontSize: '12px',
                    color: '#B3B3B3',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis'
                  }}>
                    {infoPistaDescarga.artist || 'Audio Oficial'}
                  </p>
                  <span style={{
                    display: 'inline-block',
                    marginTop: '4px',
                    fontSize: '10px',
                    fontWeight: '700',
                    color: '#1ED760',
                    backgroundColor: 'rgba(30, 215, 96, 0.12)',
                    padding: '2px 8px',
                    borderRadius: '6px'
                  }}>
                    {(infoPistaDescarga.formato || 'MP3').toUpperCase()} • 320 KBPS
                  </span>
                </div>
              </div>
            )}

            {/* Stepper paso a paso */}
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {/* Paso 1: Conectando... */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '8px 12px',
                borderRadius: '10px',
                backgroundColor: pasoDescarga === 1 ? 'rgba(30, 215, 96, 0.08)' : 'transparent',
                transition: 'all 0.25s ease'
              }}>
                <div style={{
                  width: '26px',
                  height: '26px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: '700',
                  backgroundColor: pasoDescarga > 1 ? '#1ED760' : pasoDescarga === 1 ? 'rgba(30, 215, 96, 0.2)' : '#282828',
                  color: pasoDescarga > 1 ? '#000000' : pasoDescarga === 1 ? '#1ED760' : '#777777',
                  border: pasoDescarga === 1 ? '2px solid #1ED760' : 'none'
                }}>
                  {pasoDescarga > 1 ? '✓' : '1'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    margin: 0,
                    fontSize: '13px',
                    fontWeight: pasoDescarga === 1 ? '700' : '500',
                    color: pasoDescarga >= 1 ? '#FFFFFF' : '#777777'
                  }}>
                    {pasoDescarga === 1 && textoDescarga ? textoDescarga : 'Conectando con el proveedor...'}
                  </p>
                </div>
                {pasoDescarga === 1 && <IconSpinner size={16} color="#1ED760" />}
              </div>

              {/* Paso 2: Procesando MP3... */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '8px 12px',
                borderRadius: '10px',
                backgroundColor: pasoDescarga === 2 ? 'rgba(30, 215, 96, 0.08)' : 'transparent',
                transition: 'all 0.25s ease'
              }}>
                <div style={{
                  width: '26px',
                  height: '26px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: '700',
                  backgroundColor: pasoDescarga > 2 ? '#1ED760' : pasoDescarga === 2 ? 'rgba(30, 215, 96, 0.2)' : '#282828',
                  color: pasoDescarga > 2 ? '#000000' : pasoDescarga === 2 ? '#1ED760' : '#777777',
                  border: pasoDescarga === 2 ? '2px solid #1ED760' : 'none'
                }}>
                  {pasoDescarga > 2 ? '✓' : '2'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    margin: 0,
                    fontSize: '13px',
                    fontWeight: pasoDescarga === 2 ? '700' : '500',
                    color: pasoDescarga >= 2 ? '#FFFFFF' : '#777777'
                  }}>
                    {pasoDescarga === 2 && textoDescarga ? textoDescarga : 'Procesando audio y conversión MP3...'}
                  </p>
                </div>
                {pasoDescarga === 2 && <IconSpinner size={16} color="#1ED760" />}
              </div>

              {/* Paso 3: Guardando en almacenamiento local... */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '8px 12px',
                borderRadius: '10px',
                backgroundColor: pasoDescarga === 3 ? 'rgba(30, 215, 96, 0.08)' : 'transparent',
                transition: 'all 0.25s ease'
              }}>
                <div style={{
                  width: '26px',
                  height: '26px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '12px',
                  fontWeight: '700',
                  backgroundColor: pasoDescarga === 3 ? 'rgba(30, 215, 96, 0.2)' : '#282828',
                  color: pasoDescarga === 3 ? '#1ED760' : '#777777',
                  border: pasoDescarga === 3 ? '2px solid #1ED760' : 'none'
                }}>
                  3
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{
                    margin: 0,
                    fontSize: '13px',
                    fontWeight: pasoDescarga === 3 ? '700' : '500',
                    color: pasoDescarga >= 3 ? '#FFFFFF' : '#777777'
                  }}>
                    {pasoDescarga === 3 && textoDescarga ? textoDescarga : 'Guardando en almacenamiento local...'}
                  </p>
                </div>
                {pasoDescarga === 3 && <IconSpinner size={16} color="#1ED760" />}
              </div>
            </div>

            {/* Barra de progreso visual */}
            <div style={{
              width: '100%',
              height: '5px',
              backgroundColor: '#282828',
              borderRadius: '500px',
              overflow: 'hidden'
            }}>
              <div style={{
                height: '100%',
                width: pasoDescarga === 1 ? '35%' : pasoDescarga === 2 ? '70%' : '95%',
                backgroundColor: '#1ED760',
                borderRadius: '500px',
                transition: 'width 0.4s ease'
              }} />
            </div>

            {/* Botón activo de Cancelar si la petición excede 12 segundos */}
            {mostrarBotonCancelarDescarga && (
              <div style={{
                marginTop: '4px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '10px',
                width: '100%',
                animation: 'fadeIn 0.25s ease-out'
              }}>
                <span style={{
                  fontSize: '11px',
                  color: '#FFB86C',
                  backgroundColor: 'rgba(255, 184, 108, 0.12)',
                  padding: '4px 12px',
                  borderRadius: '500px',
                  border: '1px solid rgba(255, 184, 108, 0.3)'
                }}>
                  ⏳ Conexión lenta detectada...
                </span>
                <button
                  onClick={() => {
                    if (cancelDescargaRef.current) cancelDescargaRef.current();
                    setDescargando(false);
                    setDescargandoId(null);
                    setPasoDescarga(1);
                    setInfoPistaDescarga(null);
                    setTextoDescarga('');
                    mostrarToast('Descarga cancelada por el usuario', 'info');
                  }}
                  style={{
                    width: '100%',
                    padding: '11px 20px',
                    backgroundColor: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid #ef4444',
                    borderRadius: '500px',
                    color: '#fca5a5',
                    fontSize: '13px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.3)';
                    e.currentTarget.style.transform = 'scale(1.02)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
                    e.currentTarget.style.transform = 'scale(1)';
                  }}
                >
                  Cancelar descarga
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* --- INPUT OCULTO PARA IMPORTAR ARCHIVOS --- */}
      <input
        ref={inputFileRef}
        type="file"
        multiple
        accept="audio/*,.json,application/json"
        style={{ display: 'none' }}
        onChange={manejarImportacionArchivos}
      />
      {/* --- INPUT OCULTO PARA IMPORTAR CARPETA COMPLETA --- */}
      <input
        ref={inputFolderRef}
        type="file"
        {...({ webkitdirectory: '', directory: '' } as any)}
        multiple
        style={{ display: 'none' }}
        onChange={manejarImportacionArchivos}
      />

      {/* ========================================================================= */}
      {/* CONTENIDO PRINCIPAL SCROLLEABLE AISLADO (APP-CONTENT CON FLEX Y SCROLL NATIVO) */}
      {/* ========================================================================= */}
      <main
        ref={mainContentRef}
        className="app-content"
        style={{
          flex: '1 1 auto',
          minHeight: 0,
          overflowY: 'auto',
          overscrollBehavior: 'contain',
          touchAction: 'pan-y',
          WebkitOverflowScrolling: 'touch',
          paddingTop: 'max(16px, env(safe-area-inset-top))',
          paddingBottom: cancionActual
            ? 'calc(145px + env(safe-area-inset-bottom))'
            : 'calc(80px + env(safe-area-inset-bottom))',
          boxSizing: 'border-box',
          width: '100%'
        }}
      >

      {/* ========================================================================= */}
      {/* VISTA 0: INICIO (HOME OFICIAL ESTILO SPOTIFY) */}
      {/* ========================================================================= */}
      {tabActiva === 'inicio' && (
        <div
          className="vista-tab-content"
          style={{
            padding: '24px 16px',
            maxWidth: '680px',
            margin: '0 auto',
            width: '100%',
            boxSizing: 'border-box',
            position: 'relative',
            zIndex: 10
          }}
        >
          {/* Cabecera Superior con Saludo Dinámico según la hora */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                <span className="hero-subtitle-badge">
                  <span>🎧 SPOTIFY OFICIAL</span>
                  <span>•</span>
                  <span>{VERSION_APP}</span>
                  <span>•</span>
                  <span>{biblioteca.length} CANCIONES</span>
                </span>
              </div>
              <h1 className="hero-gradient-text" style={{ fontSize: '30px', fontWeight: '900', margin: 0, letterSpacing: '-0.8px' }}>
                {new Date().getHours() < 12 ? 'Buenos días' : new Date().getHours() < 19 ? 'Buenas tardes' : 'Buenas noches'}
              </h1>
            </div>

            {/* Accesos rápidos en la cabecera */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              {cancionActual && reproduciendo && (
                <button
                  onClick={() => ejecutarMixManualAhora()}
                  title="Mezclar con la siguiente canción ahora mismo (Spotify Crossfade)"
                  style={{
                    background: enTransicionMix
                      ? 'linear-gradient(135deg, #1ED760, #10b981)'
                      : 'rgba(30, 215, 96, 0.16)',
                    color: enTransicionMix ? '#000000' : '#1ED760',
                    border: '1px solid rgba(30, 215, 96, 0.5)',
                    borderRadius: '500px',
                    padding: '7px 13px',
                    fontSize: '12px',
                    fontWeight: '800',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    boxShadow: '0 0 12px rgba(30, 215, 96, 0.25)'
                  }}
                >
                  <span>🔀</span>
                  <span>{enTransicionMix ? `Mix ${progresoMix}%` : 'Mix Ya'}</span>
                </button>
              )}
              <button
                onClick={activarModoDJ}
                title="Activar Modo DJ Continuo estilo Spotify Automix"
                style={{
                  background: modoAleatorio && crossfadeSegundos > 0 ? '#1ED760' : 'rgba(255, 255, 255, 0.08)',
                  color: modoAleatorio && crossfadeSegundos > 0 ? '#000000' : '#FFFFFF',
                  border: modoAleatorio && crossfadeSegundos > 0 ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.16)',
                  borderRadius: '500px',
                  padding: '7px 14px',
                  fontSize: '12px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <IconMix size={14} color={modoAleatorio && crossfadeSegundos > 0 ? '#000000' : '#1ED760'} />
                <span>{crossfadeSegundos > 0 ? `DJ Mix (${crossfadeSegundos}s)` : 'DJ Mix'}</span>
              </button>
              <button
                onClick={() => setTabActiva('ajustes')}
                title="Ajustes"
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: '1px solid rgba(255, 255, 255, 0.16)',
                  borderRadius: '500px',
                  width: '36px',
                  height: '36px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  color: '#FFFFFF'
                }}
              >
                <IconAjustes size={18} />
              </button>
            </div>
          </div>

          {/* BARRA SPOTIFY AUTOMIX RÁPIDA EN INICIO */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '10px',
            padding: '12px 14px',
            marginBottom: '18px',
            borderRadius: '14px',
            background: 'linear-gradient(135deg, rgba(30, 215, 96, 0.14) 0%, rgba(16, 185, 129, 0.05) 100%)',
            border: '1px solid rgba(30, 215, 96, 0.28)',
            flexWrap: 'wrap'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
              <div style={{
                width: '34px',
                height: '34px',
                borderRadius: '10px',
                backgroundColor: 'rgba(30, 215, 96, 0.2)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}>
                <IconMix size={18} color="#1ED760" />
              </div>
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: '800', color: '#FFFFFF' }}>
                  Spotify Automix {crossfadeSegundos > 0 ? `Activo (${crossfadeSegundos}s)` : 'Listo'}
                </p>
                <p style={{ margin: '2px 0 0 0', fontSize: '11px', color: '#CBD5E1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {enTransicionMix
                    ? `🎧 Mezclando ahora (${progresoMix}%) hacia "${cancionActual?.nombre || ''}"`
                    : 'Une tus canciones con curva de potencia constante sin silencios'}
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              {[3, 5, 8, 12].map((seg) => (
                <button
                  key={seg}
                  onClick={() => cambiarCrossfade(seg)}
                  style={{
                    backgroundColor: crossfadeSegundos === seg ? '#1ED760' : 'rgba(255,255,255,0.08)',
                    color: crossfadeSegundos === seg ? '#000000' : '#E2E8F0',
                    border: crossfadeSegundos === seg ? '1px solid #1ED760' : '1px solid rgba(255,255,255,0.14)',
                    borderRadius: '500px',
                    padding: '5px 10px',
                    fontSize: '11px',
                    fontWeight: '800',
                    cursor: 'pointer'
                  }}
                >
                  {seg}s
                </button>
              ))}
            </div>
          </div>

          {/* ACCESOS RÁPIDOS 2 COLUMNAS (SPOTIFY QUICK GRID) */}
          <div className="spotify-quick-grid">
            {/* Canciones que te gustan */}
            <div
              className="spotify-quick-card"
              onClick={() => {
                setPlaylistSeleccionada(null);
                setFiltroBiblioteca('favoritas');
                setTabActiva('biblioteca');
              }}
            >
              <div
                className="spotify-quick-thumb"
                style={{ background: 'linear-gradient(135deg, #450af5, #c4efd9)' }}
              >
                <IconCorazon size={24} lleno={true} />
              </div>
              <div className="spotify-quick-info">
                <p className="spotify-quick-title">Canciones que te gustan</p>
                <p className="spotify-quick-sub">
                  {biblioteca.filter((c) => c.favorito).length} canciones favoritas
                </p>
              </div>
            </div>

            {/* Toda tu música offline */}
            <div
              className="spotify-quick-card"
              onClick={() => {
                setPlaylistSeleccionada(null);
                setFiltroBiblioteca('todas');
                setTabActiva('biblioteca');
              }}
            >
              <div
                className="spotify-quick-thumb"
                style={{ background: 'linear-gradient(135deg, #10b981, #065f46)' }}
              >
                <IconBiblioteca size={24} color="#FFFFFF" />
              </div>
              <div className="spotify-quick-info">
                <p className="spotify-quick-title">Tu Colección Local</p>
                <p className="spotify-quick-sub">{biblioteca.length} temas guardados</p>
              </div>
            </div>

            {/* Playlists de usuario */}
            {playlists.slice(0, 4).map((pl) => (
              <div
                key={pl.id}
                className="spotify-quick-card"
                onClick={() => {
                  setPlaylistSeleccionada(pl);
                  setFiltroBiblioteca('playlists');
                  setTabActiva('biblioteca');
                }}
              >
                <div
                  className="spotify-quick-thumb"
                  style={{ background: 'linear-gradient(135deg, #374151, #111827)' }}
                >
                  <IconNota size={22} color="#1ED760" />
                </div>
                <div className="spotify-quick-info">
                  <p className="spotify-quick-title">{pl.nombre}</p>
                  <p className="spotify-quick-sub">{pl.canciones.length} canciones</p>
                </div>
              </div>
            ))}

            {/* Accesos rápidos adicionales */}
            {playlists.length < 2 && (
              <>
                <div
                  className="spotify-quick-card"
                  onClick={() => {
                    setCancionParaPlaylist(null);
                    setCancionesSeleccionadasPlaylist([]);
                    setFiltroCancionModalPlaylist('');
                    setModalPlaylistAbierto(true);
                  }}
                >
                  <div
                    className="spotify-quick-thumb"
                    style={{ background: 'linear-gradient(135deg, #1f2937, #111827)' }}
                  >
                    <span style={{ fontSize: '24px', color: '#1ED760', fontWeight: '900' }}>+</span>
                  </div>
                  <div className="spotify-quick-info">
                    <p className="spotify-quick-title">Crear Playlist</p>
                    <p className="spotify-quick-sub">Elige canciones de tu biblioteca</p>
                  </div>
                </div>

                <div
                  className="spotify-quick-card"
                  onClick={() => setTabActiva('buscar')}
                >
                  <div
                    className="spotify-quick-thumb"
                    style={{ background: 'linear-gradient(135deg, #f59e0b, #b45309)' }}
                  >
                    <IconDescargar size={22} color="#FFFFFF" />
                  </div>
                  <div className="spotify-quick-info">
                    <p className="spotify-quick-title">Descargar Música</p>
                    <p className="spotify-quick-sub">Buscador MP3 320kbps</p>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* SECCIÓN: MEZCLAS AUTOMÁTICAS EN INICIO ("TU MIX DIARIO" Y "EN BUCLE") */}
          <div style={{ marginBottom: '26px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '800', color: '#FFFFFF', margin: 0, letterSpacing: '-0.3px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>✨</span> Hecho para ti
              </h2>
              <span style={{ fontSize: '11px', color: '#1ED760', fontWeight: '700' }}>Mezclas Inteligentes</span>
            </div>

            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
              gap: '12px'
            }}>
              {/* Tarjeta 1: Tu Mix Diario */}
              <div
                onClick={reproducirTuMixDiario}
                style={{
                  background: 'linear-gradient(135deg, rgba(30, 215, 96, 0.22) 0%, rgba(6, 182, 212, 0.14) 55%, rgba(24, 24, 28, 0.92) 100%)',
                  border: '1px solid rgba(30, 215, 96, 0.42)',
                  borderRadius: '16px',
                  padding: '16px',
                  cursor: 'pointer',
                  position: 'relative',
                  overflow: 'hidden',
                  boxShadow: '0 10px 28px rgba(0, 0, 0, 0.45)',
                  transition: 'transform 0.18s ease, box-shadow 0.18s ease'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <span style={{
                    fontSize: '10px',
                    fontWeight: '900',
                    textTransform: 'uppercase',
                    letterSpacing: '0.8px',
                    backgroundColor: '#1ED760',
                    color: '#000000',
                    padding: '3px 9px',
                    borderRadius: '500px'
                  }}>
                    ⚡ Daily Mix
                  </span>
                  <div style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '50%',
                    backgroundColor: '#1ED760',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 4px 14px rgba(30, 215, 96, 0.45)'
                  }}>
                    <IconPlay size={16} color="#000000" />
                  </div>
                </div>
                <h3 style={{ margin: '0 0 4px 0', fontSize: '18px', fontWeight: '900', color: '#FFFFFF', letterSpacing: '-0.3px' }}>
                  Tu Mix Diario
                </h3>
                <p style={{ margin: '0 0 10px 0', fontSize: '12px', color: '#CBD5E1', lineHeight: '1.35' }}>
                  {tuMixDiario.artistasTop.length > 0
                    ? `Mezcla con ${tuMixDiario.artistasTop.slice(0, 3).join(', ')} y tus favoritas`
                    : 'Tus canciones más escuchadas combinadas con tus artistas favoritos'}
                </p>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', color: '#1ED760', fontWeight: '700' }}>
                  <span>{tuMixDiario.canciones.length} canciones listas</span>
                  <span>Tocar para reproducir ▶</span>
                </div>
              </div>

              {/* Tarjeta 2: En Bucle (Top 10 canciones más reproducidas) */}
              <div
                onClick={() => reproducirEnBucle()}
                style={{
                  background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.24) 0%, rgba(236, 72, 153, 0.14) 55%, rgba(24, 24, 28, 0.92) 100%)',
                  border: '1px solid rgba(168, 85, 247, 0.45)',
                  borderRadius: '16px',
                  padding: '16px',
                  cursor: 'pointer',
                  position: 'relative',
                  overflow: 'hidden',
                  boxShadow: '0 10px 28px rgba(0, 0, 0, 0.45)',
                  transition: 'transform 0.18s ease, box-shadow 0.18s ease'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <span style={{
                    fontSize: '10px',
                    fontWeight: '900',
                    textTransform: 'uppercase',
                    letterSpacing: '0.8px',
                    backgroundColor: '#C084FC',
                    color: '#000000',
                    padding: '3px 9px',
                    borderRadius: '500px'
                  }}>
                    🔁 On Repeat
                  </span>
                  <div style={{
                    width: '36px',
                    height: '36px',
                    borderRadius: '50%',
                    backgroundColor: '#C084FC',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 4px 14px rgba(192, 132, 252, 0.45)'
                  }}>
                    <IconPlay size={16} color="#000000" />
                  </div>
                </div>
                <h3 style={{ margin: '0 0 4px 0', fontSize: '18px', fontWeight: '900', color: '#FFFFFF', letterSpacing: '-0.3px' }}>
                  En Bucle
                </h3>
                <p style={{ margin: '0 0 10px 0', fontSize: '12px', color: '#CBD5E1', lineHeight: '1.35' }}>
                  Acceso rápido de 1 toque a tus {Math.min(10, cancionesEnBucle.length || 10)} canciones más reproducidas
                </p>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '11px', color: '#E9D5FF', fontWeight: '700' }}>
                  <span>Top {cancionesEnBucle.length} temas</span>
                  <span>Reproducir en 1 toque ▶</span>
                </div>
              </div>
            </div>

            {/* Píldoras de acceso rápido a las canciones de "En Bucle" */}
            {cancionesEnBucle.length > 0 && (
              <div style={{
                display: 'flex',
                gap: '8px',
                overflowX: 'auto',
                padding: '10px 2px 4px 2px',
                scrollbarWidth: 'none'
              }}>
                {cancionesEnBucle.slice(0, 10).map((c, idx) => {
                  const activa = cancionActual?.nombre === c.nombre;
                  return (
                    <button
                      key={c.nombre}
                      onClick={() => reproducirEnBucle(c)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '7px',
                        padding: '6px 12px',
                        borderRadius: '500px',
                        backgroundColor: activa ? 'rgba(30, 215, 96, 0.22)' : 'rgba(255, 255, 255, 0.07)',
                        border: activa ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.12)',
                        color: '#FFFFFF',
                        fontSize: '11.5px',
                        fontWeight: '700',
                        cursor: 'pointer',
                        whiteSpace: 'nowrap',
                        flexShrink: 0
                      }}
                      title={`Reproducir ${c.nombre}`}
                    >
                      <span style={{ color: '#1ED760', fontWeight: '900' }}>#{idx + 1}</span>
                      <span style={{ maxWidth: '150px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {limpiarTextoMetadata(c.nombre)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* SECCIÓN: ESCUCHADO RECIENTEMENTE (CARRUSEL SPOTIFY STYLE) */}
          <EscuchadoRecientemente
            historial={historialEscucha}
            cancionActualNombre={cancionActual?.nombre}
            reproduciendo={reproduciendo}
            onReproducirCancion={alReproducirDeHistorial}
            onSeleccionar={alReproducirDeHistorial}
            onLimpiar={limpiarHistorialEscucha}
          />

          {/* SECCIÓN: ARTISTAS POPULARES (AVATARES CIRCULARES SPOTIFY) */}
          <div style={{ marginBottom: '28px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <h2 style={{ fontSize: '18px', fontWeight: '800', color: '#FFFFFF', margin: 0, letterSpacing: '-0.3px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>⭐</span> Artistas que te pueden gustar
              </h2>
              <span style={{ fontSize: '11px', color: '#1ed760', fontWeight: '700' }}>Toca para buscar</span>
            </div>

            <div className="artist-scroll-row">
              {[
                { nombre: 'Banda MS', sub: 'Banda', siglas: 'MS', grad: 'linear-gradient(135deg, #10b981, #059669)', foto: '/artistas/banda-ms.jpg' },
                { nombre: 'Grupo Frontera', sub: 'Norteño', siglas: 'GF', grad: 'linear-gradient(135deg, #f59e0b, #d97706)', foto: '/artistas/grupo-frontera.jpg' },
                { nombre: 'Carin León', sub: 'Regional', siglas: 'CL', grad: 'linear-gradient(135deg, #ea580c, #c2410c)', foto: '/artistas/carin-leon.jpg' },
                { nombre: 'Natanael Cano', sub: 'Corridos', siglas: 'NC', grad: 'linear-gradient(135deg, #8b5cf6, #6d28d9)', foto: '/artistas/natanael-cano.jpg' },
                { nombre: 'Peso Pluma', sub: 'Tumbados', siglas: 'PP', grad: 'linear-gradient(135deg, #ec4899, #be185d)', foto: '/artistas/peso-pluma.jpg' },
                { nombre: 'Christian Nodal', sub: 'Mariacheño', siglas: 'CN', grad: 'linear-gradient(135deg, #06b6d4, #0284c7)', foto: '/artistas/christian-nodal.jpg' },
                { nombre: 'Julión Álvarez', sub: 'Norteño', siglas: 'JA', grad: 'linear-gradient(135deg, #eab308, #ca8a04)', foto: '/artistas/julion-alvarez.jpg' },
                { nombre: 'Bad Bunny', sub: 'Trap Latino', siglas: 'BB', grad: 'linear-gradient(135deg, #f43f5e, #e11d48)', foto: '/artistas/bad-bunny.jpg' },
                { nombre: 'Luis Miguel', sub: 'Pop Latino', siglas: 'LM', grad: 'linear-gradient(135deg, #fbbf24, #f59e0b)', foto: '/artistas/luis-miguel.jpg' },
                { nombre: 'Queen', sub: 'Rock Leyenda', siglas: 'QN', grad: 'linear-gradient(135deg, #6366f1, #4f46e5)', foto: '/artistas/queen.jpg' }
              ].map((art) => (
                <button
                  key={art.nombre}
                  onClick={() => {
                    setTabActiva('buscar');
                    buscarCancionesOnline(art.nombre);
                  }}
                  disabled={buscandoCanciones}
                  className="artist-circle-card"
                  title={`Buscar canciones de ${art.nombre}`}
                >
                  <div className="artist-circle-avatar">
                    <div className="artist-circle-ring" style={{ background: art.grad }} />
                    <div className="artist-circle-inner">
                      <img
                        src={art.foto}
                        alt={art.nombre}
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: 'block'
                        }}
                        onError={(e) => {
                          (e.currentTarget as HTMLElement).style.display = 'none';
                        }}
                        loading="lazy"
              decoding="async"
                      />
                      <span className="artist-monogram" style={{ position: 'absolute', zIndex: 0 }}>
                        {art.siglas}
                      </span>
                    </div>
                  </div>
                  <span style={{
                    fontSize: '11px',
                    fontWeight: '700',
                    color: '#FFFFFF',
                    textAlign: 'center',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    width: '100%'
                  }}>
                    {art.nombre}
                  </span>
                  <span style={{ fontSize: '10px', color: '#94A3B8', marginTop: '-4px' }}>
                    {art.sub}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* SECCIÓN: EXPLORAR GÉNEROS Y ESTADOS DE ÁNIMO */}
          <div style={{ marginBottom: '28px' }}>
            <h2 style={{ fontSize: '18px', fontWeight: '800', color: '#FFFFFF', margin: '0 0 14px 0', letterSpacing: '-0.3px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>🎧</span> Explorar Géneros y Vibras
            </h2>

            <div className="bento-grid">
              {[
                { titulo: 'Regional Mexicano', desc: 'Banda, Norteño y Corridos', fondo: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)', borde: '#fbbf24', query: 'Banda MS exitos' },
                { titulo: 'Corridos Tumbados', desc: 'Bélicos y Acústicos', fondo: 'linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%)', borde: '#a78bfa', query: 'Corridos Tumbados 2024' },
                { titulo: 'Banda Sinaloense', desc: 'Puras de fiesta', fondo: 'linear-gradient(135deg, #059669 0%, #047857 100%)', borde: '#34d399', query: 'Banda Sinaloense exitos' },
                { titulo: 'Reggaetón & Trap', desc: 'Perreo y flow latino', fondo: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)', borde: '#fb923c', query: 'Reggaeton exitos' },
                { titulo: 'Rock Clásicos', desc: 'En español e inglés', fondo: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)', borde: '#38bdf8', query: 'Rock clasicos exitos' },
                { titulo: 'Baladas Románticas', desc: 'Para dedicar y cantar', fondo: 'linear-gradient(135deg, #e11d48 0%, #9f1239 100%)', borde: '#fb7185', query: 'Baladas romanticas en espanol' }
              ].map((bento) => (
                <div
                  key={bento.titulo}
                  className="bento-card"
                  style={{
                    background: bento.fondo,
                    border: `1px solid ${bento.borde}66`,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.45)'
                  }}
                  onClick={() => {
                    setTabActiva('buscar');
                    buscarCancionesOnline(bento.query);
                  }}
                  title={`Buscar ${bento.titulo}`}
                >
                  <div>
                    <h3 style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: '800', color: '#FFFFFF', textShadow: '0 2px 4px rgba(0,0,0,0.4)' }}>
                      {bento.titulo}
                    </h3>
                    <p style={{ margin: 0, fontSize: '11px', color: 'rgba(255, 255, 255, 0.9)', fontWeight: '500' }}>
                      {bento.desc}
                    </p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                    <span style={{ fontSize: '10px', color: '#FFFFFF', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.6px', background: 'rgba(0,0,0,0.25)', padding: '2px 8px', borderRadius: '12px' }}>
                      Explorar
                    </span>
                    <div className="soundwave-bars active" style={{ height: '12px' }}>
                      <span className="soundwave-bar bar-1" style={{ backgroundColor: '#FFFFFF' }} />
                      <span className="soundwave-bar bar-2" style={{ backgroundColor: '#FFFFFF' }} />
                      <span className="soundwave-bar bar-3" style={{ backgroundColor: '#FFFFFF' }} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* BANNER PARA CREAR PLAYLIST */}
          <div style={{
            backgroundColor: 'rgba(30, 215, 96, 0.1)',
            border: '1px solid rgba(30, 215, 96, 0.3)',
            borderRadius: '16px',
            padding: '18px 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: '14px',
            marginBottom: '20px'
          }}>
            <div>
              <h3 style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: '800', color: '#FFFFFF' }}>
                Crea tu propia Playlist 📁
              </h3>
              <p style={{ margin: 0, fontSize: '12px', color: '#B3B3B3' }}>
                Selecciona tus canciones favoritas de la biblioteca y organízalas como quieras.
              </p>
            </div>
            <button
              onClick={() => {
                setCancionParaPlaylist(null);
                setCancionesSeleccionadasPlaylist([]);
                setFiltroCancionModalPlaylist('');
                setModalPlaylistAbierto(true);
              }}
              style={{
                backgroundColor: '#1ED760',
                color: '#000000',
                fontWeight: '800',
                border: 'none',
                borderRadius: '500px',
                padding: '9px 18px',
                fontSize: '12.5px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <span>+ Crear Playlist</span>
            </button>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* VISTA 1: BUSCAR Y DESCARGAR (SPOTIFY STYLE) */}
      {/* ========================================================================= */}
      {tabActiva === 'buscar' && (
        <div
          className="contenedor-vista-buscar vista-tab-content"
          style={{
            padding: '24px 16px',
            maxWidth: '680px',
            margin: '0 auto',
            width: '100%',
            boxSizing: 'border-box',
            position: 'relative',
            zIndex: 10
          }}
        >
          <div style={{ marginBottom: '22px' }}>
            {cancionAReemplazarClave && (
              <div
                style={{
                  marginBottom: '12px',
                  padding: '10px 14px',
                  borderRadius: '12px',
                  backgroundColor: 'rgba(59, 130, 246, 0.16)',
                  border: '1px solid rgba(59, 130, 246, 0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px'
                }}
              >
                <span style={{ fontSize: '12px', color: '#93C5FD', fontWeight: 700 }}>
                  Reemplazando versión de: "{cancionAReemplazarClave}"
                </span>
                <button
                  onClick={() => setCancionAReemplazarClave(null)}
                  style={{
                    backgroundColor: 'transparent',
                    border: '1px solid rgba(147, 197, 253, 0.45)',
                    color: '#93C5FD',
                    borderRadius: '999px',
                    padding: '4px 10px',
                    fontSize: '11px',
                    fontWeight: 700,
                    cursor: 'pointer'
                  }}
                >
                  Cancelar
                </button>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '8px' }}>
              <span className="hero-subtitle-badge">
                <span>⚡ SPOTIFY PRO SEARCH</span>
                <span>•</span>
                <span>MP3 320 KBPS</span>
              </span>
              <span style={{ fontSize: '12px', color: '#1ed760', fontWeight: '700' }}>
                Offline Ready 📥
              </span>
            </div>
            <h1 className="hero-gradient-text" style={{ fontSize: '32px', fontWeight: '900', margin: '0 0 6px 0', letterSpacing: '-0.8px' }}>
              Buscar y Descargar
            </h1>
            <p style={{ margin: '0 0 12px 0', fontSize: '13px', color: '#B3B3B3', lineHeight: '1.4' }}>
              Busca por grupo, artista o canción, escucha las opciones y descarga tu música favorita.
            </p>
            <button
              onClick={() => setModalSpotifyAbierto(true)}
              style={{
                background: 'linear-gradient(135deg, #1ED760 0%, #10b981 100%)',
                color: '#000000',
                fontWeight: '900',
                border: 'none',
                borderRadius: '500px',
                padding: '10px 18px',
                fontSize: '13px',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                boxShadow: '0 6px 20px rgba(30, 215, 96, 0.35)',
                transition: 'transform 0.15s ease'
              }}
              onMouseEnter={(e) => { e.currentTarget.style.transform = 'scale(1.03)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
            >
              <span>🟢 Importar Playlist de Spotify</span>
            </button>
          </div>

          {/* Barra de búsqueda interactiva */}
          <div className="barra-busqueda-input-box" style={{
            display: 'flex',
            alignItems: 'center',
            backgroundColor: 'rgba(36, 36, 38, 0.75)',
            backdropFilter: 'blur(16px)',
            WebkitBackdropFilter: 'blur(16px)',
            borderRadius: '500px',
            border: buscandoCanciones ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.15)',
            padding: '4px 6px 4px 16px',
            gap: '12px',
            marginBottom: '20px',
            position: 'relative',
            boxShadow: buscandoCanciones
              ? '0 8px 30px rgba(30, 215, 96, 0.28), 0 0 20px rgba(30, 215, 96, 0.15)'
              : '0 8px 25px rgba(0,0,0,0.5)',
            transition: 'border-color 0.2s ease, box-shadow 0.2s ease'
          }}>
            <IconBuscar size={20} color={buscandoCanciones ? '#1ED760' : '#1ED760'} />
            <input
              type="text"
              placeholder="¿Qué quieres escuchar hoy? (ej. Banda MS, Carin León, No se va...)"
              value={busquedaWeb}
              onFocus={() => setSugerenciasVisibles(true)}
              onChange={(e) => {
                setBusquedaWeb(e.target.value);
                setSugerenciasVisibles(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  setSugerenciasVisibles(false);
                  buscarCancionesOnline();
                } else if (e.key === 'Escape') {
                  setSugerenciasVisibles(false);
                }
              }}
              disabled={buscandoCanciones || descargando}
              style={{
                flex: 1,
                border: 'none',
                backgroundColor: 'transparent',
                color: '#FFFFFF',
                fontSize: '14px',
                outline: 'none',
                padding: '11px 0'
              }}
            />
            {busquedaWeb && !buscandoCanciones && !descargando && (
              <button
                onClick={() => {
                  setBusquedaWeb('');
                  setResultadosBusqueda([]);
                  setTerminoBuscado('');
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '4px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  color: '#B3B3B3'
                }}
                title="Limpiar búsqueda"
              >
                <IconLimpiar size={18} />
              </button>
            )}
            <button
              onClick={() => buscarCancionesOnline()}
              disabled={buscandoCanciones || !busquedaWeb.trim()}
              style={{
                padding: '10px 22px',
                backgroundColor: buscandoCanciones ? '#15803d' : '#1ED760',
                color: '#000000',
                fontWeight: '700',
                border: 'none',
                borderRadius: '500px',
                cursor: buscandoCanciones || !busquedaWeb.trim() ? 'not-allowed' : 'pointer',
                fontSize: '13px',
                letterSpacing: '-0.2px',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
                transition: 'transform 0.15s ease, background-color 0.15s ease'
              }}
              onMouseEnter={(e) => {
                if (!buscandoCanciones && busquedaWeb.trim()) {
                  e.currentTarget.style.backgroundColor = '#1fdf64';
                  e.currentTarget.style.transform = 'scale(1.03)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor = buscandoCanciones ? '#15803d' : '#1ED760';
                e.currentTarget.style.transform = 'scale(1)';
              }}
            >
              {buscandoCanciones ? (
                <>
                  <IconSpinner size={16} color="#000000" />
                  <span>Buscando...</span>
                </>
              ) : (
                <>
                  <IconBuscar size={16} color="#000000" />
                  <span>Buscar</span>
                </>
              )}
            </button>

            {/* Desplegable reactivo de sugerencias instantáneas con Debounce */}
            <SearchSuggestions
              busqueda={busquedaWeb}
              visible={sugerenciasVisibles}
              onSeleccionarTexto={alSeleccionarTextoBusqueda}
              onSeleccionarPista={alSeleccionarPistaBusqueda}
              onCerrar={alCerrarSugerencias}
            />
          </div>

          {/* Banner de descarga en curso */}
          {descargando && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              backgroundColor: 'rgba(30, 215, 96, 0.12)',
              border: '1px solid rgba(30, 215, 96, 0.35)',
              borderRadius: '12px',
              padding: '12px 16px',
              marginBottom: '16px'
            }}>
              <IconSpinner size={20} color="#1ED760" />
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#FFFFFF' }}>
                  {textoDescarga || 'Descargando audio a tu biblioteca...'}
                </p>
                <p style={{ margin: '2px 0 0 0', fontSize: '11px', color: '#B3B3B3' }}>
                  Guardando en almacenamiento local para reproducir sin conexión
                </p>
              </div>
            </div>
          )}

          {/* Estado: Buscando */}
          {buscandoCanciones && (
            <div style={{
              textAlign: 'center',
              padding: '40px 20px',
              backgroundColor: '#181818',
              borderRadius: '16px',
              border: '1px solid #282828'
            }}>
              <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '14px' }}>
                <IconSpinner size={36} color="#1ED760" />
              </div>
              <h3 style={{ margin: '0 0 6px 0', fontSize: '16px', fontWeight: '700', color: '#FFFFFF' }}>
                Buscando opciones en internet...
              </h3>
              <p style={{ margin: 0, fontSize: '13px', color: '#B3B3B3' }}>
                Consultando canciones y grupos para "{terminoBuscado}"
              </p>
            </div>
          )}

          {/* Lista de resultados encontrados */}
          {!buscandoCanciones && resultadosBusqueda.length > 0 && (
            <div style={{ marginTop: '20px' }}>
              {/* Barra superior de resultados */}
              <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '14px',
                flexWrap: 'wrap',
                gap: '10px'
              }}>
                <div>
                  <h2 style={{ margin: 0, fontSize: '18px', fontWeight: '700', color: '#FFFFFF' }}>
                    Opciones encontradas ({resultadosBusqueda.length})
                  </h2>
                  <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: '#B3B3B3' }}>
                    Para: <span style={{ color: '#1ED760', fontWeight: '600' }}>"{terminoBuscado}"</span> • Elige cuáles descargar
                  </p>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {seleccionadosDescarga.length > 0 && (
                    <button
                      onClick={descargarSeleccionadas}
                      disabled={descargando}
                      style={{
                        padding: '8px 16px',
                        backgroundColor: '#1ED760',
                        color: '#000000',
                        fontWeight: '700',
                        border: 'none',
                        borderRadius: '500px',
                        fontSize: '12px',
                        cursor: descargando ? 'not-allowed' : 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                      }}
                    >
                      <IconDescargar size={14} color="#000000" />
                      <span>Descargar ({seleccionadosDescarga.length})</span>
                    </button>
                  )}

                  <button
                    onClick={() => {
                      if (seleccionadosDescarga.length === resultadosBusqueda.length) {
                        setSeleccionadosDescarga([]);
                      } else {
                        // Seleccionar solo las que no están ya descargadas
                        const noDescargadas = resultadosBusqueda
                          .filter((r) => !biblioteca.some((b) => b.nombre.toLowerCase() === r.title.toLowerCase()))
                          .map((r) => r.videoId);
                        setSeleccionadosDescarga(noDescargadas);
                      }
                    }}
                    style={{
                      background: 'none',
                      border: '1px solid #333333',
                      color: '#B3B3B3',
                      borderRadius: '500px',
                      padding: '6px 12px',
                      fontSize: '12px',
                      cursor: 'pointer'
                    }}
                  >
                    {seleccionadosDescarga.length === resultadosBusqueda.length ? 'Deseleccionar' : 'Seleccionar todas'}
                  </button>
                </div>
              </div>

              {/* Barra flotante de vista previa en vivo */}
              {previewActivo && (
                <div
                  style={{
                    backgroundColor: '#181818',
                    border: '1px solid #1ED760',
                    borderRadius: '12px',
                    padding: '12px 14px',
                    boxShadow: '0 8px 30px rgba(0,0,0,0.6)',
                    marginBottom: '14px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '8px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                      <div style={{
                        width: '40px',
                        height: '40px',
                        borderRadius: '6px',
                        overflow: 'hidden',
                        backgroundColor: '#282828',
                        flexShrink: 0
                      }}>
                        {previewActivo.thumbnail ? (
                          <img src={previewActivo.thumbnail} alt={previewActivo.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          <IconNota size={18} color="#1ED760" />
                        )}
                      </div>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span style={{ fontSize: '10px', fontWeight: '800', backgroundColor: '#1ED760', color: '#000000', padding: '2px 6px', borderRadius: '4px', textTransform: 'uppercase' }}>
                            🎧 Previa
                          </span>
                          <span style={{ fontSize: '11px', color: '#1ED760', fontWeight: '600' }}>
                            {previewActivo.cargando ? 'Cargando stream...' : previewActivo.reproduciendo ? 'Reproduciendo' : 'Pausado'}
                          </span>
                        </div>
                        <p style={{ margin: '2px 0 0 0', fontSize: '13px', fontWeight: '700', color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {previewActivo.title}
                        </p>
                        <p style={{ margin: 0, fontSize: '11px', color: '#B3B3B3', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {previewActivo.artist}
                        </p>
                      </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                      <button
                        onClick={() => {
                          if (audioPreviewRef.current) {
                            if (previewActivo.reproduciendo) {
                              audioPreviewRef.current.pause();
                              setPreviewActivo(p => p ? { ...p, reproduciendo: false } : null);
                            } else {
                              audioPreviewRef.current.play().catch(console.warn);
                              setPreviewActivo(p => p ? { ...p, reproduciendo: true } : null);
                            }
                          }
                        }}
                        disabled={previewActivo.cargando}
                        style={{
                          width: '34px',
                          height: '34px',
                          borderRadius: '50%',
                          backgroundColor: '#FFFFFF',
                          border: 'none',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          cursor: 'pointer'
                        }}
                        title={previewActivo.reproduciendo ? 'Pausar' : 'Reanudar'}
                      >
                        {previewActivo.cargando ? (
                          <IconSpinner size={15} color="#000000" />
                        ) : previewActivo.reproduciendo ? (
                          <IconPausa size={15} color="#000000" />
                        ) : (
                          <IconPlay size={15} color="#000000" />
                        )}
                      </button>

                      <button
                        onClick={() => abrirSelectorFormatos(previewActivo.itemOriginal)}
                        style={{
                          padding: '6px 12px',
                          backgroundColor: '#1ED760',
                          color: '#000000',
                          fontWeight: '700',
                          border: 'none',
                          borderRadius: '500px',
                          fontSize: '11.5px',
                          cursor: 'pointer',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '5px'
                        }}
                        title="Descargar esta versión"
                      >
                        <IconDescargar size={13} color="#000000" />
                        <span>Descargar</span>
                      </button>

                      <button
                        onClick={detenerPreview}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: '#888888',
                          cursor: 'pointer',
                          padding: '6px',
                          fontSize: '16px'
                        }}
                        title="Cerrar vista previa"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* Barra de progreso */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ fontSize: '10px', color: '#888888', minWidth: '28px' }}>
                      {formatearTiempo(previewActivo.tiempo)}
                    </span>
                    <div
                      onClick={(e) => {
                        if (!audioPreviewRef.current || !previewActivo.duracion) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        const clickX = e.clientX - rect.left;
                        const ratio = Math.max(0, Math.min(1, clickX / rect.width));
                        const nuevoTiempo = ratio * previewActivo.duracion;
                        audioPreviewRef.current.currentTime = nuevoTiempo;
                        setPreviewActivo(p => p ? { ...p, tiempo: nuevoTiempo } : null);
                      }}
                      style={{
                        flex: 1,
                        height: '4px',
                        backgroundColor: '#333333',
                        borderRadius: '2px',
                        cursor: 'pointer',
                        position: 'relative'
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.min(100, ((previewActivo.tiempo || 0) / (previewActivo.duracion || 1)) * 100)}%`,
                          height: '100%',
                          backgroundColor: '#1ED760',
                          borderRadius: '2px'
                        }}
                      />
                    </div>
                    <span style={{ fontSize: '10px', color: '#888888', minWidth: '28px', textAlign: 'right' }}>
                      {formatearTiempo(previewActivo.duracion)}
                    </span>
                  </div>
                </div>
              )}

              {/* Lista virtualizada de resultados de búsqueda (60 FPS constantes) */}
              <div className="grid-resultados-busqueda" style={{ display: 'flex', flexDirection: 'column' }}>
                <VirtualSongList
                  items={resultadosBusqueda}
                  itemHeight={72}
                  overscan={4}
                  scrollContainerRef={mainContentRef}
                  getKey={(item, idx) => item.videoId || `${item.title}-${idx}`}
                  renderItem={(item) => {
                  const yaDescargada = biblioteca.some(
                    (c) => c.nombre.toLowerCase() === item.title.toLowerCase()
                  );
                  const estaDescargandoEsta = descargandoId === item.videoId;
                  const cancionEnBiblioteca = biblioteca.find(
                    (c) => c.nombre.toLowerCase() === item.title.toLowerCase()
                  );
                  const estaSeleccionada = seleccionadosDescarga.includes(item.videoId);
                  const estaEnPreview = previewActivo?.videoId === item.videoId;
                  const estaCargandoPreview = estaEnPreview && previewActivo?.cargando;

                  return (
                    <div
                      className="song-row"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                        height: '66px',
                        boxSizing: 'border-box',
                        backgroundColor: '#181818',
                        borderRadius: '10px',
                        border: estaEnPreview
                          ? '1px solid #1ED760'
                          : estaSeleccionada
                          ? '1px solid #1ED760'
                          : yaDescargada
                          ? '1px solid rgba(30, 215, 96, 0.25)'
                          : '1px solid #282828',
                        gap: '12px'
                      }}
                    >
                      {/* Checkbox para selección múltiple */}
                      {!yaDescargada && (
                        <input
                          type="checkbox"
                          checked={estaSeleccionada}
                          onChange={() => alternarSeleccionDescarga(item.videoId)}
                          style={{
                            cursor: 'pointer',
                            accentColor: '#1ED760',
                            width: '16px',
                            height: '16px',
                            flexShrink: 0
                          }}
                          title="Seleccionar para descargar"
                        />
                      )}

                      {/* Miniatura / Carátula de la canción con botón de reproducción interactivo */}
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          alternarPreview(item);
                        }}
                        style={{
                          width: '48px',
                          height: '48px',
                          borderRadius: '6px',
                          overflow: 'hidden',
                          backgroundColor: '#282828',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0,
                          position: 'relative',
                          cursor: 'pointer'
                        }}
                        title="Toca para escuchar antes de descargar"
                      >
                        {item.thumbnail ? (
                          <img
                            src={item.thumbnail}
                            alt={item.title}
                            width={48}
                            height={48}
                            loading="lazy"
                            decoding="async"
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            onError={(e) => {
                              // Si falla la carga de imagen externa
                              e.currentTarget.style.display = 'none';
                            }}
                          />
                        ) : (
                          <IconNota size={20} color="#1ED760" />
                        )}
                        <div
                          style={{
                            position: 'absolute',
                            inset: 0,
                            backgroundColor: estaEnPreview
                              ? 'rgba(0,0,0,0.65)'
                              : 'rgba(0,0,0,0.3)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            transition: 'background-color 0.15s ease'
                          }}
                        >
                          {estaCargandoPreview ? (
                            <IconSpinner size={16} color="#1ED760" />
                          ) : estaEnPreview && previewActivo?.reproduciendo ? (
                            <IconPausa size={16} color="#1ED760" />
                          ) : (
                            <IconPlay size={16} color="#FFFFFF" />
                          )}
                        </div>
                      </div>

                      {/* Información: Título, Artista y Duración */}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <p style={{
                          margin: 0,
                          fontSize: '14px',
                          fontWeight: '700',
                          color: '#FFFFFF',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }} title={item.title}>
                          {item.title}
                        </p>
                        <p style={{
                          margin: '3px 0 0 0',
                          fontSize: '12px',
                          color: '#B3B3B3',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap'
                        }}>
                          {item.author || item.artist || 'Autor desconocido'} • <span style={{ color: '#888' }}>⏱ {item.timestamp}</span>
                          {item.license && (
                            <span style={{ color: '#6EE7B7', marginLeft: '6px' }}>• {item.license}</span>
                          )}
                        </p>
                      </div>

                      {/* Acciones: Descargar / En Biblioteca / Reproducir */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        {estaDescargandoEsta ? (
                          <div style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px',
                            padding: '6px 12px',
                            backgroundColor: 'rgba(30, 215, 96, 0.15)',
                            border: '1px solid #1ED760',
                            borderRadius: '500px',
                            fontSize: '12px',
                            fontWeight: '600',
                            color: '#1ED760'
                          }}>
                            <IconSpinner size={14} color="#1ED760" />
                            <span>Bajando...</span>
                          </div>
                        ) : yaDescargada ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                            <span style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '5px 10px',
                              backgroundColor: 'rgba(30, 215, 96, 0.12)',
                              border: '1px solid rgba(30, 215, 96, 0.3)',
                              borderRadius: '500px',
                              fontSize: '11px',
                              fontWeight: '600',
                              color: '#1ED760'
                            }}>
                              <IconCheck size={13} color="#1ED760" />
                              <span>Guardada</span>
                            </span>
                            {cancionEnBiblioteca && (
                              <>
                                <button
                                  onClick={() => reproducirCancion(cancionEnBiblioteca)}
                                  style={{
                                    padding: '6px 10px',
                                    backgroundColor: '#282828',
                                    color: '#FFFFFF',
                                    border: '1px solid #333',
                                    borderRadius: '500px',
                                    cursor: 'pointer',
                                    fontSize: '11px',
                                    fontWeight: '600',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '4px'
                                  }}
                                  title="Escuchar ahora"
                                >
                                  <IconPlay size={11} color="#1ED760" />
                                  <span>Tocar</span>
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    agregarACola(cancionEnBiblioteca);
                                  }}
                                  style={{
                                    padding: '6px 10px',
                                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                                    color: '#E4E4E7',
                                    border: '1px solid rgba(255, 255, 255, 0.14)',
                                    borderRadius: '500px',
                                    cursor: 'pointer',
                                    fontSize: '11px',
                                    fontWeight: '600',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '4px'
                                  }}
                                  title="Agregar a la cola de reproducción"
                                >
                                  <IconCola size={12} color="#1ED760" />
                                  <span>+ Cola</span>
                                </button>
                              </>
                            )}
                          </div>
                        ) : (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            {/* Botón de Escuchar Vista Previa / Streaming */}
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                alternarPreview(item);
                              }}
                              style={{
                                padding: '7px 11px',
                                backgroundColor: estaEnPreview ? '#1ED760' : 'rgba(255, 255, 255, 0.08)',
                                color: estaEnPreview ? '#000000' : '#E4E4E7',
                                border: estaEnPreview ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.14)',
                                borderRadius: '500px',
                                cursor: 'pointer',
                                fontSize: '11.5px',
                                fontWeight: '700',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                transition: 'all 0.15s ease'
                              }}
                              title={estaEnPreview && previewActivo?.reproduciendo ? 'Pausar vista previa' : 'Escuchar antes de descargar'}
                            >
                              {estaCargandoPreview ? (
                                <span>⏳ Cargando audio...</span>
                              ) : estaEnPreview && previewActivo?.reproduciendo ? (
                                <span>⏸ Pausar</span>
                              ) : (
                                <span>▶ Escuchar</span>
                              )}
                            </button>

                            <button
                              onClick={() => abrirSelectorFormatos(item)}
                              disabled={descargando}
                              style={{
                                padding: '7px 14px',
                                backgroundColor: descargando ? '#282828' : '#1ED760',
                                color: descargando ? '#888' : '#000000',
                                fontWeight: '700',
                                border: 'none',
                                borderRadius: '500px',
                                cursor: descargando ? 'not-allowed' : 'pointer',
                                fontSize: '12px',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '5px',
                                transition: 'transform 0.1s ease, background-color 0.1s ease'
                              }}
                              onMouseEnter={(e) => {
                                if (!descargando) e.currentTarget.style.transform = 'scale(1.05)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.transform = 'scale(1)';
                              }}
                              title={`Descargar "${item.title}"`}
                            >
                              <IconDescargar size={14} color={descargando ? '#888' : '#000000'} />
                              <span>Descargar</span>
                            </button>
                            <button
                              onClick={(e) => agregarItemBusquedaACola(item, e)}
                              style={{
                                padding: '7px 10px',
                                backgroundColor: 'rgba(255, 255, 255, 0.08)',
                                color: '#E4E4E7',
                                border: '1px solid rgba(255, 255, 255, 0.14)',
                                borderRadius: '500px',
                                cursor: 'pointer',
                                fontSize: '11px',
                                fontWeight: '600',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '4px',
                                transition: 'background-color 0.15s ease'
                              }}
                              title="Agregar a la cola de reproducción"
                            >
                              <IconCola size={12} color="#1ED760" />
                              <span>+ Cola</span>
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                }}
                />
              </div>
            </div>
          )}

          {/* Sugerencias de Grupos, Géneros y Canciones cuando no hay búsqueda activa */}
          {!buscandoCanciones && resultadosBusqueda.length === 0 && (
            <div style={{ marginTop: '10px' }}>
              
              {/* SECCIÓN 1: ARTISTAS DESTACADOS CON ANILLO LUMINOSO */}
              <div style={{ marginBottom: '28px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
                  <h2 style={{ fontSize: '16px', fontWeight: '800', color: '#FFFFFF', margin: 0, letterSpacing: '-0.3px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>⭐</span> Artistas Populares
                  </h2>
                  <span style={{ fontSize: '11px', color: '#1ed760', fontWeight: '700' }}>Toca para buscar</span>
                </div>

                <div className="artist-scroll-row">
                  {[
                    { nombre: 'Banda MS', sub: 'Banda', siglas: 'MS', grad: 'linear-gradient(135deg, #10b981, #059669)', foto: '/artistas/banda-ms.jpg' },
                    { nombre: 'Grupo Frontera', sub: 'Norteño', siglas: 'GF', grad: 'linear-gradient(135deg, #f59e0b, #d97706)', foto: '/artistas/grupo-frontera.jpg' },
                    { nombre: 'Carin León', sub: 'Regional', siglas: 'CL', grad: 'linear-gradient(135deg, #ea580c, #c2410c)', foto: '/artistas/carin-leon.jpg' },
                    { nombre: 'Natanael Cano', sub: 'Corridos', siglas: 'NC', grad: 'linear-gradient(135deg, #8b5cf6, #6d28d9)', foto: '/artistas/natanael-cano.jpg' },
                    { nombre: 'Peso Pluma', sub: 'Tumbados', siglas: 'PP', grad: 'linear-gradient(135deg, #ec4899, #be185d)', foto: '/artistas/peso-pluma.jpg' },
                    { nombre: 'Christian Nodal', sub: 'Mariacheño', siglas: 'CN', grad: 'linear-gradient(135deg, #06b6d4, #0284c7)', foto: '/artistas/christian-nodal.jpg' },
                    { nombre: 'Julión Álvarez', sub: 'Norteño', siglas: 'JA', grad: 'linear-gradient(135deg, #eab308, #ca8a04)', foto: '/artistas/julion-alvarez.jpg' },
                    { nombre: 'Bad Bunny', sub: 'Trap Latino', siglas: 'BB', grad: 'linear-gradient(135deg, #f43f5e, #e11d48)', foto: '/artistas/bad-bunny.jpg' },
                    { nombre: 'Luis Miguel', sub: 'Pop Latino', siglas: 'LM', grad: 'linear-gradient(135deg, #fbbf24, #f59e0b)', foto: '/artistas/luis-miguel.jpg' },
                    { nombre: 'Queen', sub: 'Rock Leyenda', siglas: 'QN', grad: 'linear-gradient(135deg, #6366f1, #4f46e5)', foto: '/artistas/queen.jpg' }
                  ].map((art) => (
                    <button
                      key={art.nombre}
                      onClick={() => buscarCancionesOnline(art.nombre)}
                      disabled={buscandoCanciones}
                      className="artist-circle-card"
                      title={`Buscar canciones de ${art.nombre}`}
                    >
                      <div className="artist-circle-avatar">
                        <div className="artist-circle-ring" style={{ background: art.grad }} />
                        <div className="artist-circle-inner">
                          <img
                            src={art.foto}
                            alt={art.nombre}
                            loading="lazy"
                            decoding="async"
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: 'cover',
                              display: 'block'
                            }}
                            onError={(e) => {
                              (e.currentTarget as HTMLElement).style.display = 'none';
                            }}
                          />
                          <span className="artist-monogram" style={{ position: 'absolute', zIndex: 0 }}>
                            {art.siglas}
                          </span>
                        </div>
                      </div>
                      <span style={{
                        fontSize: '11px',
                        fontWeight: '700',
                        color: '#FFFFFF',
                        textAlign: 'center',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        width: '100%'
                      }}>
                        {art.nombre}
                      </span>
                      <span style={{ fontSize: '10px', color: '#94A3B8', marginTop: '-4px' }}>
                        {art.sub}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* SECCIÓN 2: BENTO GRID DE GÉNEROS Y VIBES */}
              <div style={{ marginBottom: '28px' }}>
                <h2 style={{ fontSize: '16px', fontWeight: '800', color: '#FFFFFF', margin: '0 0 14px 0', letterSpacing: '-0.3px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>🎧</span> Explorar Géneros y Vibras
                </h2>

                <div className="bento-grid">
                  {[
                    { titulo: 'Regional Mexicano', desc: 'Banda, Norteño y Corridos', fondo: 'linear-gradient(135deg, #d97706 0%, #b45309 100%)', borde: '#fbbf24', query: 'Banda MS exitos' },
                    { titulo: 'Corridos Tumbados', desc: 'Bélicos y Acústicos', fondo: 'linear-gradient(135deg, #7c3aed 0%, #5b21b6 100%)', borde: '#a78bfa', query: 'Corridos Tumbados 2024' },
                    { titulo: 'Banda Sinaloense', desc: 'Puras de fiesta', fondo: 'linear-gradient(135deg, #059669 0%, #047857 100%)', borde: '#34d399', query: 'Banda Sinaloense exitos' },
                    { titulo: 'Reggaetón & Trap', desc: 'Perreo y flow latino', fondo: 'linear-gradient(135deg, #ea580c 0%, #c2410c 100%)', borde: '#fb923c', query: 'Reggaeton exitos' },
                    { titulo: 'Rock Clásicos', desc: 'En español e inglés', fondo: 'linear-gradient(135deg, #0284c7 0%, #0369a1 100%)', borde: '#38bdf8', query: 'Rock clasicos exitos' },
                    { titulo: 'Baladas Románticas', desc: 'Para dedicar y cantar', fondo: 'linear-gradient(135deg, #e11d48 0%, #9f1239 100%)', borde: '#fb7185', query: 'Baladas romanticas en espanol' }
                  ].map((bento) => (
                    <div
                      key={bento.titulo}
                      className="bento-card"
                      style={{
                        background: bento.fondo,
                        border: `1px solid ${bento.borde}66`,
                        boxShadow: '0 8px 24px rgba(0,0,0,0.45)'
                      }}
                      onClick={() => buscarCancionesOnline(bento.query)}
                      title={`Buscar ${bento.titulo}`}
                    >
                      <div>
                        <h3 style={{ margin: '0 0 4px 0', fontSize: '15px', fontWeight: '800', color: '#FFFFFF', textShadow: '0 2px 4px rgba(0,0,0,0.4)' }}>
                          {bento.titulo}
                        </h3>
                        <p style={{ margin: 0, fontSize: '11px', color: 'rgba(255, 255, 255, 0.9)', fontWeight: '500' }}>
                          {bento.desc}
                        </p>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px' }}>
                        <span style={{ fontSize: '10px', color: '#FFFFFF', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.6px', background: 'rgba(0,0,0,0.25)', padding: '2px 8px', borderRadius: '12px' }}>
                          Explorar
                        </span>
                        <div className="soundwave-bars active" style={{ height: '12px' }}>
                          <span className="soundwave-bar bar-1" style={{ backgroundColor: '#FFFFFF' }} />
                          <span className="soundwave-bar bar-2" style={{ backgroundColor: '#FFFFFF' }} />
                          <span className="soundwave-bar bar-3" style={{ backgroundColor: '#FFFFFF' }} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* SECCIÓN 3: CANCIONES SUGERIDAS (TENDENCIAS) */}
              <div style={{ marginBottom: '28px' }}>
                <p style={{ fontSize: '13px', fontWeight: '800', color: '#B3B3B3', margin: '0 0 12px 0', textTransform: 'uppercase', letterSpacing: '0.6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span>🔥</span> Tendencias más buscadas:
                </p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                  {[
                    'El color de tus ojos',
                    'Mi razón de ser',
                    'No se va',
                    'Primera cita',
                    'Madonna Natanael Cano',
                    'Ella baila sola',
                    'Ya te perdí la fe',
                    'La boda del huitlacoche',
                    'Bohemian Rhapsody',
                    'Ahora te puedes marchar'
                  ].map((sug) => (
                    <button
                      key={sug}
                      onClick={() => buscarCancionesOnline(sug)}
                      disabled={buscandoCanciones}
                      style={{
                        padding: '8px 14px',
                        backgroundColor: 'rgba(255, 255, 255, 0.06)',
                        backdropFilter: 'blur(10px)',
                        WebkitBackdropFilter: 'blur(10px)',
                        color: '#FFFFFF',
                        border: '1px solid rgba(255, 255, 255, 0.12)',
                        borderRadius: '500px',
                        fontSize: '12px',
                        fontWeight: '600',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        transition: 'all 0.18s ease'
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.backgroundColor = 'rgba(30, 215, 96, 0.18)';
                        e.currentTarget.style.borderColor = '#1ED760';
                        e.currentTarget.style.transform = 'translateY(-2px)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.06)';
                        e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.12)';
                        e.currentTarget.style.transform = 'translateY(0)';
                      }}
                    >
                      <span style={{ color: '#1ED760', fontSize: '11px' }}>▶</span>
                      <span>{sug}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* SECCIÓN 4: TARJETA DE AYUDA MODERNA GLASS */}
              <div style={{
                backgroundColor: 'rgba(26, 26, 30, 0.7)',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                padding: '18px 20px',
                borderRadius: '16px',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.35)'
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                  <span style={{ fontSize: '18px' }}>💡</span>
                  <h3 style={{ fontSize: '14px', fontWeight: '800', color: '#FFFFFF', margin: 0 }}>
                    ¿Cómo funciona el buscador inteligente?
                  </h3>
                </div>
                <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '12px', color: '#B3B3B3', lineHeight: '1.6' }}>
                  <li>
                    <strong>Por grupo/artista:</strong> Escribe ej. <em>"Banda MS"</em> para ver y descargar sus mejores éxitos.
                  </li>
                  <li>
                    <strong>Por canción:</strong> Escribe ej. <em>"El color de tus ojos"</em> para ver versiones y elegir tu favorita.
                  </li>
                  <li>
                    <strong>Música offline:</strong> Cada audio se guarda en tu memoria local con carátula oficial en alta fidelidad.
                  </li>
                </ul>
              </div>

            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* VISTA 2: TU BIBLIOTECA (SPOTIFY STYLE) */}
      {/* ========================================================================= */}
      {tabActiva === 'biblioteca' && (
        <div
          className="vista-tab-content"
          style={{
            padding: '24px 16px',
            maxWidth: '680px',
            margin: '0 auto',
            width: '100%',
            boxSizing: 'border-box',
            position: 'relative',
            zIndex: 10
          }}
        >
          
          {/* Cabecera Hero con Badge de Biblioteca */}
          <div style={{ marginBottom: '22px' }}>
            {cancionAReemplazarClave && (
              <div
                style={{
                  marginBottom: '12px',
                  padding: '10px 14px',
                  borderRadius: '12px',
                  backgroundColor: 'rgba(59, 130, 246, 0.16)',
                  border: '1px solid rgba(59, 130, 246, 0.4)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px'
                }}
              >
                <span style={{ fontSize: '12px', color: '#93C5FD', fontWeight: 700 }}>
                  Reemplazando versión de: "{cancionAReemplazarClave}"
                </span>
                <button
                  onClick={() => setCancionAReemplazarClave(null)}
                  style={{
                    backgroundColor: 'transparent',
                    border: '1px solid rgba(147, 197, 253, 0.45)',
                    color: '#93C5FD',
                    borderRadius: '999px',
                    padding: '4px 10px',
                    fontSize: '11px',
                    fontWeight: 700,
                    cursor: 'pointer'
                  }}
                >
                  Cancelar
                </button>
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', marginBottom: '8px' }}>
              <span className="hero-subtitle-badge">
                <span>📁 COLECCIÓN LOCAL</span>
                <span>•</span>
                <span>{biblioteca.length} CANCIONES</span>
              </span>
              <span style={{ fontSize: '12px', color: '#1ed760', fontWeight: '700' }}>
                {filtroBiblioteca === 'favoritas' ? '⭐ Favoritas' : playlistSeleccionada ? `🎵 ${playlistSeleccionada.nombre}` : 'Offline Ready 📥'}
              </span>
            </div>
            
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px', marginBottom: '6px' }}>
              <h1 className="hero-gradient-text" style={{ fontSize: '32px', fontWeight: '900', margin: 0, letterSpacing: '-0.8px' }}>
                Tu Biblioteca
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <input
                  ref={inputImportarMusicaRef}
                  type="file"
                  multiple
                  accept=".mp3,.m4a,.flac,.ogg,.wav,audio/*"
                  onChange={manejarImportarMusicaPropia}
                  style={{ display: 'none' }}
                />
                <button
                  onClick={() => inputImportarMusicaRef.current?.click()}
                  disabled={importandoMusicaPropia}
                  title="Importar MP3, M4A, FLAC, OGG o WAV desde tu teléfono"
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.1)',
                    color: '#FFFFFF',
                    border: '1px solid rgba(255, 255, 255, 0.2)',
                    borderRadius: '500px',
                    padding: '8px 14px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: importandoMusicaPropia ? 'wait' : 'pointer',
                    whiteSpace: 'nowrap'
                  }}
                >
                  {importandoMusicaPropia ? 'Importando...' : 'Importar música desde mi teléfono'}
                </button>
                <button
                  onClick={activarModoDJ}
                  title="Modo DJ: Mezcla aleatoria continua con Crossfade"
                  style={{
                    backgroundColor: modoAleatorio && crossfadeSegundos > 0 ? '#1ED760' : 'rgba(255, 255, 255, 0.08)',
                    color: modoAleatorio && crossfadeSegundos > 0 ? '#000000' : '#FFFFFF',
                    border: modoAleatorio && crossfadeSegundos > 0 ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.16)',
                    borderRadius: '500px',
                    padding: '8px 16px',
                    fontSize: '13px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
                    transition: 'all 0.18s ease'
                  }}
                >
                  <IconMix size={15} color={modoAleatorio && crossfadeSegundos > 0 ? '#000000' : '#1ED760'} />
                  <span>Modo DJ</span>
                </button>

                <button
                  onClick={descargarTodasLasCancionesMp3}
                  disabled={procesandoRespaldo || biblioteca.length === 0}
                  title="Exportar canciones descargadas por la app a archivos MP3 en el dispositivo"
                  style={{
                    backgroundColor: 'rgba(30, 215, 96, 0.14)',
                    color: '#1ED760',
                    border: '1px solid rgba(30, 215, 96, 0.45)',
                    borderRadius: '500px',
                    padding: '8px 16px',
                    fontSize: '13px',
                    fontWeight: '700',
                    cursor: biblioteca.length === 0 ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
                    transition: 'all 0.18s ease'
                  }}
                >
                  <IconDescargar size={15} color="#1ED760" />
                  <span>
                    {procesandoRespaldo
                      ? 'Exportando...'
                      : (cancionesPendientesExportar.length > 0
                        ? `Exportar Descargas (${cancionesPendientesExportar.length})`
                        : 'Descargas Al Día (.mp3)')}
                  </span>
                </button>

                <button
                  onClick={repararBibliotecaOficial}
                  disabled={reparandoBiblioteca || biblioteca.length === 0}
                  title="Reemplazar pistas de Tu Biblioteca con versiones oficiales de estudio desde YouTube Music (DDEX)"
                  style={{
                    backgroundColor: reparandoBiblioteca ? 'rgba(30, 215, 96, 0.28)' : 'rgba(245, 158, 11, 0.14)',
                    color: '#FCD34D',
                    border: '1px solid rgba(245, 158, 11, 0.45)',
                    borderRadius: '500px',
                    padding: '8px 16px',
                    fontSize: '13px',
                    fontWeight: '700',
                    cursor: reparandoBiblioteca || biblioteca.length === 0 ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    transition: 'all 0.18s ease'
                  }}
                >
                  <span>{reparandoBiblioteca ? '⏳ Reparando...' : '✨ Reparar Biblioteca'}</span>
                </button>

                <button
                  onClick={() => {
                    setCancionParaPlaylist(null);
                    setModalPlaylistAbierto(true);
                  }}
                  style={{
                    backgroundColor: 'rgba(255, 255, 255, 0.08)',
                    color: '#FFFFFF',
                    border: '1px solid rgba(255, 255, 255, 0.16)',
                    borderRadius: '500px',
                    padding: '8px 16px',
                    fontSize: '13px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backdropFilter: 'blur(10px)',
                    WebkitBackdropFilter: 'blur(10px)',
                    transition: 'all 0.18s ease'
                  }}
                >
                  <span style={{ fontSize: '15px', lineHeight: 1 }}>+</span>
                  <span>Playlist</span>
                </button>
              </div>
            </div>
            <p style={{ margin: 0, fontSize: '13px', color: '#B3B3B3', lineHeight: '1.4' }}>
              Toda tu música descargada disponible sin internet, listas y mezclas personalizadas.
            </p>
            {importandoMusicaPropia && progresoImportacion && (
              <div
                style={{
                  marginTop: '12px',
                  padding: '10px 12px',
                  borderRadius: '10px',
                  backgroundColor: 'rgba(30, 215, 96, 0.12)',
                  border: '1px solid rgba(30, 215, 96, 0.35)'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#FFFFFF', fontWeight: 700, marginBottom: '6px' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '72%' }}>
                    Importando: {progresoImportacion.archivo}
                  </span>
                  <span>
                    {progresoImportacion.actual} / {progresoImportacion.total}
                  </span>
                </div>
                <div style={{ width: '100%', height: '6px', backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: '999px', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${progresoImportacion.total > 0 ? Math.round((progresoImportacion.actual / progresoImportacion.total) * 100) : 0}%`,
                      height: '100%',
                      backgroundColor: '#1ED760',
                      transition: 'width 0.2s ease'
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Chips de Filtros Estilo Spotify Pro */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', overflowX: 'auto', paddingBottom: '4px' }}>
            <button
              onClick={() => {
                setPlaylistSeleccionada(null);
                setFiltroBiblioteca('todas');
              }}
              style={{
                backgroundColor: filtroBiblioteca === 'todas' && !playlistSeleccionada ? '#FFFFFF' : 'rgba(255, 255, 255, 0.08)',
                color: filtroBiblioteca === 'todas' && !playlistSeleccionada ? '#000000' : '#FFFFFF',
                border: filtroBiblioteca === 'todas' && !playlistSeleccionada ? '1px solid #FFFFFF' : '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: '500px',
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: '700',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'all 0.15s ease'
              }}
            >
              Todas ({biblioteca.length})
            </button>

            <button
              onClick={() => {
                setPlaylistSeleccionada(null);
                setFiltroBiblioteca('favoritas');
              }}
              style={{
                backgroundColor: filtroBiblioteca === 'favoritas' && !playlistSeleccionada ? '#FFFFFF' : 'rgba(255, 255, 255, 0.08)',
                color: filtroBiblioteca === 'favoritas' && !playlistSeleccionada ? '#000000' : '#FFFFFF',
                border: filtroBiblioteca === 'favoritas' && !playlistSeleccionada ? '1px solid #FFFFFF' : '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: '500px',
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: '700',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'all 0.15s ease'
              }}
            >
              Favoritas ({biblioteca.filter((c) => c.favorito).length})
            </button>

            <button
              onClick={() => setFiltroBiblioteca('playlists')}
              style={{
                backgroundColor: filtroBiblioteca === 'playlists' || playlistSeleccionada ? '#FFFFFF' : 'rgba(255, 255, 255, 0.08)',
                color: filtroBiblioteca === 'playlists' || playlistSeleccionada ? '#000000' : '#FFFFFF',
                border: filtroBiblioteca === 'playlists' || playlistSeleccionada ? '1px solid #FFFFFF' : '1px solid rgba(255, 255, 255, 0.12)',
                borderRadius: '500px',
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: '700',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'all 0.15s ease'
              }}
            >
              Playlists ({playlists.length})
            </button>

            <button
              onClick={() => {
                setPlaylistSeleccionada(null);
                setFiltroBiblioteca('revisar');
              }}
              style={{
                backgroundColor: filtroBiblioteca === 'revisar' && !playlistSeleccionada ? '#F59E0B' : 'rgba(245, 158, 11, 0.14)',
                color: filtroBiblioteca === 'revisar' && !playlistSeleccionada ? '#000000' : '#FBBF24',
                border: filtroBiblioteca === 'revisar' && !playlistSeleccionada ? '1px solid #F59E0B' : '1px solid rgba(245, 158, 11, 0.4)',
                borderRadius: '500px',
                padding: '8px 16px',
                fontSize: '13px',
                fontWeight: '700',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                transition: 'all 0.15s ease'
              }}
            >
              Revisar biblioteca ({biblioteca.filter((c) => esCancionParaRevisar(c)).length})
            </button>
          </div>

          {/* Buscador Local y Selector de Orden */}
          {(!filtroBiblioteca || (filtroBiblioteca !== 'playlists' && filtroBiblioteca !== 'revisar') || playlistSeleccionada) && (
            <div style={{ marginBottom: '18px' }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                backgroundColor: 'rgba(36, 36, 38, 0.75)',
                backdropFilter: 'blur(16px)',
                WebkitBackdropFilter: 'blur(16px)',
                borderRadius: '500px',
                border: '1px solid rgba(255, 255, 255, 0.15)',
                padding: '9px 16px',
                marginBottom: '12px',
                boxShadow: '0 6px 20px rgba(0,0,0,0.35)',
                transition: 'border-color 0.2s ease, box-shadow 0.2s ease'
              }}>
                <IconBuscar size={17} color="#1ED760" />
                <input
                  type="text"
                  placeholder="Buscar en tu biblioteca local..."
                  value={busquedaLocal}
                  onChange={(e) => setBusquedaLocal(e.target.value)}
                  style={{
                    width: '100%',
                    border: 'none',
                    backgroundColor: 'transparent',
                    color: '#FFFFFF',
                    fontSize: '13.5px',
                    outline: 'none'
                  }}
                />
                {busquedaLocal && (
                  <button
                    onClick={() => setBusquedaLocal('')}
                    style={{
                      background: 'none',
                      border: 'none',
                      padding: '2px',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      color: '#B3B3B3'
                    }}
                    title="Limpiar búsqueda"
                  >
                    <IconLimpiar size={16} />
                  </button>
                )}
              </div>

              {/* Selector de Orden (A-Z, Z-A, Recientes) */}
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                overflowX: 'auto',
                paddingBottom: '2px'
              }}>
                <span style={{ fontSize: '12px', color: '#B3B3B3', fontWeight: '600', marginRight: '2px', whiteSpace: 'nowrap' }}>
                  Ordenar por:
                </span>
                <button
                  onClick={() => setCriterioOrden('recientes')}
                  style={{
                    backgroundColor: criterioOrden === 'recientes' ? '#FFFFFF' : '#242424',
                    color: criterioOrden === 'recientes' ? '#000000' : '#B3B3B3',
                    border: 'none',
                    borderRadius: '500px',
                    padding: '5px 12px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    transition: 'all 0.15s ease'
                  }}
                >
                  Recientes
                </button>
                <button
                  onClick={() => setCriterioOrden('az')}
                  style={{
                    backgroundColor: criterioOrden === 'az' ? '#FFFFFF' : '#242424',
                    color: criterioOrden === 'az' ? '#000000' : '#B3B3B3',
                    border: 'none',
                    borderRadius: '500px',
                    padding: '5px 12px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    transition: 'all 0.15s ease'
                  }}
                >
                  A - Z
                </button>
                <button
                  onClick={() => setCriterioOrden('za')}
                  style={{
                    backgroundColor: criterioOrden === 'za' ? '#FFFFFF' : '#242424',
                    color: criterioOrden === 'za' ? '#000000' : '#B3B3B3',
                    border: 'none',
                    borderRadius: '500px',
                    padding: '5px 12px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    transition: 'all 0.15s ease'
                  }}
                >
                  Z - A
                </button>
              </div>
            </div>
          )}

          {/* Vista de Playlist Seleccionada */}
          {playlistSeleccionada && (
            <div style={{
              marginBottom: '18px',
              backgroundColor: '#181818',
              padding: '16px 18px',
              borderRadius: '12px',
              border: '1px solid #282828'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <button
                    onClick={() => setPlaylistSeleccionada(null)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#1ED760',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: '13px',
                      fontWeight: '600',
                      marginBottom: '6px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '4px'
                    }}
                  >
                    ← Volver a listas
                  </button>
                  <h2 style={{ margin: 0, fontSize: '20px', fontWeight: '800', color: '#FFFFFF', letterSpacing: '-0.3px' }}>
                    {playlistSeleccionada.nombre}
                  </h2>
                  <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#B3B3B3' }}>
                    {playlistSeleccionada.canciones.length} canciones
                  </p>
                </div>

                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                  {/* Botón para Agregar Canciones a la Playlist */}
                  <button
                    onClick={() => abrirModalAgregarAPlaylist(playlistSeleccionada)}
                    style={{
                      backgroundColor: 'rgba(255, 255, 255, 0.1)',
                      color: '#FFFFFF',
                      border: '1px solid rgba(255, 255, 255, 0.2)',
                      borderRadius: '500px',
                      padding: '9px 16px',
                      fontWeight: '700',
                      cursor: 'pointer',
                      fontSize: '12.5px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      transition: 'background-color 0.15s ease'
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.18)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.1)'; }}
                  >
                    <span style={{ fontSize: '15px', color: '#1ED760', fontWeight: '900' }}>+</span>
                    <span>Agregar Canciones</span>
                  </button>

                  {playlistSeleccionada.canciones.length > 0 && (
                    <button
                      onClick={() => {
                        const primera = biblioteca.find((c) => c.nombre === playlistSeleccionada.canciones[0]);
                        if (primera) reproducirCancion(primera);
                      }}
                      style={{
                        backgroundColor: '#1ED760',
                        color: '#000000',
                        border: 'none',
                        borderRadius: '500px',
                        padding: '10px 20px',
                        fontWeight: '700',
                        cursor: 'pointer',
                        fontSize: '13px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                      }}
                    >
                      <IconPlay size={14} color="#000000" />
                      <span>Reproducir</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Lista de Playlists */}
          {filtroBiblioteca === 'playlists' && !playlistSeleccionada && (
            <div>
              {playlists.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 16px', color: '#B3B3B3' }}>
                  <p style={{ fontSize: '16px', fontWeight: '700', color: '#FFFFFF', marginBottom: '6px' }}>Crea tu primera lista</p>
                  <p style={{ fontSize: '13px', color: '#777777', marginBottom: '20px' }}>Organiza tus canciones por género, artista o momentos.</p>
                  <button
                    onClick={() => setModalPlaylistAbierto(true)}
                    style={{
                      backgroundColor: '#1ED760',
                      color: '#000000',
                      fontWeight: '700',
                      border: 'none',
                      padding: '10px 22px',
                      borderRadius: '500px',
                      cursor: 'pointer',
                      fontSize: '13px'
                    }}
                  >
                    Crear Playlist
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {playlists.map((pl) => (
                    <div
                      key={pl.id}
                      onClick={() => setPlaylistSeleccionada(pl)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                        backgroundColor: '#181818',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        border: '1px solid transparent',
                        transition: 'background-color 0.15s ease'
                      }}
                      onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#242424'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#181818'; }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                        <div style={{
                          width: '44px',
                          height: '44px',
                          backgroundColor: '#282828',
                          borderRadius: '6px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0
                        }}>
                          <IconBiblioteca size={20} color="#B3B3B3" />
                        </div>
                        <div>
                          <p style={{ margin: 0, fontWeight: '600', fontSize: '14px', color: '#FFFFFF' }}>{pl.nombre}</p>
                          <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: '#B3B3B3' }}>{pl.canciones.length} canciones</p>
                        </div>
                      </div>

                      <button
                        onClick={(e) => eliminarPlaylist(pl.id, pl.nombre, e)}
                        title="Eliminar playlist"
                        style={{
                          backgroundColor: 'transparent',
                          border: 'none',
                          color: '#A7A7A7',
                          cursor: 'pointer',
                          padding: '6px'
                        }}
                      >
                        <span style={{ fontSize: '14px' }}>✕</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Pantalla Revisar biblioteca */}
          {filtroBiblioteca === 'revisar' && !playlistSeleccionada && (
            <RevisarBiblioteca
              biblioteca={biblioteca}
              reemplazandoNombre={reemplazandoCancionNombre}
              onMarcarCorrecta={marcarCancionComoCorrecta}
              onReemplazarVersion={(cancion, e) => {
                const match = biblioteca.find((c) => c.nombre === cancion.nombre);
                if (match) alReemplazarOriginalFila(match, e);
              }}
              onEliminar={(nombre, e) => alEliminarFila(nombre, e)}
              onVolver={() => setFiltroBiblioteca('todas')}
              onNotificar={mostrarToast}
            />
          )}

          {/* Lista de Canciones */}
          {(!filtroBiblioteca || (filtroBiblioteca !== 'playlists' && filtroBiblioteca !== 'revisar') || playlistSeleccionada) && (
            <div>
              {cancionesVisibles.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 16px', color: '#B3B3B3' }}>
                  <p style={{ fontSize: '15px', fontWeight: '700', color: '#FFFFFF', marginBottom: '6px' }}>
                    {playlistSeleccionada ? 'Esta playlist aún no tiene canciones' : 'No se encontraron canciones'}
                  </p>
                  <p style={{ fontSize: '13px', color: '#777777', marginBottom: '16px' }}>
                    {playlistSeleccionada
                      ? 'Agrega canciones de tu biblioteca local para escucharlas juntas en esta playlist.'
                      : 'Ve a la pestaña "Buscar" para descargar tus temas oficiales favoritos.'}
                  </p>
                  {playlistSeleccionada && (
                    <button
                      onClick={() => abrirModalAgregarAPlaylist(playlistSeleccionada)}
                      style={{
                        backgroundColor: '#1ED760',
                        color: '#000000',
                        fontWeight: '700',
                        border: 'none',
                        padding: '10px 22px',
                        borderRadius: '500px',
                        cursor: 'pointer',
                        fontSize: '13px'
                      }}
                    >
                      + Agregar Canciones Ahora
                    </button>
                  )}
                </div>
              ) : (
                <VirtualSongList
                  items={cancionesVisibles}
                  itemHeight={72}
                  overscan={4}
                  scrollContainerRef={mainContentRef}
                  getKey={(cancion) => cancion.nombre}
                  renderItem={(cancion) => {
                    const estaSonando = cancionActual?.nombre === cancion.nombre && reproduciendo;
                    const esActual = cancionActual?.nombre === cancion.nombre;

                    return (
                      <CancionFila
                        cancion={cancion}
                        estaSonando={estaSonando}
                        esActual={esActual}
                        reemplazando={reemplazandoCancionNombre === cancion.nombre}
                        onReproducir={alReproducirFila}
                        onAlternarFavorito={alAlternarFavoritoFila}
                        onAbrirMenu={alAbrirMenuCancion}
                        onExportar={alExportarFila}
                        onAgregarACola={alAgregarAColaFila}
                        onReemplazarOriginal={alReemplazarOriginalFila}
                        onEliminar={alEliminarFila}
                      />
                    );
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}

      {/* ========================================================================= */}
      {/* VISTA 3: AJUSTES Y RESPALDOS */}
      {/* ========================================================================= */}
      {tabActiva === 'ajustes' && (
        <div
          className="vista-tab-content"
          style={{
            padding: '24px 16px',
            maxWidth: '680px',
            margin: '0 auto',
            width: '100%',
            boxSizing: 'border-box',
            position: 'relative',
            zIndex: 10
          }}
        >
          {/* Cabecera Hero con Badge de Ajustes y Botón de Actualizar Arriba Siempre Visible */}
          <div style={{ marginBottom: '22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px', flexWrap: 'wrap' }}>
              <span className="hero-subtitle-badge">
                <span>⚙️ PREFERENCIAS Y SISTEMA</span>
                <span>•</span>
                <span>AUDIO PRO</span>
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '12px', color: '#1ed760', fontWeight: '700' }}>
                  {VERSION_APP}
                </span>
                <button
                  onClick={manejarBuscarActualizacionOta}
                  disabled={estadoOta === 'checking' || estadoOta === 'descargando'}
                  style={{
                    backgroundColor: estadoOta === 'error' ? '#EF4444' : '#1ED760',
                    color: estadoOta === 'error' ? '#FFFFFF' : '#000000',
                    border: 'none',
                    borderRadius: '500px',
                    padding: '7px 16px',
                    fontSize: '12px',
                    fontWeight: '800',
                    cursor: estadoOta === 'checking' || estadoOta === 'descargando' ? 'wait' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    boxShadow: '0 2px 10px rgba(30, 215, 96, 0.4)'
                  }}
                >
                  <span>
                    {estadoOta === 'descargando'
                      ? 'Descargando...'
                      : estadoOta === 'checking'
                      ? 'Buscando...'
                      : '🔄 Buscar actualización'}
                  </span>
                </button>
              </div>
            </div>
            {mensajeOta && estadoOta !== 'idle' && (
              <div
                style={{
                  marginBottom: '8px',
                  fontSize: '12px',
                  fontWeight: 700,
                  color:
                    estadoOta === 'error'
                      ? '#F87171'
                      : estadoOta === 'descargando'
                      ? '#60A5FA'
                      : '#6EE7B7'
                }}
              >
                {mensajeOta}
              </div>
            )}
            <h1 className="hero-gradient-text" style={{ fontSize: '32px', fontWeight: '900', margin: '0 0 6px 0', letterSpacing: '-0.8px' }}>
              Ajustes & Respaldo
            </h1>
            <p style={{ margin: 0, fontSize: '13px', color: '#B3B3B3', lineHeight: '1.4' }}>
              Personaliza el mixeo continuo, los efectos visuales y respalda toda tu música.
            </p>
          </div>

          {/* Card de Configuración de Crossfade / Mixeo Continuo Estilo Spotify Automix */}
          <div style={{
            padding: '20px',
            backgroundColor: '#18181c',
            borderRadius: '16px',
            border: crossfadeSegundos > 0 ? '1px solid rgba(30, 215, 96, 0.35)' : '1px solid rgba(255, 255, 255, 0.1)',
            marginBottom: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{
                  width: '38px',
                  height: '38px',
                  borderRadius: '10px',
                  backgroundColor: 'rgba(30, 215, 96, 0.15)',
                  border: '1px solid rgba(30, 215, 96, 0.3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <IconMix size={20} color="#1ED760" />
                </div>
                <div>
                  <p style={{ margin: 0, fontWeight: '800', fontSize: '15px', color: '#FFFFFF' }}>Spotify Automix & Crossfade</p>
                  <p style={{ margin: '3px 0 0 0', fontSize: '12px', color: '#B3B3B3' }}>
                    Mezcla el final de la canción con el inicio de la siguiente usando curva Equal-Power real sin silencios.
                  </p>
                </div>
              </div>
              <span style={{ fontSize: '12px', fontWeight: '800', color: crossfadeSegundos > 0 ? '#1ED760' : '#888888', whiteSpace: 'nowrap', backgroundColor: 'rgba(0,0,0,0.3)', padding: '4px 10px', borderRadius: '12px' }}>
                {crossfadeSegundos > 0 ? `${crossfadeSegundos}s activo` : 'Desactivado'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingTop: '8px', paddingBottom: '10px' }}>
              {[
                { label: '0s (Off)', val: 0 },
                { label: '3s (Rápido)', val: 3 },
                { label: '5s (Spotify Automix)', val: 5 },
                { label: '8s (Suave)', val: 8 },
                { label: '12s (Club DJ)', val: 12 }
              ].map((opt) => (
                <button
                  key={opt.val}
                  onClick={() => cambiarCrossfade(opt.val)}
                  style={{
                    backgroundColor: crossfadeSegundos === opt.val ? '#1ED760' : 'rgba(255, 255, 255, 0.08)',
                    color: crossfadeSegundos === opt.val ? '#000000' : '#FFFFFF',
                    border: crossfadeSegundos === opt.val ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: '500px',
                    padding: '8px 16px',
                    fontSize: '12.5px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    transition: 'all 0.15s ease'
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {/* Opción de Mix Manual al saltar o elegir canción + Botón de prueba en vivo */}
            <div style={{
              marginTop: '8px',
              paddingTop: '12px',
              borderTop: '1px solid rgba(255, 255, 255, 0.08)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
              gap: '10px'
            }}>
              <div>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#FFFFFF' }}>
                  Mix suave al cambiar canción manualmente (DJ Fade)
                </p>
                <p style={{ margin: '2px 0 0 0', fontSize: '11.5px', color: '#94A3B8' }}>
                  Mezcla suavemente también cuando tocas "Siguiente" o eliges otra pista.
                </p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                {cancionActual && reproduciendo && (
                  <button
                    onClick={() => ejecutarMixManualAhora()}
                    style={{
                      backgroundColor: 'rgba(30, 215, 96, 0.16)',
                      color: '#1ED760',
                      border: '1px solid rgba(30, 215, 96, 0.45)',
                      borderRadius: '500px',
                      padding: '6px 12px',
                      fontSize: '12px',
                      fontWeight: '800',
                      cursor: 'pointer'
                    }}
                  >
                    🔀 Probar Mix Ahora
                  </button>
                )}
                <button
                  onClick={() => alternarMixManual()}
                  style={{
                    backgroundColor: mixManualActivo ? '#1ED760' : 'rgba(255, 255, 255, 0.08)',
                    color: mixManualActivo ? '#000000' : '#FFFFFF',
                    border: mixManualActivo ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.16)',
                    borderRadius: '500px',
                    padding: '6px 14px',
                    fontSize: '12px',
                    fontWeight: '800',
                    cursor: 'pointer'
                  }}
                >
                  {mixManualActivo ? 'Activado' : 'Desactivado'}
                </button>
              </div>
            </div>
          </div>

          {/* Card de Temporizador de Sueño Inteligente (Sleep Timer con Fade-Out) */}
          <div style={{
            padding: '20px',
            backgroundColor: '#18181c',
            borderRadius: '16px',
            border: timerTextoRestante ? '1px solid rgba(30, 215, 96, 0.4)' : '1px solid rgba(255, 255, 255, 0.08)',
            marginBottom: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '12px',
                  backgroundColor: timerTextoRestante ? 'rgba(30, 215, 96, 0.15)' : 'rgba(255, 255, 255, 0.05)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '20px'
                }}>
                  🌙
                </div>
                <div>
                  <p style={{ margin: 0, fontWeight: '800', fontSize: '15px', color: '#FFFFFF' }}>
                    Temporizador de Sueño (Sleep Timer)
                  </p>
                  <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: '#94A3B8' }}>
                    Apagado con fundido suave (fade-out) en los últimos 10 segundos.
                  </p>
                </div>
              </div>
              <span style={{
                fontSize: '11px',
                fontWeight: '800',
                color: timerTextoRestante ? '#1ED760' : '#888888',
                backgroundColor: timerTextoRestante ? 'rgba(30, 215, 96, 0.15)' : 'rgba(0,0,0,0.3)',
                padding: '4px 10px',
                borderRadius: '12px'
              }}>
                {timerTextoRestante ? `Activo (${timerTextoRestante})` : 'Off'}
              </span>
            </div>

            <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingTop: '4px' }}>
              {[
                { label: 'Off', val: null },
                { label: '15 min', val: 15 },
                { label: '30 min', val: 30 },
                { label: '60 min', val: 60 },
                { label: '🎵 Fin de canción', val: -1 }
              ].map((opt) => (
                <button
                  key={String(opt.val)}
                  onClick={() => activarSleepTimer(opt.val)}
                  style={{
                    backgroundColor: timerOpcion === opt.val ? '#1ED760' : 'rgba(255, 255, 255, 0.08)',
                    color: timerOpcion === opt.val ? '#000000' : '#FFFFFF',
                    border: timerOpcion === opt.val ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: '500px',
                    padding: '8px 14px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    transition: 'all 0.15s ease'
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Card de Configuración de Bass Boost Auto-Adaptativo (Un solo botón: Audio 100% Nativo en Off / Graves Adaptativos sin clipping en On) */}
          <div style={{
            padding: '20px',
            backgroundColor: '#18181c',
            borderRadius: '16px',
            border: bassBoostActivo ? '1px solid rgba(29, 185, 84, 0.35)' : '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: bassBoostActivo ? '0 4px 20px rgba(29, 185, 84, 0.12)' : 'none',
            marginBottom: '16px',
            transition: 'border-color 0.3s ease, box-shadow 0.3s ease'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div style={{
                  width: '42px',
                  height: '42px',
                  borderRadius: '12px',
                  backgroundColor: bassBoostActivo ? 'rgba(29, 185, 84, 0.2)' : 'rgba(255, 255, 255, 0.06)',
                  border: `1px solid ${bassBoostActivo ? '#1db954' : 'rgba(255, 255, 255, 0.1)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s ease',
                  boxShadow: bassBoostActivo ? '0 0 16px rgba(29, 185, 84, 0.3)' : 'none'
                }}>
                  <span style={{ fontSize: '20px' }}>🔊</span>
                </div>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <p style={{ margin: 0, fontWeight: '800', fontSize: '15px', color: '#FFFFFF' }}>
                      Bass Boost Auto
                    </p>
                    {bassBoostActivo && (
                      <span style={{
                        fontSize: '10px',
                        fontWeight: '800',
                        color: '#1db954',
                        backgroundColor: 'rgba(29, 185, 84, 0.15)',
                        border: '1px solid rgba(29, 185, 84, 0.3)',
                        padding: '1px 7px',
                        borderRadius: '20px'
                      }}>
                        AUTO 65Hz
                      </span>
                    )}
                  </div>
                  <p style={{ margin: '3px 0 0 0', fontSize: '12px', color: '#B3B3B3' }}>
                    {bassBoostActivo
                      ? 'Pre-atenuación -4.5 dB + Lowshelf suave a 65 Hz sin distorsión'
                      : 'Sonido 100% nativo y puro (Flat 0.0 dB sin filtros ni compresores).'}
                  </p>
                </div>
              </div>
              <button
                onClick={() => alternarBassBoost()}
                style={{
                  backgroundColor: bassBoostActivo ? '#1db954' : '#333338',
                  color: bassBoostActivo ? '#000000' : '#E0E0E0',
                  border: 'none',
                  borderRadius: '500px',
                  padding: '8px 20px',
                  fontSize: '13px',
                  fontWeight: '800',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'all 0.2s ease',
                  flexShrink: 0
                }}
              >
                <span>{bassBoostActivo ? 'Activado' : 'Desactivado'}</span>
              </button>
            </div>
            {bassBoostActivo && (
              <div style={{
                marginTop: '12px',
                padding: '8px 12px',
                backgroundColor: 'rgba(29, 185, 84, 0.08)',
                borderRadius: '8px',
                border: '1px solid rgba(29, 185, 84, 0.18)',
                fontSize: '11.5px',
                color: '#86efac',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}>
                <span>✨</span>
                <span>Adaptándose automáticamente a la energía de graves (+3.5 dB a +5.5 dB con limitador transparente)</span>
              </div>
            )}
          </div>

          {/* Card de Configuración de Fondos Dinámicos Animados */}
          <div style={{
            padding: '20px',
            backgroundColor: '#18181c',
            borderRadius: '16px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            marginBottom: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div>
                <p style={{ margin: 0, fontWeight: '800', fontSize: '15px', color: '#FFFFFF' }}>Fondos Dinámicos en Movimiento</p>
                <p style={{ margin: '3px 0 0 0', fontSize: '12px', color: '#B3B3B3' }}>
                  Aura fluida y orbes de gradiente que cambian de color con cada canción.
                </p>
              </div>
              <button
                onClick={() => {
                  const nuevo = !animacionFondoActiva;
                  setAnimacionFondoActiva(nuevo);
                  try { localStorage.setItem('app_musica_fondo_animado', nuevo.toString()); } catch (_) {}
                  mostrarToast(nuevo ? 'Fondos dinámicos activados' : 'Fondos estáticos', 'info');
                }}
                style={{
                  backgroundColor: animacionFondoActiva ? '#1ED760' : 'rgba(255, 255, 255, 0.1)',
                  color: animacionFondoActiva ? '#000000' : '#FFFFFF',
                  border: animacionFondoActiva ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.15)',
                  borderRadius: '500px',
                  padding: '7px 16px',
                  fontSize: '12px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  transition: 'all 0.15s ease'
                }}
              >
                {animacionFondoActiva ? 'Activado' : 'Desactivado'}
              </button>
            </div>

            {/* Selector de temas visuales */}
            <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingTop: '6px', paddingBottom: '4px' }}>
              <button
                onClick={() => {
                  setTemaSeleccionadoManual(null);
                  mostrarToast('Tema: Automático por canción', 'exito');
                }}
                style={{
                  backgroundColor: !temaSeleccionadoManual ? '#FFFFFF' : 'rgba(255, 255, 255, 0.08)',
                  color: !temaSeleccionadoManual ? '#000000' : '#FFFFFF',
                  border: !temaSeleccionadoManual ? '1px solid #FFFFFF' : '1px solid rgba(255, 255, 255, 0.12)',
                  borderRadius: '500px',
                  padding: '7px 14px',
                  fontSize: '11.5px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap'
                }}
              >
                ✨ Automático
              </button>
              {TEMAS_VISUALES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => {
                    setTemaSeleccionadoManual(t.id);
                    mostrarToast(`Tema fijado: ${t.nombre}`, 'info');
                  }}
                  style={{
                    backgroundColor: temaSeleccionadoManual === t.id ? t.colorPrincipal : 'rgba(255, 255, 255, 0.08)',
                    color: temaSeleccionadoManual === t.id ? '#000000' : '#FFFFFF',
                    border: `1px solid ${t.colorPrincipal}77`,
                    borderRadius: '500px',
                    padding: '7px 14px',
                    fontSize: '11.5px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: t.colorPrincipal }} />
                  <span>{t.nombre}</span>
                </button>
              ))}
            </div>
          </div>

          {/* TARJETA DE BLINDAJE PERMANENTE ANTI-BORRADO (INMUNE A DESINSTALACIÓN) */}
          <div style={{
            padding: '20px',
            backgroundColor: 'rgba(30, 215, 96, 0.08)',
            borderRadius: '16px',
            border: '1.5px solid rgba(30, 215, 96, 0.4)',
            marginBottom: '18px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)'
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <span style={{ fontSize: '20px' }}>🛡️</span>
                  <p style={{ margin: 0, fontWeight: '900', fontSize: '16px', color: '#1ED760', letterSpacing: '-0.3px' }}>
                    Blindaje Permanente Anti-Borrado
                  </p>
                </div>
                <p style={{ margin: 0, fontSize: '12px', color: '#CCCCCC', lineHeight: '1.5' }}>
                  Tus canciones se guardan como archivos MP3 físicos en la carpeta pública{' '}
                  <strong style={{ color: '#FFFFFF' }}>Música/AppMusica</strong> de tu celular.{' '}
                  <span style={{ color: '#1ED760', fontWeight: '700' }}>
                    NUNCA se borran aunque desinstales la app, cambies de versión o limpies datos.
                  </span>
                </p>
              </div>
            </div>

            <div style={{
              marginTop: '14px',
              padding: '10px 12px',
              backgroundColor: 'rgba(0, 0, 0, 0.4)',
              borderRadius: '10px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: '12px',
              border: '1px solid rgba(255, 255, 255, 0.08)'
            }}>
              <span style={{ color: '#A0A0A0' }}>
                Biblioteca activa: <strong style={{ color: '#FFFFFF' }}>{biblioteca.length} canciones</strong> ({formatearTamano(almacenamientoTotal)})
              </span>
              <span style={{
                fontSize: '11px',
                padding: '3px 8px',
                borderRadius: '500px',
                backgroundColor: esAlmacenamientoNativoDisponible() ? 'rgba(30, 215, 96, 0.25)' : 'rgba(255, 255, 255, 0.1)',
                color: esAlmacenamientoNativoDisponible() ? '#1ED760' : '#CCCCCC',
                fontWeight: '700'
              }}>
                {esAlmacenamientoNativoDisponible() ? '📱 APK Nativo Conectado' : '🌐 Web PWA'}
              </span>
            </div>

            {progresoBlindaje && (
              <div style={{ marginTop: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px', color: '#FFFFFF' }}>
                  <span>Protegiendo en el celular: <em>{progresoBlindaje.nombre.slice(0, 28)}...</em></span>
                  <strong>{progresoBlindaje.actual} / {progresoBlindaje.total}</strong>
                </div>
                <div style={{ width: '100%', height: '6px', backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: '500px', overflow: 'hidden' }}>
                  <div style={{
                    width: `${Math.round((progresoBlindaje.actual / progresoBlindaje.total) * 100)}%`,
                    height: '100%',
                    backgroundColor: '#1ED760',
                    transition: 'width 0.1s linear'
                  }} />
                </div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '16px' }}>
              <button
                onClick={blindarTodaLaMusicaEnDispositivo}
                disabled={blindandoMusica || biblioteca.length === 0}
                style={{
                  backgroundColor: '#1ED760',
                  color: '#000000',
                  border: 'none',
                  padding: '13px 16px',
                  borderRadius: '500px',
                  cursor: blindandoMusica || biblioteca.length === 0 ? 'not-allowed' : 'pointer',
                  fontWeight: '800',
                  fontSize: '14px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  boxShadow: '0 4px 16px rgba(30, 215, 96, 0.35)'
                }}
              >
                <IconDescargar size={18} color="#000000" />
                <span>
                  {blindandoMusica
                    ? 'Blindando canciones en tu celular...'
                    : `💾 Blindar Todas mis Canciones en el Teléfono (${biblioteca.length})`}
                </span>
              </button>

              <button
                onClick={restaurarMusicaDesdeDispositivo}
                disabled={procesandoRespaldo}
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  color: '#FFFFFF',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  padding: '12px 16px',
                  borderRadius: '500px',
                  cursor: procesandoRespaldo ? 'not-allowed' : 'pointer',
                  fontWeight: '700',
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px'
                }}
              >
                <span>🔄 Restaurar / Escanear Canciones Guardadas en mi Celular</span>
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '24px' }}>
            <button
              onClick={() => {
                if (inputFolderRef.current) {
                  inputFolderRef.current.click();
                } else if (inputFileRef.current) {
                  inputFileRef.current.click();
                }
              }}
              disabled={descargando}
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.1)',
                color: '#FFFFFF',
                border: '1px solid rgba(255, 255, 255, 0.16)',
                padding: '13px',
                borderRadius: '500px',
                cursor: 'pointer',
                fontWeight: '700',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
              }}
            >
              <IconDescargar size={17} color="#FFFFFF" />
              <span>📂 Importar Archivos / Carpeta de Música Externa</span>
            </button>

            <button
              onClick={exportarTodaLaBiblioteca}
              disabled={procesandoRespaldo || biblioteca.length === 0}
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.05)',
                color: '#B3B3B3',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                padding: '12px',
                borderRadius: '500px',
                cursor: 'pointer',
                fontWeight: '600',
                fontSize: '13px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px'
              }}
            >
              <span>{procesandoRespaldo ? 'Generando archivo...' : `📋 Descargar Índice de Respaldo (.json) (${biblioteca.length} pistas)`}</span>
            </button>

            {almacenamientoProtegido && (
              <div style={{ textAlign: 'center', fontSize: '11px', color: '#1ED760', fontWeight: '600' }}>
                ✓ Memoria persistente de almacenamiento concedida por el sistema operativo
              </div>
            )}
          </div>

          {/* Card de Configuración del Servidor Backend (Render / Local) */}
          <div style={{
            padding: '20px',
            backgroundColor: '#18181c',
            borderRadius: '16px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            marginBottom: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: '800', color: '#FFFFFF', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>🌐</span> Servidor Backend de Descargas
              </h3>
              {estadoServidor && (
                <span style={{
                  fontSize: '11px',
                  fontWeight: '700',
                  color: estadoServidor.ok ? '#1ED760' : '#EF4444',
                  backgroundColor: estadoServidor.ok ? 'rgba(30, 215, 96, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                  padding: '3px 10px',
                  borderRadius: '12px',
                  border: `1px solid ${estadoServidor.ok ? 'rgba(30, 215, 96, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`
                }}>
                  {estadoServidor.ok ? '✓ Conectado' : '✕ Sin Conexión'}
                </span>
              )}
            </div>

            <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: '#94A3B8', lineHeight: '1.4' }}>
              Define el servidor remoto para buscar y descargar en cualquier teléfono o APK sin congelar la app.
            </p>

            <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
              <input
                type="text"
                value={backendUrlConfig}
                onChange={(e) => setBackendUrlConfig(e.target.value)}
                placeholder="https://servidor-musica-i7m3.onrender.com"
                style={{
                  flex: 1,
                  backgroundColor: 'rgba(0, 0, 0, 0.35)',
                  border: '1px solid rgba(255, 255, 255, 0.2)',
                  borderRadius: '10px',
                  padding: '10px 14px',
                  color: '#FFFFFF',
                  fontSize: '13px'
                }}
              />
              <button
                onClick={() => {
                  guardarBackendBaseUrl(backendUrlConfig);
                  mostrarToast('URL del servidor guardada');
                }}
                style={{
                  backgroundColor: '#1ED760',
                  color: '#000000',
                  border: 'none',
                  borderRadius: '10px',
                  padding: '10px 16px',
                  fontSize: '13px',
                  fontWeight: '700',
                  cursor: 'pointer'
                }}
              >
                Guardar
              </button>
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                onClick={async () => {
                  setProbandoServidor(true);
                  setEstadoServidor(null);
                  const res = await probarConexionBackend(backendUrlConfig);
                  setProbandoServidor(false);
                  setEstadoServidor({ ok: res.ok, mensaje: res.mensaje });
                  mostrarToast(res.mensaje, res.ok ? 'exito' : 'error');
                }}
                disabled={probandoServidor}
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  color: '#FFFFFF',
                  border: '1px solid rgba(255, 255, 255, 0.16)',
                  borderRadius: '500px',
                  padding: '7px 16px',
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                {probandoServidor && <IconSpinner size={13} color="#FFFFFF" />}
                <span>{probandoServidor ? 'Verificando...' : 'Probar Conexión'}</span>
              </button>

              <button
                onClick={() => {
                  setBackendUrlConfig(BACKEND_URL_DEFAULT);
                  guardarBackendBaseUrl(BACKEND_URL_DEFAULT);
                  mostrarToast('Restablecido a Render (servidor-musica)');
                }}
                style={{
                  backgroundColor: 'transparent',
                  color: '#94A3B8',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '500px',
                  padding: '7px 14px',
                  fontSize: '12px',
                  cursor: 'pointer'
                }}
              >
                Restablecer a Render
              </button>
            </div>
          </div>

          {/* Card de Actualizaciones y Service Worker */}
          <div style={{
            padding: '20px',
            backgroundColor: '#18181c',
            borderRadius: '16px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            marginBottom: '16px'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
              <h3 style={{ margin: 0, fontSize: '15px', fontWeight: '800', color: '#FFFFFF' }}>
                🚀 Actualizaciones y Versión
              </h3>
              <span style={{
                fontSize: '11px',
                fontWeight: '700',
                padding: '3px 9px',
                borderRadius: '12px',
                backgroundColor: 'rgba(30, 215, 96, 0.15)',
                color: '#1ED760',
                border: '1px solid rgba(30, 215, 96, 0.3)'
              }}>
                {VERSION_APP}
              </span>
            </div>
            <p style={{ margin: '0 0 14px 0', fontSize: '12px', color: '#94A3B8', lineHeight: '1.4' }}>
              La app se actualiza automáticamente. Si no ves los últimos cambios o fondos nuevos en tu teléfono, pulsa el botón para sincronizar al instante.
            </p>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                onClick={manejarBuscarActualizacionOta}
                disabled={estadoOta === 'checking' || estadoOta === 'descargando'}
                style={{
                  backgroundColor: estadoOta === 'error' ? '#EF4444' : '#1ED760',
                  color: estadoOta === 'error' ? '#FFFFFF' : '#000000',
                  border: 'none',
                  borderRadius: '500px',
                  padding: '9px 18px',
                  fontSize: '12px',
                  fontWeight: '700',
                  cursor: estadoOta === 'checking' || estadoOta === 'descargando' ? 'wait' : 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}
              >
                <span>
                  {estadoOta === 'descargando'
                    ? 'Descargando...'
                    : estadoOta === 'checking'
                    ? 'Buscando...'
                    : estadoOta === 'error'
                    ? '⚠️ Error (Reintentar)'
                    : '🔄 Buscar Actualización'}
                </span>
              </button>

              <button
                onClick={forzarRecargaLimpia}
                style={{
                  backgroundColor: 'rgba(255, 255, 255, 0.08)',
                  color: '#FFFFFF',
                  border: '1px solid rgba(255, 255, 255, 0.16)',
                  borderRadius: '500px',
                  padding: '9px 16px',
                  fontSize: '12px',
                  fontWeight: '700',
                  cursor: 'pointer'
                }}
              >
                <span>⚡ Forzar Recarga Limpia</span>
              </button>
            </div>
          </div>

          <div style={{
            padding: '20px',
            backgroundColor: '#18181c',
            borderRadius: '16px',
            border: '1px solid rgba(255, 255, 255, 0.1)'
          }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: '15px', fontWeight: '800', color: '#FFFFFF' }}>Acerca de la App</h3>
            <p style={{ margin: '0 0 4px 0', fontSize: '13px', color: '#CBD5E1', lineHeight: '1.4' }}>
              Dev: <strong style={{ color: '#FFFFFF', fontWeight: '700' }}>JC Sanchez Reyes</strong>
            </p>
            <p style={{ margin: 0, fontSize: '12px', color: '#94A3B8' }}>
              v5.2.0 • (2026) • Verificación MusicBrainz + Importación Local + Pre-escucha 15s + OTA
            </p>
          </div>
        </div>
      )}
      </main>

      {/* --- REPRODUCTOR DUAL INTELIGENTE (DECK A Y DECK B PARA SPOTIFY AUTOMIX + SINGLE-DECK EN PANTALLA BLOQUEADA) --- */}
      <audio
        ref={deckARef}
        playsInline
        preload="auto"
        onPlay={() => {
          if (deckActivoRef.current !== 'A' && !crossfadingRef.current) return;
          pausadoPorUsuarioRef.current = false;
          bassBoostManager.asegurarActivo();
          reproduciendoRef.current = true;
          setReproduciendo(true);
          if (deckActivoRef.current === 'A') {
            if ('mediaSession' in navigator) {
              navigator.mediaSession.playbackState = 'playing';
            }
            actualizarMediaSessionRef.current();
          }
        }}
        onPlaying={() => {
          if (deckActivoRef.current !== 'A' && !crossfadingRef.current) return;
          pausadoPorUsuarioRef.current = false;
          bassBoostManager.asegurarActivo();
          programarRevocacionUrlAnterior();
          ultimoAvanceTimestampRef.current = Date.now();
          reproduciendoRef.current = true;
          setReproduciendo(true);
          cambiandoPistaRef.current = false;
          if (deckActivoRef.current === 'A') {
            if ('mediaSession' in navigator) {
              navigator.mediaSession.playbackState = 'playing';
            }
            actualizarMediaSessionRef.current();
          }
        }}
        onPause={() => {
          // REGLA CRÍTICA: Ignorar al 100% cualquier evento pause del Deck INACTIVO o durante transiciones
          if (
            deckActivoRef.current !== 'A' ||
            ignorandoPausaSalienteRef.current ||
            cambiandoPistaRef.current ||
            crossfadingRef.current ||
            smartAutomixEngine.isMixing() ||
            recuperandoStallRef.current
          ) {
            return;
          }
          const el = deckARef.current;
          // Si la pista terminó realmente y el sistema disparó pause justo antes de ended
          if (el && (el.ended || (el.duration > 0 && el.currentTime >= el.duration - 0.6))) {
            alTerminarDeck('A');
            return;
          }
          // Solo apagar el estado de reproducción si el usuario presionó Pausa explícitamente
          if (pausadoPorUsuarioRef.current) {
            reproduciendoRef.current = false;
            setReproduciendo(false);
            if ('mediaSession' in navigator) {
              navigator.mediaSession.playbackState = 'paused';
            }
            actualizarMediaSessionRef.current();
          } else if (el && cancionActualRef.current) {
            // Si Android pausó el elemento inesperadamente sin intervención del usuario, mantener vivo el WakeLock y reanudar
            setTimeout(() => {
              if (
                !pausadoPorUsuarioRef.current &&
                deckActivoRef.current === 'A' &&
                !cambiandoPistaRef.current &&
                el.paused &&
                !el.ended
              ) {
                bassBoostManager.asegurarActivo();
                el.play().catch(() => {});
              }
            }, 150);
          }
        }}
        onStalled={() => alStallDeck('A')}
        onEnded={() => alTerminarDeck('A')}
        onError={(e) => {
          if (deckActivoRef.current !== 'A' || ignorandoPausaSalienteRef.current) return;
          alErrorDeck('A', e);
        }}
        onTimeUpdate={() => alTiempoActualDeck('A')}
        onLoadedMetadata={() => alMetadatosDeck('A')}
      />

      <audio
        ref={deckBRef}
        playsInline
        preload="auto"
        onPlay={() => {
          if (deckActivoRef.current !== 'B' && !crossfadingRef.current) return;
          pausadoPorUsuarioRef.current = false;
          bassBoostManager.asegurarActivo();
          reproduciendoRef.current = true;
          setReproduciendo(true);
          if (deckActivoRef.current === 'B') {
            if ('mediaSession' in navigator) {
              navigator.mediaSession.playbackState = 'playing';
            }
            actualizarMediaSessionRef.current();
          }
        }}
        onPlaying={() => {
          if (deckActivoRef.current !== 'B' && !crossfadingRef.current) return;
          pausadoPorUsuarioRef.current = false;
          bassBoostManager.asegurarActivo();
          programarRevocacionUrlAnterior();
          ultimoAvanceTimestampRef.current = Date.now();
          reproduciendoRef.current = true;
          setReproduciendo(true);
          cambiandoPistaRef.current = false;
          if (deckActivoRef.current === 'B') {
            if ('mediaSession' in navigator) {
              navigator.mediaSession.playbackState = 'playing';
            }
            actualizarMediaSessionRef.current();
          }
        }}
        onPause={() => {
          // REGLA CRÍTICA: Ignorar al 100% cualquier evento pause del Deck INACTIVO o durante transiciones
          if (
            deckActivoRef.current !== 'B' ||
            ignorandoPausaSalienteRef.current ||
            cambiandoPistaRef.current ||
            crossfadingRef.current ||
            smartAutomixEngine.isMixing() ||
            recuperandoStallRef.current
          ) {
            return;
          }
          const el = deckBRef.current;
          // Si la pista terminó realmente y el sistema disparó pause justo antes de ended
          if (el && (el.ended || (el.duration > 0 && el.currentTime >= el.duration - 0.6))) {
            alTerminarDeck('B');
            return;
          }
          // Solo apagar el estado de reproducción si el usuario presionó Pausa explícitamente
          if (pausadoPorUsuarioRef.current) {
            reproduciendoRef.current = false;
            setReproduciendo(false);
            if ('mediaSession' in navigator) {
              navigator.mediaSession.playbackState = 'paused';
            }
            actualizarMediaSessionRef.current();
          } else if (el && cancionActualRef.current) {
            // Si Android pausó el elemento inesperadamente sin intervención del usuario, mantener vivo el WakeLock y reanudar
            setTimeout(() => {
              if (
                !pausadoPorUsuarioRef.current &&
                deckActivoRef.current === 'B' &&
                !cambiandoPistaRef.current &&
                el.paused &&
                !el.ended
              ) {
                bassBoostManager.asegurarActivo();
                el.play().catch(() => {});
              }
            }, 150);
          }
        }}
        onStalled={() => alStallDeck('B')}
        onEnded={() => alTerminarDeck('B')}
        onError={(e) => {
          if (deckActivoRef.current !== 'B' || ignorandoPausaSalienteRef.current) return;
          alErrorDeck('B', e);
        }}
        onTimeUpdate={() => alTiempoActualDeck('B')}
        onLoadedMetadata={() => alMetadatosDeck('B')}
      />

      {/* Elemento de Audio Dedicado para Vista Previa de Búsqueda */}
      <audio
        ref={audioPreviewRef}
        playsInline
        preload="none"
      />

      {/* ========================================================================= */}
      {/* MINI-REPRODUCTOR FLOTANTE PERMANENTE (CYBER FROSTED GLASS DOCK) */}
      {/* ========================================================================= */}
      {cancionActual && !reproductorExpandido && (
        <div
          onClick={() => setReproductorExpandido(true)}
          className="cyber-mini-player"
          style={{
            cursor: 'pointer',
            padding: '8px 12px',
            boxSizing: 'border-box',
            borderLeft: `3px solid ${temaVisualActual.colorPrincipal}`
          }}
        >
          {/* Barra de progreso sutil superior con emisión desacoplada (0 re-renders) */}
          <MiniPlayerProgressBar color={temaVisualActual.colorPrincipal} isError={!!mensajeErrorAudio} />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
              <div style={{
                width: '42px',
                height: '42px',
                borderRadius: '8px',
                overflow: 'hidden',
                backgroundColor: '#121212',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}>
                {cancionActual.caratula ? (
                  <img
                    src={cancionActual.caratula}
                    alt={cancionActual.nombre}
                    loading="lazy"
                    decoding="async"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    onError={(e) => { e.currentTarget.style.display = 'none'; }}
                  />
                ) : (
                  <IconNota size={18} color="#1ED760" />
                )}
              </div>

              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{
                  margin: 0,
                  fontSize: '13px',
                  fontWeight: '700',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  color: mensajeErrorAudio ? '#ef4444' : '#FFFFFF',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px'
                }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{cancionActual.nombre}</span>
                  {/* Equalizer soundwaves animadas */}
                  <span className={`soundwave-bars ${reproduciendo ? 'active' : 'paused'}`}>
                    <span className="soundwave-bar bar-1" style={{ backgroundColor: temaVisualActual.colorPrincipal }} />
                    <span className="soundwave-bar bar-2" style={{ backgroundColor: temaVisualActual.colorPrincipal }} />
                    <span className="soundwave-bar bar-3" style={{ backgroundColor: temaVisualActual.colorPrincipal }} />
                    <span className="soundwave-bar bar-4" style={{ backgroundColor: temaVisualActual.colorPrincipal }} />
                  </span>
                  {enTransicionMix && (
                    <span style={{ fontSize: '9px', backgroundColor: '#1ED760', color: '#000000', padding: '1px 6px', borderRadius: '4px', fontWeight: '800', flexShrink: 0 }}>
                      AUTOMIX {progresoMix}%
                    </span>
                  )}
                </p>
                <MiniPlayerTimeText
                  duracionFallback={duracionTotal}
                  timerTextoRestante={timerTextoRestante}
                  mensajeErrorAudio={mensajeErrorAudio}
                />
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => ejecutarMixManualAhora()}
                title="Mezclar con la siguiente canción ahora (Spotify Crossfade)"
                style={{
                  background: enTransicionMix ? '#1ED760' : 'rgba(30, 215, 96, 0.14)',
                  color: enTransicionMix ? '#000000' : '#1ED760',
                  border: '1px solid rgba(30, 215, 96, 0.45)',
                  borderRadius: '500px',
                  padding: '4px 8px',
                  fontSize: '10px',
                  fontWeight: '800',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '3px'
                }}
              >
                <span>🔀</span>
                <span>Mix</span>
              </button>

              <button
                onClick={(e) => alternarFavorito(cancionActual.nombre, e)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: cancionActual.favorito ? '#1ED760' : '#B3B3B3'
                }}
              >
                <IconCorazon size={20} lleno={cancionActual.favorito} />
              </button>

              <button
                onClick={alternarReproduccion}
                style={{
                  backgroundColor: '#FFFFFF',
                  color: '#000000',
                  border: 'none',
                  borderRadius: '50%',
                  width: '36px',
                  height: '36px',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: '0 4px 12px rgba(255, 255, 255, 0.25)',
                  transition: 'transform 0.1s ease'
                }}
                onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.92)'; }}
                onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
              >
                {reproduciendo ? (
                  <IconPausa size={16} color="#000000" />
                ) : (
                  <IconPlay size={16} color="#000000" />
                )}
              </button>

              <button
                onClick={reproducirSiguiente}
                style={{
                  backgroundColor: 'transparent',
                  color: '#B3B3B3',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <IconSiguiente size={18} color="#B3B3B3" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* BARRA DE NAVEGACIÓN INFERIOR (FROSTED GLASS DOCK) */}
      {/* ========================================================================= */}
      <nav className="frosted-bottom-dock">
        <button
          onClick={() => React.startTransition(() => setTabActiva('inicio'))}
          className={`dock-nav-btn ${tabActiva === 'inicio' ? 'active' : ''}`}
        >
          <IconInicio size={22} color={tabActiva === 'inicio' ? '#1ED760' : '#A7A7A7'} />
          <span>Inicio</span>
          {tabActiva === 'inicio' && <span className="dock-glow-indicator" />}
        </button>

        <button
          onClick={() => React.startTransition(() => setTabActiva('buscar'))}
          className={`dock-nav-btn ${tabActiva === 'buscar' ? 'active' : ''}`}
        >
          <IconBuscar size={22} color={tabActiva === 'buscar' ? '#1ED760' : '#A7A7A7'} />
          <span>Buscar</span>
          {tabActiva === 'buscar' && <span className="dock-glow-indicator" />}
        </button>

        <button
          onClick={() => React.startTransition(() => setTabActiva('biblioteca'))}
          className={`dock-nav-btn ${tabActiva === 'biblioteca' ? 'active' : ''}`}
        >
          <IconBiblioteca size={22} color={tabActiva === 'biblioteca' ? '#1ED760' : '#A7A7A7'} />
          <span>Tu Biblioteca</span>
          {tabActiva === 'biblioteca' && <span className="dock-glow-indicator" />}
        </button>

        <button
          onClick={() => React.startTransition(() => setTabActiva('ajustes'))}
          className={`dock-nav-btn ${tabActiva === 'ajustes' ? 'active' : ''}`}
        >
          <IconAjustes size={22} color={tabActiva === 'ajustes' ? '#1ED760' : '#A7A7A7'} />
          <span>Ajustes</span>
          {tabActiva === 'ajustes' && <span className="dock-glow-indicator" />}
        </button>
      </nav>

      {/* ========================================================================= */}
      {/* REPRODUCTOR EN PANTALLA COMPLETA EXPANDIDO (SPOTIFY STYLE) */}
      {/* ========================================================================= */}
      {cancionActual && reproductorExpandido && (
        <div className="reproductor-expandido-modal" style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: temaVisualActual.colorFondo,
          transition: 'background-color 1.2s cubic-bezier(0.2, 0.8, 0.2, 1)',
          zIndex: 200,
          display: 'flex',
          flexDirection: 'column',
          padding: '24px 20px',
          boxSizing: 'border-box',
          overflowY: 'auto'
        }}>
          {/* Fondo Dinámico Animado en Movimiento por Canción */}
          <FondoAnimado
            tema={temaVisualActual}
            reproduciendo={reproduciendo}
            activo={animacionFondoActiva}
          />

          {/* Contenedor relativo para contenidos del reproductor sobre el fondo animado */}
          <div className="reproductor-expandido-contenido" style={{
            position: 'relative',
            zIndex: 2,
            display: 'flex',
            flexDirection: 'column',
            minHeight: '100%',
            justifyContent: 'space-between',
            width: '100%'
          }}>
            {/* Cabecera del reproductor */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px', flexWrap: 'wrap', gap: '8px' }}>
              <button
                onClick={() => setReproductorExpandido(false)}
                style={{
                  backgroundColor: 'transparent',
                  color: '#FFFFFF',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
              >
                <IconChevronAbajo size={24} color="#FFFFFF" />
              </button>

              <div style={{ textAlign: 'center' }}>
                <span style={{ fontSize: '11px', textTransform: 'uppercase', color: '#B3B3B3', letterSpacing: '1px', fontWeight: '700' }}>
                  Reproduciendo de {playlistSeleccionada ? playlistSeleccionada.nombre : 'Biblioteca'}
                </span>
              </div>

              <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                {/* Botón rápido para saltar al siguiente fondo visual al instante */}
                <button
                  onClick={avanzarSiguienteFondo}
                  title="Cambiar al siguiente fondo visual"
                  style={{
                    backgroundColor: 'rgba(24, 24, 28, 0.72)',
                    color: '#FFFFFF',
                    border: `1px solid ${temaVisualActual.colorPrincipal}66`,
                    borderRadius: '500px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    transition: 'transform 0.15s ease'
                  }}
                >
                  <span>🖼️ Cambiar Fondo</span>
                </button>

                {/* Selector de Tema Visual Dinámico */}
                <button
                  onClick={alternarTemaVisual}
                  title={`Tema Visual: ${temaSeleccionadoManual ? temaVisualActual.nombre : `Automático (${temaVisualActual.nombre})`}. Toca para abrir galería.`}
                  style={{
                    backgroundColor: 'rgba(24, 24, 28, 0.72)',
                    color: '#FFFFFF',
                    border: `1px solid ${temaVisualActual.colorPrincipal}88`,
                    borderRadius: '500px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    boxShadow: `0 0 12px ${temaVisualActual.colorPrincipal}22`,
                    transition: 'all 0.2s ease'
                  }}
                >
                  <span
                    style={{
                      width: '9px',
                      height: '9px',
                      borderRadius: '50%',
                      backgroundColor: temaVisualActual.colorPrincipal,
                      display: 'inline-block',
                      boxShadow: `0 0 8px ${temaVisualActual.colorPrincipal}`
                    }}
                  />
                  <span>{modoCarruselFondos ? `🔄 Fondos (${intervaloFondosSegundos}s)` : temaSeleccionadoManual ? temaVisualActual.nombre : 'Auto'}</span>
                </button>

                <button
                  onClick={() => {
                    const opciones = [0, 3, 5, 8, 12];
                    const idx = opciones.indexOf(crossfadeSegundos);
                    const siguiente = opciones[(idx + 1) % opciones.length];
                    cambiarCrossfade(siguiente);
                  }}
                  title={`Fundido cruzado (Crossfade): ${crossfadeSegundos > 0 ? `${crossfadeSegundos}s activo` : 'Desactivado'}`}
                  style={{
                    backgroundColor: crossfadeSegundos > 0 ? '#1ED760' : '#242424',
                    color: crossfadeSegundos > 0 ? '#000000' : '#FFFFFF',
                    border: 'none',
                    borderRadius: '500px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <IconMix size={15} color={crossfadeSegundos > 0 ? '#000000' : '#FFFFFF'} />
                  <span>{crossfadeSegundos > 0 ? `${crossfadeSegundos}s` : 'Mix off'}</span>
                </button>

                {/* Botón de Mix Instantáneo (Spotify DJ Transition) */}
                <button
                  onClick={() => ejecutarMixManualAhora()}
                  title="Mezclar hacia la siguiente canción ahora mismo con Crossfade"
                  style={{
                    background: enTransicionMix
                      ? 'linear-gradient(135deg, #1ED760, #10b981)'
                      : 'rgba(30, 215, 96, 0.18)',
                    color: enTransicionMix ? '#000000' : '#1ED760',
                    border: '1px solid rgba(30, 215, 96, 0.55)',
                    borderRadius: '500px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: '800',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    boxShadow: enTransicionMix ? '0 0 14px rgba(30, 215, 96, 0.45)' : 'none'
                  }}
                >
                  <span>🔀</span>
                  <span>{enTransicionMix ? `Mix ${progresoMix}%` : 'Mix Ya'}</span>
                </button>

                {/* Botón único de Bass Boost Auto-Adaptativo */}
                <button
                  onClick={() => alternarBassBoost()}
                  title={`Bass Boost Auto: ${bassBoostActivo ? 'Activado (Adaptación automática al ritmo)' : 'Desactivado'}`}
                  style={{
                    backgroundColor: bassBoostActivo ? '#1db954' : '#242424',
                    color: bassBoostActivo ? '#000000' : '#FFFFFF',
                    border: bassBoostActivo ? 'none' : '1px solid rgba(255, 255, 255, 0.1)',
                    borderRadius: '500px',
                    padding: '6px 14px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '5px',
                    boxShadow: bassBoostActivo ? '0 0 10px rgba(29, 185, 84, 0.35)' : 'none',
                    transition: 'all 0.15s ease'
                  }}
                >
                  <span>🔊</span>
                  <span>Bass Auto</span>
                </button>

                <button
                  onClick={() => setModalTimerAbierto(true)}
                  title="Temporizador de apagado"
                  style={{
                    backgroundColor: timerTextoRestante ? '#1ED760' : '#242424',
                    color: timerTextoRestante ? '#000000' : '#FFFFFF',
                    border: 'none',
                    borderRadius: '500px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <IconLuna size={15} color={timerTextoRestante ? '#000000' : '#FFFFFF'} />
                  {timerTextoRestante ? <span>{timerTextoRestante}</span> : null}
                </button>

                <button
                  onClick={() => setModalColaAbierto(true)}
                  title="Ver cola de reproducción"
                  style={{
                    backgroundColor: colaReproduccion.length > 0 ? '#1ED760' : '#242424',
                    color: colaReproduccion.length > 0 ? '#000000' : '#FFFFFF',
                    border: 'none',
                    borderRadius: '500px',
                    padding: '6px 12px',
                    fontSize: '12px',
                    fontWeight: '700',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px'
                  }}
                >
                  <IconCola size={15} color={colaReproduccion.length > 0 ? '#000000' : '#FFFFFF'} />
                  {colaReproduccion.length > 0 ? <span>{colaReproduccion.length}</span> : null}
                </button>
              </div>
            </div>

            {/* Carátula Grande Moderna (Relación 1:1, bordes redondeados 20px, sombra ambiental suave y gesto Swipe) */}
            <div
              onTouchStart={(e) => {
                if (e.touches && e.touches.length === 1) {
                  swipeTouchStartXRef.current = e.touches[0].clientX;
                  swipeTouchStartYRef.current = e.touches[0].clientY;
                }
              }}
              onTouchEnd={(e) => {
                if (
                  swipeTouchStartXRef.current !== null &&
                  swipeTouchStartYRef.current !== null &&
                  e.changedTouches &&
                  e.changedTouches.length === 1
                ) {
                  const dx = e.changedTouches[0].clientX - swipeTouchStartXRef.current;
                  const dy = e.changedTouches[0].clientY - swipeTouchStartYRef.current;
                  swipeTouchStartXRef.current = null;
                  swipeTouchStartYRef.current = null;
                  if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.4) {
                    if (dx < 0) {
                      ejecutarMixManualAhora();
                    } else {
                      reproducirAnterior();
                    }
                  }
                }
              }}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                alignItems: 'center',
                minHeight: '280px',
                marginBottom: '20px'
              }}
            >
              <div style={{
                width: 'min(72vw, 276px)',
                aspectRatio: '1 / 1',
                borderRadius: '20px',
                overflow: 'hidden',
                backgroundColor: 'rgba(20, 20, 26, 0.78)',
                border: '1px solid rgba(255, 255, 255, 0.14)',
                boxShadow: reproduciendo
                  ? `0 24px 60px rgba(0,0,0,0.75), 0 0 48px ${temaVisualActual.colorPrincipal}44`
                  : '0 18px 42px rgba(0,0,0,0.72)',
                transform: reproduciendo ? 'scale(1)' : 'scale(0.94)',
                transition: 'transform 0.38s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.45s ease',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}>
                <img
                  src={obtenerUrlCaratulaValida(cancionActual.caratula, cancionActual.nombre, cancionActual.artista)}
                  alt={limpiarTextoMetadata(cancionActual.nombre)}
                  loading="eager"
                  decoding="async"
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (!img.dataset.fallback) {
                      img.dataset.fallback = '1';
                      img.src = '/icon-512.png';
                    }
                  }}
                />
              </div>
            </div>

          {/* Error visible si falló decodificación */}
          {mensajeErrorAudio && (
            <div style={{ backgroundColor: 'rgba(239,68,68,0.2)', border: '1px solid #ef4444', borderRadius: '8px', padding: '10px 14px', marginBottom: '14px', textAlign: 'center' }}>
              <p style={{ margin: 0, fontSize: '13px', color: '#fca5a5' }}>
                {mensajeErrorAudio}
              </p>
            </div>
          )}

          {/* Nombre de la canción y subtítulo */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <div style={{ minWidth: 0, flex: 1, paddingRight: '12px' }}>
              <h2 style={{
                fontSize: '22px',
                fontWeight: '800',
                margin: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                color: '#FFFFFF',
                letterSpacing: '-0.4px',
                display: 'flex',
                alignItems: 'center',
                gap: '8px'
              }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{limpiarTextoMetadata(cancionActual.nombre)}</span>
                {enTransicionMix && (
                  <span style={{ fontSize: '10px', backgroundColor: '#1ED760', color: '#000000', padding: '2px 7px', borderRadius: '4px', fontWeight: '800', flexShrink: 0 }}>
                    AUTOMIX {progresoMix}%
                  </span>
                )}
              </h2>
              <p style={{ margin: '4px 0 0 0', fontSize: '13px', color: '#CBD5E1' }}>
                {cancionActual.artista ? `${limpiarTextoMetadata(cancionActual.artista)} • ` : ''}Audio Oficial • {crossfadeSegundos > 0 ? `Automix ${crossfadeSegundos}s` : 'Sin Anuncios'}
              </p>
            </div>

            <button
              onClick={() => alternarFavorito(cancionActual.nombre)}
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '6px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: cancionActual.favorito ? '#1ED760' : '#B3B3B3'
              }}
            >
              <IconCorazon size={26} lleno={cancionActual.favorito} />
            </button>
          </div>

          {/* Banner en vivo cuando Spotify Automix está mezclando dos canciones */}
          {enTransicionMix && (
            <div style={{
              marginBottom: '14px',
              padding: '10px 14px',
              borderRadius: '12px',
              background: 'linear-gradient(135deg, rgba(30, 215, 96, 0.22) 0%, rgba(16, 185, 129, 0.08) 100%)',
              border: '1px solid rgba(30, 215, 96, 0.5)',
              boxShadow: '0 4px 16px rgba(30, 215, 96, 0.18)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px', gap: '8px' }}>
                <span style={{ fontSize: '11.5px', fontWeight: '800', color: '#1ED760', display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  <span>🎧 SPOTIFY AUTOMIX EN VIVO</span>
                  {cancionSalienteMix ? <span style={{ color: '#E2E8F0', fontWeight: '600' }}>• {cancionSalienteMix} ➔ {cancionActual.nombre}</span> : null}
                </span>
                <span style={{ fontSize: '11px', fontWeight: '900', color: '#FFFFFF', flexShrink: 0 }}>
                  {progresoMix}%
                </span>
              </div>
              <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.14)', borderRadius: '999px', overflow: 'hidden' }}>
                <div style={{
                  width: `${progresoMix}%`,
                  height: '100%',
                  backgroundColor: '#1ED760',
                  borderRadius: '999px',
                  transition: 'width 0.12s linear'
                }} />
              </div>
            </div>
          )}

          {/* Píldora "Siguiente en el Mix" para ver y mezclar al instante la próxima pista */}
          {!enTransicionMix && (() => {
            const prox = obtenerSiguienteCancion();
            if (!prox || prox.nombre === cancionActual.nombre) return null;
            return (
              <div style={{
                marginBottom: '14px',
                padding: '7px 12px',
                borderRadius: '10px',
                backgroundColor: 'rgba(255, 255, 255, 0.06)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '8px'
              }}>
                <div style={{ minWidth: 0, flex: 1, display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '10px', fontWeight: '800', color: '#1ED760', textTransform: 'uppercase', letterSpacing: '0.5px', flexShrink: 0 }}>
                    ⏭ Siguiente Mix:
                  </span>
                  <span style={{ fontSize: '11.5px', color: '#E2E8F0', fontWeight: '600', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {prox.nombre}
                  </span>
                </div>
                <button
                  onClick={() => ejecutarMixManualAhora()}
                  style={{
                    backgroundColor: 'rgba(30, 215, 96, 0.16)',
                    color: '#1ED760',
                    border: '1px solid rgba(30, 215, 96, 0.4)',
                    borderRadius: '500px',
                    padding: '3px 10px',
                    fontSize: '10.5px',
                    fontWeight: '800',
                    cursor: 'pointer',
                    flexShrink: 0
                  }}
                >
                  🔀 Mixear ya
                </button>
              </div>
            );
          })()}

          {/* Barra Scrubber Principal Estilo Spotify Desacoplada (0 re-renders de App) */}
          <ExpandedPlayerScrubber
            color="#1ED760"
            duracionTotal={duracionTotal}
            onArrastrandoChange={setArrastrandoSeek}
            onSeek={(nuevo) => {
              cancelarCrossfade();
              const activo = getActiveDeckEl();
              if (activo) {
                activo.currentTime = nuevo;
                audioProgress.emit(nuevo, duracionTotal);
              }
            }}
          />

          {/* Controles de reproducción principales */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '28px',
            padding: '0 8px'
          }}>
            <button
              onClick={alternarModoAleatorio}
              title={modoAleatorio ? 'Modo aleatorio activado' : 'Modo aleatorio desactivado'}
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <IconAleatorio size={22} color={modoAleatorio ? '#1ED760' : '#777777'} />
            </button>

            <button
              onClick={reproducirAnterior}
              title="Anterior"
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <IconAnterior size={26} color="#FFFFFF" />
            </button>

            <button
              onClick={alternarReproduccion}
              title={reproduciendo ? 'Pausar' : 'Reproducir'}
              style={{
                backgroundColor: '#FFFFFF',
                color: '#000000',
                border: 'none',
                borderRadius: '50%',
                width: '64px',
                height: '64px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                boxShadow: '0 6px 20px rgba(255, 255, 255, 0.25)',
                transition: 'transform 0.15s ease'
              }}
              onMouseDown={(e) => { e.currentTarget.style.transform = 'scale(0.95)'; }}
              onMouseUp={(e) => { e.currentTarget.style.transform = 'scale(1)'; }}
            >
              {reproduciendo ? (
                <IconPausa size={28} color="#000000" />
              ) : (
                <IconPlay size={28} color="#000000" />
              )}
            </button>

            <button
              onClick={reproducirSiguiente}
              title="Siguiente"
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <IconSiguiente size={26} color="#FFFFFF" />
            </button>

            <button
              onClick={cambiarModoRepeticion}
              title={
                modoRepeticion === 'one'
                  ? 'Repetir canción actual'
                  : modoRepeticion === 'all'
                  ? 'Repetir lista'
                  : 'Repetición desactivada'
              }
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '8px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <IconRepetir size={22} modo={modoRepeticion} color={modoRepeticion !== 'off' ? '#1ED760' : '#777777'} />
            </button>
          </div>

          {/* Opciones auxiliares inferiores */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: '14px' }}>
            <button
              onClick={() => saltarTiempo(-10)}
              style={{
                backgroundColor: '#242424',
                color: '#FFFFFF',
                border: '1px solid #333333',
                borderRadius: '500px',
                padding: '8px 16px',
                fontSize: '12px',
                fontWeight: '700',
                cursor: 'pointer'
              }}
            >
              -10s
            </button>

            <button
              onClick={(e) => exportarCancion(cancionActual, e)}
              style={{
                backgroundColor: '#242424',
                color: '#FFFFFF',
                border: '1px solid #333333',
                borderRadius: '500px',
                padding: '8px 16px',
                fontSize: '12px',
                fontWeight: '700',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px'
              }}
            >
              <IconDescargar size={14} color="#FFFFFF" />
              <span>Guardar .mp3</span>
            </button>

            <button
              onClick={() => saltarTiempo(10)}
              style={{
                backgroundColor: '#242424',
                color: '#FFFFFF',
                border: '1px solid #333333',
                borderRadius: '500px',
                padding: '8px 16px',
                fontSize: '12px',
                fontWeight: '700',
                cursor: 'pointer'
              }}
            >
              +10s
            </button>
          </div>

          {/* Barra de Control de Volumen y Velocidad Estilo Spotify */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            marginTop: '20px',
            padding: '10px 14px',
            backgroundColor: 'rgba(255, 255, 255, 0.05)',
            borderRadius: '12px',
            border: '1px solid rgba(255, 255, 255, 0.08)',
            maxWidth: '460px',
            margin: '20px auto 0 auto',
            width: '100%',
            boxSizing: 'border-box'
          }}>
            {/* Botón Silencio / Icono de Volumen */}
            <button
              onClick={alternarSilencio}
              title={silenciado ? 'Activar sonido' : 'Silenciar'}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px',
                display: 'flex',
                alignItems: 'center',
                color: silenciado ? '#ef4444' : '#B3B3B3',
                transition: 'color 0.15s ease'
              }}
            >
              <IconVolumen size={20} nivel={volumen} silenciado={silenciado} color={silenciado ? '#ef4444' : '#B3B3B3'} />
            </button>

            {/* Slider de Volumen */}
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={silenciado ? 0 : volumen}
                onChange={(e) => cambiarVolumen(parseFloat(e.target.value))}
                style={{ width: '100%', accentColor: '#1ED760' }}
                title={`Volumen: ${Math.round((silenciado ? 0 : volumen) * 100)}%`}
              />
              <span style={{ fontSize: '11px', color: '#B3B3B3', minWidth: '32px', textAlign: 'right', fontWeight: '600' }}>
                {Math.round((silenciado ? 0 : volumen) * 100)}%
              </span>
            </div>

            {/* Selector de Velocidad y Tono (Slowed / Normal / Sped Up) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
              {[
                { label: '0.88x (Slowed)', val: 0.88 },
                { label: '1.0x', val: 1 },
                { label: '1.12x (Sped Up)', val: 1.12 }
              ].map((v) => (
                <button
                  key={v.val}
                  onClick={() => cambiarVelocidad(v.val)}
                  title={`Velocidad ${v.label}`}
                  style={{
                    backgroundColor: velocidad === v.val ? '#1ED760' : 'rgba(255, 255, 255, 0.08)',
                    color: velocidad === v.val ? '#000000' : '#FFFFFF',
                    border: velocidad === v.val ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.12)',
                    borderRadius: '500px',
                    padding: '3px 7px',
                    fontSize: '10px',
                    fontWeight: '800',
                    cursor: 'pointer',
                    transition: 'all 0.15s ease'
                  }}
                >
                  {v.val === 1 ? '1.0x' : v.val === 0.88 ? '0.88x' : '1.12x'}
                </button>
              ))}
            </div>
          </div>

          {/* Fila de Acciones Estilo Spotify (Dispositivo a la izquierda, Compartir y Cola a la derecha - Círculo Verde) */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            maxWidth: '460px',
            margin: '18px auto 0 auto',
            width: '100%',
            boxSizing: 'border-box',
            padding: '0 4px'
          }}>
            {/* Dispositivo de reproducción actual */}
            <div
              onClick={() => mostrarToast('Reproduciendo en este dispositivo', 'info')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: '#1ED760',
                fontSize: '12px',
                fontWeight: '700',
                cursor: 'pointer',
                letterSpacing: '0.2px'
              }}
              title="Dispositivo actual"
            >
              <IconDispositivo size={18} color="#1ED760" />
              <span>Este dispositivo</span>
            </div>

            {/* Opciones derechas: Compartir y Cola de Reproducción (Círculo verde de Spotify) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
              <button
                onClick={() => {
                  const textoCompartir = `🎵 Escuchando: "${cancionActual.nombre}" en Mi App de Música`;
                  if (navigator.share) {
                    navigator.share({ title: cancionActual.nombre, text: textoCompartir }).catch(() => {});
                  } else if (navigator.clipboard) {
                    navigator.clipboard.writeText(textoCompartir);
                    mostrarToast('¡Copiado al portapapeles!');
                  }
                }}
                title="Compartir canción"
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#B3B3B3',
                  cursor: 'pointer',
                  padding: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'color 0.15s'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#FFFFFF'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = '#B3B3B3'; }}
              >
                <IconCompartir size={20} color="currentColor" />
              </button>

              <button
                onClick={() => setModalColaAbierto(true)}
                title="Cola de reproducción"
                style={{
                  background: 'none',
                  border: 'none',
                  color: colaReproduccion.length > 0 ? '#1ED760' : '#B3B3B3',
                  cursor: 'pointer',
                  padding: '6px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  position: 'relative',
                  transition: 'color 0.15s'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#FFFFFF'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = colaReproduccion.length > 0 ? '#1ED760' : '#B3B3B3'; }}
              >
                <IconCola size={20} color="currentColor" />
                {colaReproduccion.length > 0 && (
                  <span style={{
                    position: 'absolute',
                    top: '-2px',
                    right: '-2px',
                    backgroundColor: '#1ED760',
                    color: '#000000',
                    borderRadius: '50%',
                    width: '14px',
                    height: '14px',
                    fontSize: '9px',
                    fontWeight: '900',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    {colaReproduccion.length}
                  </span>
                )}
              </button>
            </div>
          </div>

          {/* Tarjeta de Letra de Canción (Estilo Spotify Mobile con sincronización en tiempo real - Círculo Rojo) */}
          <div
            onClick={() => setModalLetrasAbierto(true)}
            style={{
              maxWidth: '460px',
              width: '100%',
              margin: '20px auto 0 auto',
              background: `linear-gradient(145deg, ${temaVisualActual.colorPrincipal}33 0%, rgba(24, 24, 28, 0.88) 100%)`,
              border: `1px solid ${temaVisualActual.colorPrincipal}55`,
              borderRadius: '18px',
              padding: '16px 18px',
              boxSizing: 'border-box',
              cursor: 'pointer',
              boxShadow: `0 12px 30px rgba(0,0,0,0.6), 0 0 20px ${temaVisualActual.colorPrincipal}18`,
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              transition: 'transform 0.18s ease, box-shadow 0.18s ease'
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; }}
          >
            {/* Header de la tarjeta de letra */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <IconMicrofono size={16} color={temaVisualActual.colorPrincipal} />
                <span style={{ fontSize: '15px', fontWeight: '800', color: '#FFFFFF', letterSpacing: '0.2px' }}>
                  Letra
                </span>
                {infoLetra?.sincronizada && (
                  <span style={{
                    fontSize: '10px',
                    fontWeight: '800',
                    backgroundColor: 'rgba(30, 215, 96, 0.2)',
                    color: '#1ED760',
                    border: '1px solid rgba(30, 215, 96, 0.4)',
                    padding: '2px 7px',
                    borderRadius: '100px',
                    textTransform: 'uppercase',
                    letterSpacing: '0.5px'
                  }}>
                    Sincronizada
                  </span>
                )}
              </div>

              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: '5px',
                backgroundColor: 'rgba(255, 255, 255, 0.12)',
                padding: '4px 10px',
                borderRadius: '500px',
                fontSize: '11px',
                fontWeight: '700',
                color: '#FFFFFF'
              }}>
                <IconExpandir size={13} color="#FFFFFF" />
                <span>AMPLIAR</span>
              </div>
            </div>

            {/* Contenido / Vista previa de la letra */}
            {cargandoLetras ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 0', color: '#B3B3B3', fontSize: '13px' }}>
                <IconSpinner size={16} color={temaVisualActual.colorPrincipal} />
                <span>Buscando letra de la canción...</span>
              </div>
            ) : infoLetra && infoLetra.lineas && infoLetra.lineas.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px 0' }}>
                <LetrasPreviewSnippet infoLetra={infoLetra} colorPrincipal={temaVisualActual.colorPrincipal} />
              </div>
            ) : (
              <div style={{ padding: '8px 0', color: '#94A3B8', fontSize: '13px' }}>
                <span>Letra oficial no disponible para esta canción</span>
              </div>
            )}
          </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL DE LETRAS DE CANCIONES A PANTALLA COMPLETA (SPOTIFY KARAOKE STYLE) */}
      {/* ========================================================================= */}
      {modalLetrasAbierto && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: '#0e0e12',
          zIndex: 960,
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
          animation: 'modalFadeIn 0.25s ease-out',
          overflow: 'hidden'
        }}>
          {/* Fondo con imagen nítida al 0.58 y gradiente suavizado */}
          {temaVisualActual.imagenUrl && (
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                bottom: 0,
                backgroundImage: `url(${temaVisualActual.imagenUrl})`,
                backgroundSize: 'cover',
                backgroundPosition: 'center',
                opacity: 0.58,
                zIndex: 0
              }}
            />
          )}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background: 'linear-gradient(180deg, rgba(14,14,18,0.22) 0%, rgba(14,14,18,0.58) 65%, rgba(14,14,18,0.86) 100%)',
              zIndex: 1,
              pointerEvents: 'none'
            }}
          />

          {/* Cabecera del visor de letra */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '20px 24px',
            borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
            backgroundColor: 'rgba(10, 10, 12, 0.65)',
            backdropFilter: 'blur(10px)',
            position: 'relative',
            zIndex: 10
          }}>
            <div style={{ overflow: 'hidden', paddingRight: '12px' }}>
              <span style={{ fontSize: '11px', textTransform: 'uppercase', color: temaVisualActual.colorPrincipal, letterSpacing: '1.2px', fontWeight: '800' }}>
                {infoLetra?.sincronizada ? '🎤 Letra Sincronizada' : '📜 Letra de la Canción'}
              </span>
              <h2 style={{
                margin: '2px 0 0 0',
                fontSize: '19px',
                fontWeight: '900',
                color: '#FFFFFF',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
              }}>
                {parsearTituloYArtista(cancionActual?.nombre || '', cancionActual?.artista).tituloLimpio || cancionActual?.nombre}
              </h2>
              <p style={{ margin: '2px 0 0 0', fontSize: '13px', color: '#94A3B8' }}>
                {parsearTituloYArtista(cancionActual?.nombre || '', cancionActual?.artista).artistaLimpio || cancionActual?.artista || 'Artista'}
              </p>
            </div>

            <button
              onClick={() => setModalLetrasAbierto(false)}
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.12)',
                border: 'none',
                color: '#FFFFFF',
                borderRadius: '50%',
                width: '38px',
                height: '38px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                fontSize: '18px',
                flexShrink: 0
              }}
            >
              ✕
            </button>
          </div>

          {/* Lista de Versos con Desplazamiento Suave y Toque para Saltar */}
          <div
            ref={listaLetrasRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '40px 24px 100px 24px',
              display: 'flex',
              flexDirection: 'column',
              gap: '22px',
              alignItems: 'flex-start',
              maxWidth: '680px',
              width: '100%',
              margin: '0 auto',
              boxSizing: 'border-box',
              position: 'relative',
              zIndex: 5
            }}
          >
            {cargandoLetras ? (
              <div style={{ margin: 'auto', textAlign: 'center', color: '#FFFFFF' }}>
                <IconSpinner size={36} color={temaVisualActual.colorPrincipal} />
                <p style={{ marginTop: '14px', fontSize: '15px', color: '#94A3B8' }}>
                  Buscando letra oficial verificada en tiempo real...
                </p>
              </div>
            ) : infoLetra && infoLetra.lineas && infoLetra.lineas.length > 0 ? (
              infoLetra.lineas.map((linea, idx) => {
                const esActiva = idx === lineaActivaIndex;
                return (
                  <div
                    key={idx}
                    onClick={() => {
                      if (infoLetra.sincronizada) {
                        saltarATiempo(linea.segundos);
                      }
                    }}
                    style={{
                      cursor: infoLetra.sincronizada ? 'pointer' : 'default',
                      fontSize: esActiva ? '26px' : '20px',
                      fontWeight: esActiva ? '900' : '700',
                      color: esActiva ? '#FFFFFF' : 'rgba(255, 255, 255, 0.35)',
                      textShadow: esActiva ? `0 0 16px ${temaVisualActual.colorPrincipal}, 0 0 32px ${temaVisualActual.colorPrincipal}66` : 'none',
                      transform: esActiva ? 'scale(1.03)' : 'scale(1)',
                      transformOrigin: 'left center',
                      transition: 'all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)',
                      lineHeight: 1.4,
                      padding: '4px 0'
                    }}
                  >
                    {linea.texto}
                  </div>
                );
              })
            ) : (
              <div style={{ margin: 'auto', textAlign: 'center', color: '#94A3B8', padding: '20px' }}>
                <p style={{ fontSize: '16px', fontWeight: '700', color: '#FFFFFF', marginBottom: '8px' }}>
                  Letra oficial no disponible para esta canción
                </p>
                <p style={{ fontSize: '13px', maxWidth: '360px', margin: '0 auto 16px auto', color: '#888' }}>
                  No se encontraron coincidencias exactas en LRCLIB para esta canción.
                </p>
                <button
                  onClick={() => cancionActual && cargarLetrasCancion(cancionActual, true)}
                  style={{
                    backgroundColor: temaVisualActual.colorPrincipal,
                    color: '#000000',
                    border: 'none',
                    borderRadius: '500px',
                    padding: '8px 18px',
                    fontWeight: '800',
                    cursor: 'pointer',
                    fontSize: '13px'
                  }}
                >
                  🔄 Reintentar búsqueda
                </button>
              </div>
            )}
          </div>

          {/* Mini-Barra de Control en la parte inferior del Karaoke */}
          <div style={{
            padding: '14px 20px',
            backgroundColor: 'rgba(10, 10, 12, 0.85)',
            borderTop: '1px solid rgba(255, 255, 255, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            backdropFilter: 'blur(10px)',
            maxWidth: '680px',
            width: '100%',
            margin: '0 auto',
            boxSizing: 'border-box',
            position: 'relative',
            zIndex: 10
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
              <button
                onClick={alternarReproduccion}
                style={{
                  backgroundColor: '#FFFFFF',
                  color: '#000000',
                  border: 'none',
                  borderRadius: '50%',
                  width: '42px',
                  height: '42px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer'
                }}
              >
                {reproduciendo ? <IconPausa size={20} color="#000000" /> : <IconPlay size={20} color="#000000" />}
              </button>
              <div>
                <span style={{ fontSize: '13px', fontWeight: '700', color: '#FFFFFF', display: 'block' }}>
                  {cancionActual?.nombre}
                </span>
                <DrawerTimeText duracionFallback={duracionTotal} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => saltarTiempo(-10)}
                style={{
                  backgroundColor: '#202024',
                  color: '#FFFFFF',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '500px',
                  padding: '6px 12px',
                  fontSize: '11px',
                  fontWeight: '700',
                  cursor: 'pointer'
                }}
              >
                -10s
              </button>
              <button
                onClick={() => saltarTiempo(10)}
                style={{
                  backgroundColor: '#202024',
                  color: '#FFFFFF',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '500px',
                  padding: '6px 12px',
                  fontSize: '11px',
                  fontWeight: '700',
                  cursor: 'pointer'
                }}
              >
                +10s
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL DE MENÚ CONTEXTUAL DE CANCIÓN (SPOTIFY PREMIUM STYLE) */}
      {/* ========================================================================= */}
      {menuCancion && (
        <div
          onClick={() => setMenuCancion(null)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.75)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            zIndex: 400,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-end',
            padding: '0 0 16px 0'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: '#1e1e1e',
              border: '1px solid #333333',
              borderRadius: '20px',
              padding: '20px 16px',
              width: '94%',
              maxWidth: '440px',
              boxSizing: 'border-box',
              boxShadow: '0 20px 40px rgba(0,0,0,0.9)',
              animation: 'modalSlideUp 0.2s ease-out'
            }}
          >
            {/* Cabecera de la pista */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', paddingBottom: '16px', borderBottom: '1px solid #2a2a2a', marginBottom: '8px' }}>
              <div style={{
                width: '46px',
                height: '46px',
                borderRadius: '6px',
                backgroundColor: '#282828',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0
              }}>
                <IconNota size={22} color="#1ED760" />
              </div>
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ margin: 0, fontWeight: '700', fontSize: '15px', color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {menuCancion.nombre}
                </p>
                <p style={{ margin: '2px 0 0 0', fontSize: '12px', color: '#B3B3B3' }}>
                  {formatearTiempo(menuCancion.duracion)}{menuCancion.tamano > 0 ? ` • ${formatearTamano(menuCancion.tamano)}` : ''}
                </p>
              </div>
            </div>

            {/* Opciones */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <button
                onClick={() => {
                  reproducirCancion(menuCancion);
                  setMenuCancion(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '12px 10px',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  color: '#FFFFFF',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background-color 0.15s ease'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2a2a2a'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <IconPlay size={18} color="#1ED760" />
                <span>Reproducir ahora</span>
              </button>

              <button
                onClick={() => {
                  alternarFavorito(menuCancion.nombre);
                  setMenuCancion(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '12px 10px',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  color: '#FFFFFF',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background-color 0.15s ease'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2a2a2a'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <IconCorazon size={18} lleno={menuCancion.favorito} />
                <span>{menuCancion.favorito ? 'Quitar de Favoritas' : 'Marcar como Favorita'}</span>
              </button>

              <button
                onClick={() => {
                  agregarACola(menuCancion);
                  setMenuCancion(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '12px 10px',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  color: '#FFFFFF',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background-color 0.15s ease'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2a2a2a'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <IconCola size={18} color="#B3B3B3" />
                <span>Agregar a la cola de reproducción</span>
              </button>

              <button
                onClick={() => {
                  setCancionParaPlaylist(menuCancion);
                  setModalPlaylistAbierto(true);
                  setMenuCancion(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '12px 10px',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  color: '#FFFFFF',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background-color 0.15s ease'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2a2a2a'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <IconBiblioteca size={18} color="#B3B3B3" />
                <span>Añadir a playlist...</span>
              </button>

              <button
                onClick={() => {
                  exportarCancion(menuCancion);
                  setMenuCancion(null);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '12px 10px',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  color: '#FFFFFF',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background-color 0.15s ease'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2a2a2a'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <IconDescargar size={18} color="#B3B3B3" />
                <span>Guardar archivo en descargas (.mp3)</span>
              </button>

              <button
                onClick={() => {
                  const c = menuCancion;
                  setMenuCancion(null);
                  reemplazarCancionConOriginal(c);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '12px 10px',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  color: '#1ED760',
                  fontSize: '14px',
                  fontWeight: '700',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background-color 0.15s ease'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2a2a2a'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <span style={{ fontSize: '16px' }}>🔄</span>
                <span>Reemplazar con original (Audio Oficial)</span>
              </button>

              {playlistSeleccionada && (
                <button
                  onClick={() => {
                    quitarCancionDePlaylist(playlistSeleccionada.id, menuCancion.nombre);
                    setMenuCancion(null);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: '12px 10px',
                    borderRadius: '8px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    color: '#f87171',
                    fontSize: '14px',
                    fontWeight: '600',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background-color 0.15s ease'
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2a2a2a'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                >
                  <span style={{ fontSize: '16px' }}>✕</span>
                  <span>Quitar de esta playlist</span>
                </button>
              )}

              <button
                onClick={() => {
                  const nombreBorrar = menuCancion.nombre;
                  setMenuCancion(null);
                  eliminarCancion(nombreBorrar);
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: '12px 10px',
                  borderRadius: '8px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  color: '#ef4444',
                  fontSize: '14px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  textAlign: 'left',
                  transition: 'background-color 0.15s ease'
                }}
                onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#2a2a2a'; }}
                onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
              >
                <span style={{ fontSize: '16px' }}>🗑️</span>
                <span>Eliminar de tu biblioteca</span>
              </button>
            </div>

            <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid #2a2a2a', textAlign: 'center' }}>
              <button
                onClick={() => setMenuCancion(null)}
                style={{
                  width: '100%',
                  background: 'none',
                  border: 'none',
                  color: '#B3B3B3',
                  padding: '10px',
                  fontSize: '14px',
                  fontWeight: '700',
                  cursor: 'pointer'
                }}
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL "REEMPLAZAR CON AUDIO ORIGINAL" (VISTA PREVIA 10s + REEMPLAZO REAL) */}
      {/* ========================================================================= */}
      {modalOriginalAbierto && cancionParaOriginal && (
        <div
          onClick={() => { if (!descargandoCandidatoOriginalId) cerrarModalOriginal(); }}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.78)',
            zIndex: 10050,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '16px'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: '#18181b',
              borderRadius: '20px',
              width: '100%',
              maxWidth: '500px',
              maxHeight: '85dvh',
              padding: '20px',
              border: '1px solid rgba(255, 255, 255, 0.14)',
              boxShadow: '0 20px 60px rgba(0, 0, 0, 0.9)',
              display: 'flex',
              flexDirection: 'column',
              boxSizing: 'border-box'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', marginBottom: '12px' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: '#FFFFFF' }}>
                  🔄 Reemplazar con Audio Original
                </h3>
                <p style={{ margin: '4px 0 0 0', fontSize: '12.5px', color: '#A1A1AA', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {cancionParaOriginal.nombre}
                </p>
              </div>
              <button
                type="button"
                disabled={Boolean(descargandoCandidatoOriginalId)}
                onClick={cerrarModalOriginal}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: 'none',
                  borderRadius: '50%',
                  width: '32px',
                  height: '32px',
                  color: '#D4D4D8',
                  fontSize: '15px',
                  cursor: descargandoCandidatoOriginalId ? 'not-allowed' : 'pointer',
                  flexShrink: 0
                }}
              >
                ✕
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', paddingRight: '2px' }}>
              {cargandoCandidatosOriginales ? (
                <div style={{ padding: '32px 16px', textAlign: 'center', color: '#A1A1AA', fontSize: '13px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                  <IconSpinner size={26} color="#1ED760" />
                  <span>Buscando pistas oficiales en YouTube Music y canales - Topic...</span>
                </div>
              ) : candidatosOriginales.length === 0 ? (
                <div style={{ padding: '28px 16px', textAlign: 'center', color: '#A1A1AA', fontSize: '13px', backgroundColor: 'rgba(255, 255, 255, 0.03)', borderRadius: '12px' }}>
                  No se encontraron candidatos para esta canción.
                </div>
              ) : (
                candidatosOriginales.map((cand) => {
                  const sonandoPreview = reproduciendoPreviewOriginalId === cand.videoId;
                  const descargandoEsta = descargandoCandidatoOriginalId === cand.videoId;
                  return (
                    <div
                      key={cand.videoId}
                      style={{
                        backgroundColor: cand.esOficial ? 'rgba(30, 215, 96, 0.07)' : 'rgba(255, 255, 255, 0.04)',
                        border: cand.esOficial ? '1px solid rgba(30, 215, 96, 0.35)' : '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: '14px',
                        padding: '12px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '10px'
                      }}
                    >
                      <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '14px', fontWeight: '700', color: '#FFFFFF' }}>
                            {cand.titulo}
                          </span>
                          {cand.esOficial && (
                            <span style={{
                              fontSize: '10px',
                              fontWeight: '800',
                              backgroundColor: 'rgba(30, 215, 96, 0.2)',
                              color: '#1ED760',
                              padding: '2px 7px',
                              borderRadius: '500px'
                            }}>
                              OFICIAL / TOPIC
                            </span>
                          )}
                        </div>
                        <p style={{ margin: '3px 0 0 0', fontSize: '12px', color: '#A1A1AA' }}>
                          {cand.canal} {cand.duracionSeg > 0 ? `• ${formatearTiempo(cand.duracionSeg)}` : ''}
                        </p>
                      </div>

                      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          disabled={Boolean(descargandoCandidatoOriginalId)}
                          onClick={() => escucharPreviewCandidatoOriginal(cand)}
                          style={{
                            flex: 1,
                            minWidth: '120px',
                            minHeight: '38px',
                            backgroundColor: sonandoPreview ? 'rgba(59, 130, 246, 0.25)' : 'rgba(255, 255, 255, 0.08)',
                            border: sonandoPreview ? '1px solid #60A5FA' : '1px solid rgba(255, 255, 255, 0.14)',
                            color: '#FFFFFF',
                            borderRadius: '500px',
                            padding: '8px 12px',
                            fontSize: '12.5px',
                            fontWeight: '700',
                            cursor: descargandoCandidatoOriginalId ? 'not-allowed' : 'pointer'
                          }}
                        >
                          {sonandoPreview ? '⏹ Detener (10s)' : '▶ Escuchar'}
                        </button>

                        <button
                          type="button"
                          disabled={Boolean(descargandoCandidatoOriginalId)}
                          onClick={() => usarCandidatoOriginal(cand)}
                          style={{
                            flex: 1,
                            minWidth: '120px',
                            minHeight: '38px',
                            backgroundColor: '#1ED760',
                            border: 'none',
                            color: '#000000',
                            borderRadius: '500px',
                            padding: '8px 12px',
                            fontSize: '12.5px',
                            fontWeight: '800',
                            cursor: descargandoCandidatoOriginalId ? 'wait' : 'pointer',
                            opacity: descargandoCandidatoOriginalId && !descargandoEsta ? 0.5 : 1
                          }}
                        >
                          {descargandoEsta ? '⏳ Descargando...' : '✅ Usar esta'}
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* PANEL DE COLA DE REPRODUCCIÓN (DRAWER OFICIAL UP NEXT SPOTIFY)            */}
      {/* ========================================================================= */}
      <PreescuchaModal
        datos={preescuchaPendiente}
        guardando={guardandoPreescucha}
        onGuardar={confirmarGuardarPreescucha}
        onDescartar={() => {
          setPreescuchaPendiente(null);
          setCancionAReemplazarClave(null);
          mostrarToast('Vista previa descartada', 'info');
        }}
        onBuscarOtraVersion={(datos) => {
          setPreescuchaPendiente(null);
          setBusquedaWeb(`${datos.titulo} ${datos.artista || ''}`.trim());
          setTabActiva('buscar');
        }}
      />

      <ColaReproduccionModal
        abierto={modalColaAbierto}
        alCerrar={alCerrarModalCola}
        cancionActual={cancionActual}
        reproduciendo={reproduciendo}
        cola={colaReproduccion}
        siguientesBiblioteca={(() => {
          let lista = listaParaReproduccion.length > 0 ? listaParaReproduccion : listaContexto;
          if (lista.length === 0) lista = biblioteca;
          if (!cancionActual || lista.length === 0) return lista.slice(0, 15);
          const idx = lista.findIndex((c) => c.nombre === cancionActual.nombre);
          if (idx === -1) return lista.slice(0, 15);
          const despues = lista.slice(idx + 1);
          const antes = lista.slice(0, idx);
          return [...despues, ...antes].slice(0, 15);
        })()}
        autoplayActivo={autoplayRadio}
        onToggleAutoplay={toggleAutoplayRadio}
        onQuitarDeCola={quitarDeCola}
        onVaciarCola={() => {
          pedirConfirmacion({
            titulo: '¿Vaciar cola?',
            mensaje: '¿Deseas vaciar la lista de canciones en cola?',
            textoConfirmar: 'Vaciar',
            peligroso: true,
            onConfirmar: () => {
              setColaReproduccion([]);
              mostrarToast('Cola vaciada');
            }
          });
        }}
        onReordenarCola={reordenarCola}
        onReproducirDirecto={(c, index) => {
          if (index !== undefined) {
            setColaReproduccion((prev) => prev.filter((_, i) => i !== index));
          }
          reproducirCancion(c as Cancion);
        }}
        onAgregarACola={(c) => agregarACola(c as Cancion)}
      />

      {/* ========================================================================= */}
      {/* MODAL DE SLEEP TIMER */}
      {/* ========================================================================= */}
      {modalTimerAbierto && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          zIndex: 300,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '16px'
        }}>
          <div style={{
            backgroundColor: '#1e1e1e',
            border: '1px solid #333333',
            borderRadius: '16px',
            padding: '20px',
            width: '100%',
            maxWidth: '380px',
            boxSizing: 'border-box'
          }}>
            <h3 style={{ margin: '0 0 8px 0', fontSize: '18px', fontWeight: 'bold' }}>
              Temporizador de Apagado 🌙
            </h3>
            <p style={{ fontSize: '13px', color: '#b3b3b3', margin: '0 0 16px 0' }}>
              La música se desvanecerá suavemente al finalizar el tiempo programado.
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {[
                { label: 'Off (Desactivar)', val: null },
                { label: '15 min', val: 15 },
                { label: '30 min', val: 30 },
                { label: '60 min (1 hora)', val: 60 },
                { label: '🎵 Fin de la canción', val: -1 }
              ].map((opt, i) => (
                <button
                  key={i}
                  onClick={() => activarSleepTimer(opt.val)}
                  style={{
                    backgroundColor: timerOpcion === opt.val ? '#1DB954' : '#242424',
                    color: timerOpcion === opt.val ? 'black' : 'white',
                    border: 'none',
                    padding: '12px',
                    borderRadius: '8px',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '16px' }}>
              <button
                onClick={() => setModalTimerAbierto(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#b3b3b3',
                  cursor: 'pointer',
                  fontSize: '13px'
                }}
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL DE AÑADIR A PLAYLIST */}
      {/* ========================================================================= */}
      {modalPlaylistAbierto && (
        <div style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.85)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          zIndex: 300,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          padding: '16px'
        }}>
          <div style={{
            backgroundColor: '#1e1e1e',
            border: '1px solid #333333',
            borderRadius: '16px',
            padding: '20px',
            width: '100%',
            maxWidth: '460px',
            boxSizing: 'border-box'
          }}>
            <h3 style={{ margin: '0 0 10px 0', fontSize: '18px', fontWeight: 'bold', color: '#FFFFFF' }}>
              {cancionParaPlaylist ? `Añadir a playlist 📁` : `Nueva Playlist 📁`}
            </h3>

            {cancionParaPlaylist && (
              <p style={{ fontSize: '13px', color: '#1DB954', margin: '0 0 14px 0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                "{cancionParaPlaylist.nombre}"
              </p>
            )}

            <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
              <input
                type="text"
                placeholder="Nombre de la nueva lista..."
                value={nombreNuevaPlaylist}
                onChange={(e) => setNombreNuevaPlaylist(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && nombreNuevaPlaylist.trim()) crearPlaylist();
                }}
                style={{
                  flex: 1,
                  padding: '10px 14px',
                  borderRadius: '8px',
                  border: '1px solid #333',
                  backgroundColor: '#242424',
                  color: 'white',
                  fontSize: '14px',
                  outline: 'none'
                }}
              />
              <button
                onClick={crearPlaylist}
                disabled={!nombreNuevaPlaylist.trim()}
                style={{
                  backgroundColor: '#1DB954',
                  color: 'black',
                  fontWeight: 'bold',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '0 16px',
                  cursor: nombreNuevaPlaylist.trim() ? 'pointer' : 'not-allowed',
                  opacity: nombreNuevaPlaylist.trim() ? 1 : 0.5,
                  fontSize: '13px',
                  whiteSpace: 'nowrap'
                }}
              >
                Crear
              </button>
            </div>

            {/* SELECCIÓN MÚLTIPLE DE CANCIONES DE LA BIBLIOTECA */}
            {!cancionParaPlaylist && (
              <div style={{ marginTop: '10px', marginBottom: '14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <label style={{ fontSize: '12.5px', fontWeight: '700', color: '#FFFFFF' }}>
                    Elige canciones ({cancionesSeleccionadasPlaylist.length} de {biblioteca.length}):
                  </label>
                  {biblioteca.length > 0 && (
                    <button
                      type="button"
                      onClick={seleccionarTodasLasCancionesParaPlaylist}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#1ED760',
                        fontSize: '11.5px',
                        fontWeight: '600',
                        cursor: 'pointer',
                        padding: '2px 4px'
                      }}
                    >
                      {cancionesSeleccionadasPlaylist.length === biblioteca.length ? 'Deseleccionar todas' : 'Seleccionar todas'}
                    </button>
                  )}
                </div>

                {/* Filtro de búsqueda rápido en modal */}
                {biblioteca.length > 4 && (
                  <input
                    type="text"
                    placeholder="🔍 Filtrar canciones de tu biblioteca..."
                    value={filtroCancionModalPlaylist}
                    onChange={(e) => setFiltroCancionModalPlaylist(e.target.value)}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '8px',
                      border: '1px solid rgba(255, 255, 255, 0.12)',
                      backgroundColor: '#242424',
                      color: '#FFFFFF',
                      fontSize: '12px',
                      outline: 'none',
                      boxSizing: 'border-box',
                      marginBottom: '8px'
                    }}
                  />
                )}

                {/* Lista scrolleable de canciones con checkbox */}
                <div style={{
                  maxHeight: '200px',
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  paddingRight: '2px'
                }}>
                  {biblioteca.length === 0 ? (
                    <p style={{ fontSize: '12px', color: '#777777', margin: '12px 0', textAlign: 'center' }}>
                      No tienes canciones en tu biblioteca aún. Puedes crear la lista vacía y agregar canciones después.
                    </p>
                  ) : (
                    <>
                      {biblioteca
                      .filter((c) =>
                        filtroCancionModalPlaylist.trim() === '' ||
                        c.nombre.toLowerCase().includes(filtroCancionModalPlaylist.toLowerCase()) ||
                        (c.artista && c.artista.toLowerCase().includes(filtroCancionModalPlaylist.toLowerCase()))
                      )
                      .slice(0, limiteModalPlaylist)
                      .map((c) => {
                        const estaSeleccionada = cancionesSeleccionadasPlaylist.includes(c.nombre);
                        return (
                          <div
                            key={c.nombre}
                            onClick={() => alternarCancionEnSeleccionPlaylist(c.nombre)}
                            className={`playlist-song-select-item ${estaSeleccionada ? 'selected' : ''}`}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '10px',
                              padding: '6px 8px',
                              borderRadius: '8px',
                              backgroundColor: estaSeleccionada ? 'rgba(30, 215, 96, 0.15)' : 'rgba(255, 255, 255, 0.04)',
                              border: estaSeleccionada ? '1px solid rgba(30, 215, 96, 0.4)' : '1px solid rgba(255, 255, 255, 0.06)',
                              cursor: 'pointer'
                            }}
                          >
                            {/* Checkbox circular */}
                            <div style={{
                              width: '18px',
                              height: '18px',
                              borderRadius: '4px',
                              border: estaSeleccionada ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.35)',
                              backgroundColor: estaSeleccionada ? '#1ED760' : 'transparent',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0
                            }}>
                              {estaSeleccionada && <IconCheck size={12} color="#000000" />}
                            </div>

                            {/* Mini carátula */}
                            <div style={{
                              width: '32px',
                              height: '32px',
                              borderRadius: '4px',
                              overflow: 'hidden',
                              backgroundColor: '#282828',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              flexShrink: 0
                            }}>
                              {c.caratula ? (
                                <img src={c.caratula} alt={c.nombre} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" decoding="async" />
                              ) : (
                                <IconNota size={14} color="#A7A7A7" />
                              )}
                            </div>

                            {/* Info */}
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <p style={{
                                margin: 0,
                                fontSize: '13px',
                                fontWeight: estaSeleccionada ? '700' : '500',
                                color: estaSeleccionada ? '#FFFFFF' : '#E0E0E0',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap'
                              }}>
                                {c.nombre}
                              </p>
                              <p style={{ margin: 0, fontSize: '11px', color: '#94A3B8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {c.artista || formatearTiempo(c.duracion)}
                              </p>
                            </div>
                          </div>
                        );
                      })}

                    {biblioteca.filter((c) =>
                      filtroCancionModalPlaylist.trim() === '' ||
                      c.nombre.toLowerCase().includes(filtroCancionModalPlaylist.toLowerCase()) ||
                      (c.artista && c.artista.toLowerCase().includes(filtroCancionModalPlaylist.toLowerCase()))
                    ).length > limiteModalPlaylist && (
                      <div style={{ textAlign: 'center', marginTop: '8px' }}>
                        <button
                          type="button"
                          onClick={() => setLimiteModalPlaylist((prev) => prev + 40)}
                          style={{
                            background: 'rgba(255, 255, 255, 0.08)',
                            border: '1px solid rgba(255, 255, 255, 0.15)',
                            color: '#FFFFFF',
                            borderRadius: '20px',
                            padding: '6px 14px',
                            fontSize: '11px',
                            fontWeight: '600',
                            cursor: 'pointer'
                          }}
                        >
                          Cargar más (+40)
                        </button>
                      </div>
                    )}
                  </>
                  )}
                </div>
              </div>
            )}

            {cancionParaPlaylist && playlists.length > 0 && (
              <div>
                <p style={{ fontSize: '12px', color: '#b3b3b3', margin: '0 0 8px 0' }}>
                  O selecciona una existente:
                </p>
                <div style={{ maxHeight: '180px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {playlists.map((pl) => (
                    <button
                      key={pl.id}
                      onClick={() => agregarCancionAPlaylist(pl.id, cancionParaPlaylist.nombre)}
                      style={{
                        padding: '10px 12px',
                        backgroundColor: '#242424',
                        color: 'white',
                        border: '1px solid #333',
                        borderRadius: '8px',
                        textAlign: 'left',
                        cursor: 'pointer',
                        fontSize: '14px',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center'
                      }}
                    >
                      <span>📁 {pl.nombre}</span>
                      <span style={{ fontSize: '12px', color: '#b3b3b3' }}>
                        {pl.canciones.includes(cancionParaPlaylist.nombre) ? '✓ Ya agregada' : 'Añadir'}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
              <button
                onClick={() => {
                  setModalPlaylistAbierto(false);
                  setCancionParaPlaylist(null);
                  setCancionesSeleccionadasPlaylist([]);
                  setFiltroCancionModalPlaylist('');
                }}
                style={{ background: 'none', border: 'none', color: '#b3b3b3', cursor: 'pointer', fontSize: '13px' }}
              >
                Cancelar
              </button>

              {!cancionParaPlaylist && (
                <button
                  onClick={crearPlaylist}
                  disabled={!nombreNuevaPlaylist.trim()}
                  style={{
                    backgroundColor: '#1ED760',
                    color: '#000000',
                    fontWeight: '800',
                    border: 'none',
                    borderRadius: '500px',
                    padding: '8px 18px',
                    fontSize: '12.5px',
                    cursor: nombreNuevaPlaylist.trim() ? 'pointer' : 'not-allowed',
                    opacity: nombreNuevaPlaylist.trim() ? 1 : 0.5
                  }}
                >
                  Guardar Playlist ({cancionesSeleccionadasPlaylist.length})
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL DE AGREGAR CANCIONES A PLAYLIST EXISTENTE                           */}
      {/* ========================================================================= */}
      {modalAgregarAPlaylistAbierto && playlistDestinoAgregar && (
        <div
          onClick={() => setModalAgregarAPlaylistAbierto(false)}
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.85)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            zIndex: 350,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '16px'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: '#1E1E22',
              border: '1px solid #333333',
              borderRadius: '16px',
              padding: '20px',
              width: '100%',
              maxWidth: '480px',
              maxHeight: '85vh',
              display: 'flex',
              flexDirection: 'column',
              boxSizing: 'border-box',
              boxShadow: '0 12px 40px rgba(0,0,0,0.8)'
            }}
          >
            {/* Cabecera */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div>
                <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: '#FFFFFF' }}>
                  Agregar a "{playlistDestinoAgregar.nombre}" 📁
                </h3>
                <p style={{ margin: '3px 0 0 0', fontSize: '12px', color: '#1ED760', fontWeight: '600' }}>
                  {playlistDestinoAgregar.canciones.length} canciones actuales • {cancionesSeleccionadasParaAgregar.length} seleccionadas
                </p>
              </div>
              <button
                onClick={() => setModalAgregarAPlaylistAbierto(false)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#B3B3B3',
                  fontSize: '18px',
                  cursor: 'pointer',
                  padding: '4px'
                }}
              >
                ✕
              </button>
            </div>

            {/* Buscador de canciones en la biblioteca local */}
            <input
              type="text"
              placeholder="🔍 Buscar en tus canciones locales..."
              value={filtroCancionesParaAgregar}
              onChange={(e) => setFiltroCancionesParaAgregar(e.target.value)}
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: '8px',
                border: '1px solid rgba(255, 255, 255, 0.12)',
                backgroundColor: '#282828',
                color: '#FFFFFF',
                fontSize: '13px',
                outline: 'none',
                boxSizing: 'border-box',
                marginBottom: '10px'
              }}
            />

            {/* Botón rápido para seleccionar todas las que faltan */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
              <button
                type="button"
                onClick={() => {
                  const noAgregadas = biblioteca
                    .filter((c) => !playlistDestinoAgregar.canciones.includes(c.nombre))
                    .map((c) => c.nombre);
                  if (cancionesSeleccionadasParaAgregar.length === noAgregadas.length) {
                    setCancionesSeleccionadasParaAgregar([]);
                  } else {
                    setCancionesSeleccionadasParaAgregar(noAgregadas);
                  }
                }}
                style={{
                  background: 'none',
                  border: 'none',
                  color: '#1ED760',
                  fontSize: '11.5px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  padding: '2px 4px'
                }}
              >
                {cancionesSeleccionadasParaAgregar.length > 0 && cancionesSeleccionadasParaAgregar.length === biblioteca.filter(c => !playlistDestinoAgregar.canciones.includes(c.nombre)).length
                  ? 'Deseleccionar todas'
                  : 'Seleccionar todas las disponibles'}
              </button>
            </div>

            {/* Lista con scroll de canciones disponibles */}
            <div style={{
              flex: 1,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: '6px',
              paddingRight: '4px',
              marginBottom: '14px',
              minHeight: '120px'
            }}>
              {biblioteca.length === 0 ? (
                <p style={{ textAlign: 'center', color: '#888', fontSize: '13px', margin: '20px 0' }}>
                  No tienes canciones en tu biblioteca aún. Descarga algunas canciones primero.
                </p>
              ) : (
                biblioteca
                  .filter((c) =>
                    !filtroCancionesParaAgregar.trim() ||
                    c.nombre.toLowerCase().includes(filtroCancionesParaAgregar.toLowerCase()) ||
                    (c.artista && c.artista.toLowerCase().includes(filtroCancionesParaAgregar.toLowerCase()))
                  )
                  .map((c) => {
                    const yaEnPlaylist = playlistDestinoAgregar.canciones.includes(c.nombre);
                    const seleccionada = cancionesSeleccionadasParaAgregar.includes(c.nombre);

                    return (
                      <div
                        key={c.nombre}
                        onClick={() => {
                          if (yaEnPlaylist) return;
                          setCancionesSeleccionadasParaAgregar((prev) =>
                            prev.includes(c.nombre) ? prev.filter((n) => n !== c.nombre) : [...prev, c.nombre]
                          );
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '8px 10px',
                          borderRadius: '8px',
                          backgroundColor: yaEnPlaylist
                            ? 'rgba(255, 255, 255, 0.03)'
                            : seleccionada
                            ? 'rgba(30, 215, 96, 0.15)'
                            : 'rgba(255, 255, 255, 0.05)',
                          border: yaEnPlaylist
                            ? '1px solid rgba(255, 255, 255, 0.05)'
                            : seleccionada
                            ? '1px solid #1ED760'
                            : '1px solid rgba(255, 255, 255, 0.08)',
                          cursor: yaEnPlaylist ? 'default' : 'pointer',
                          opacity: yaEnPlaylist ? 0.6 : 1,
                          transition: 'background-color 0.15s ease'
                        }}
                      >
                        {/* Checkbox */}
                        <div style={{
                          width: '20px',
                          height: '20px',
                          borderRadius: '4px',
                          border: yaEnPlaylist
                            ? '1px solid #1ED760'
                            : seleccionada
                            ? '1px solid #1ED760'
                            : '1px solid rgba(255, 255, 255, 0.3)',
                          backgroundColor: (yaEnPlaylist || seleccionada) ? '#1ED760' : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0
                        }}>
                          {(yaEnPlaylist || seleccionada) && <IconCheck size={13} color="#000000" />}
                        </div>

                        {/* Carátula */}
                        <div style={{
                          width: '36px',
                          height: '36px',
                          borderRadius: '6px',
                          overflow: 'hidden',
                          backgroundColor: '#282828',
                          flexShrink: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center'
                        }}>
                          {c.caratula ? (
                            <img src={c.caratula} alt={c.nombre} style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" decoding="async" />
                          ) : (
                            <IconNota size={16} color="#A7A7A7" />
                          )}
                        </div>

                        {/* Nombre y Artista */}
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <p style={{
                            margin: 0,
                            fontSize: '13px',
                            fontWeight: (yaEnPlaylist || seleccionada) ? '700' : '500',
                            color: yaEnPlaylist ? '#888888' : '#FFFFFF',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}>
                            {c.nombre}
                          </p>
                          <p style={{ margin: '2px 0 0 0', fontSize: '11px', color: '#94A3B8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {yaEnPlaylist ? '✓ Ya agregada a esta lista' : (c.artista || formatearTiempo(c.duracion))}
                          </p>
                        </div>
                      </div>
                    );
                  })
              )}
            </div>

            {/* Botones de acción */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '10px', borderTop: '1px solid #333' }}>
              <button
                onClick={() => setModalAgregarAPlaylistAbierto(false)}
                style={{ background: 'none', border: 'none', color: '#B3B3B3', cursor: 'pointer', fontSize: '13px', fontWeight: '600' }}
              >
                Cancelar
              </button>

              <button
                onClick={() => agregarVariasCancionesAPlaylist(playlistDestinoAgregar.id, cancionesSeleccionadasParaAgregar)}
                disabled={cancionesSeleccionadasParaAgregar.length === 0}
                style={{
                  backgroundColor: cancionesSeleccionadasParaAgregar.length > 0 ? '#1ED760' : '#282828',
                  color: cancionesSeleccionadasParaAgregar.length > 0 ? '#000000' : '#888888',
                  fontWeight: '800',
                  border: 'none',
                  borderRadius: '500px',
                  padding: '9px 20px',
                  fontSize: '13px',
                  cursor: cancionesSeleccionadasParaAgregar.length > 0 ? 'pointer' : 'not-allowed',
                  transition: 'background-color 0.15s ease'
                }}
              >
                Añadir a playlist ({cancionesSeleccionadasParaAgregar.length})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* MODAL IMPORTADOR DE PLAYLISTS DE SPOTIFY POR ENLACE (z-index: 10050)      */}
      {/* ========================================================================= */}
      {modalSpotifyAbierto && (
        <div
          onClick={() => {
            if (!importandoColaSpotify) setModalSpotifyAbierto(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0, 0, 0, 0.86)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            zIndex: 10050,
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'center',
            padding: '16px'
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              backgroundColor: '#16161a',
              border: '1px solid rgba(30, 215, 96, 0.35)',
              borderRadius: '20px',
              padding: '20px',
              width: '100%',
              maxWidth: '520px',
              maxHeight: '88dvh',
              display: 'flex',
              flexDirection: 'column',
              boxSizing: 'border-box',
              boxShadow: '0 24px 60px rgba(0, 0, 0, 0.95), 0 0 30px rgba(30, 215, 96, 0.15)',
              animation: 'modalSlideUp 0.22s ease-out'
            }}
          >
            {/* Cabecera del Modal */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '22px' }}>🟢</span>
                <div>
                  <h3 style={{ margin: 0, fontSize: '18px', fontWeight: '900', color: '#FFFFFF', letterSpacing: '-0.3px' }}>
                    Importar Playlist de Spotify
                  </h3>
                  <p style={{ margin: '2px 0 0 0', fontSize: '11.5px', color: '#94A3B8' }}>
                    Pega un enlace de playlist, álbum o canción de Spotify para buscarla y descargarla en MP3
                  </p>
                </div>
              </div>
              <button
                onClick={() => {
                  if (importandoColaSpotify) {
                    cancelarColaSpotifyRef.current = true;
                  } else {
                    setModalSpotifyAbierto(false);
                  }
                }}
                style={{
                  background: 'rgba(255, 255, 255, 0.08)',
                  border: 'none',
                  color: '#FFFFFF',
                  borderRadius: '50%',
                  width: '32px',
                  height: '32px',
                  cursor: 'pointer',
                  fontSize: '15px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                title="Cerrar"
              >
                ✕
              </button>
            </div>

            {/* Input del enlace de Spotify */}
            <div style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
              <input
                type="text"
                placeholder="https://open.spotify.com/playlist/..."
                value={urlSpotifyInput}
                onChange={(e) => setUrlSpotifyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !analizandoSpotify && !importandoColaSpotify) {
                    analizarEnlacePlaylistSpotify();
                  }
                }}
                disabled={analizandoSpotify || importandoColaSpotify}
                style={{
                  flex: 1,
                  padding: '11px 14px',
                  borderRadius: '12px',
                  border: '1px solid rgba(255, 255, 255, 0.16)',
                  backgroundColor: '#222226',
                  color: '#FFFFFF',
                  fontSize: '13px',
                  outline: 'none'
                }}
              />
              <button
                onClick={analizarEnlacePlaylistSpotify}
                disabled={analizandoSpotify || importandoColaSpotify || !urlSpotifyInput.trim()}
                style={{
                  backgroundColor: '#1ED760',
                  color: '#000000',
                  fontWeight: '800',
                  border: 'none',
                  borderRadius: '12px',
                  padding: '0 16px',
                  fontSize: '13px',
                  cursor: analizandoSpotify || importandoColaSpotify || !urlSpotifyInput.trim() ? 'not-allowed' : 'pointer',
                  opacity: analizandoSpotify || importandoColaSpotify || !urlSpotifyInput.trim() ? 0.6 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  whiteSpace: 'nowrap'
                }}
              >
                {analizandoSpotify ? (
                  <>
                    <IconSpinner size={15} color="#000000" />
                    <span>Analizando...</span>
                  </>
                ) : (
                  <span>Analizar</span>
                )}
              </button>
            </div>

            {/* Progreso de descarga en cola secuencial */}
            {progresoColaSpotify && (
              <div style={{
                marginBottom: '14px',
                padding: '12px 14px',
                borderRadius: '12px',
                backgroundColor: 'rgba(30, 215, 96, 0.1)',
                border: '1px solid rgba(30, 215, 96, 0.35)'
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px', fontSize: '12px' }}>
                  <span style={{ color: '#1ED760', fontWeight: '800', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '72%' }}>
                    {importandoColaSpotify ? `⏳ Descargando: ${progresoColaSpotify.tituloActual}` : `✓ ${progresoColaSpotify.tituloActual}`}
                  </span>
                  <span style={{ color: '#FFFFFF', fontWeight: '800' }}>
                    {progresoColaSpotify.actual} / {progresoColaSpotify.total}
                  </span>
                </div>
                <div style={{ width: '100%', height: '6px', backgroundColor: 'rgba(255, 255, 255, 0.12)', borderRadius: '500px', overflow: 'hidden', marginBottom: '6px' }}>
                  <div style={{
                    width: `${Math.round((progresoColaSpotify.actual / Math.max(1, progresoColaSpotify.total)) * 100)}%`,
                    height: '100%',
                    backgroundColor: '#1ED760',
                    transition: 'width 0.25s ease'
                  }} />
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px', fontSize: '11px', color: '#CBD5E1' }}>
                  <span>✓ Guardadas: <strong>{progresoColaSpotify.completadas}</strong></span>
                  <span>⏭ Omitidas (duplicadas): <strong>{progresoColaSpotify.omitidas}</strong></span>
                  {progresoColaSpotify.fallidas > 0 && (
                    <span style={{ color: '#FCA5A5' }}>⚠️ Fallidas: {progresoColaSpotify.fallidas}</span>
                  )}
                  {!importandoColaSpotify && fallidasSpotifyIds.length > 0 && (
                    <button
                      type="button"
                      onClick={reintentarFallidasSpotify}
                      style={{
                        backgroundColor: 'rgba(245, 158, 11, 0.18)',
                        color: '#FCD34D',
                        border: '1px solid rgba(245, 158, 11, 0.5)',
                        borderRadius: '500px',
                        padding: '4px 11px',
                        fontSize: '11px',
                        fontWeight: '800',
                        cursor: 'pointer',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '4px'
                      }}
                    >
                      <span>🔄 Reintentar fallidas ({fallidasSpotifyIds.length})</span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Resultado del análisis de la playlist */}
            {playlistSpotifyInfo && (
              <>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '10px',
                  padding: '10px 12px',
                  backgroundColor: 'rgba(255, 255, 255, 0.05)',
                  borderRadius: '12px',
                  marginBottom: '10px'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0, flex: 1 }}>
                    {playlistSpotifyInfo.caratula ? (
                      <img
                        src={playlistSpotifyInfo.caratula}
                        alt={playlistSpotifyInfo.nombre}
                        style={{ width: '44px', height: '44px', borderRadius: '8px', objectFit: 'cover', flexShrink: 0 }}
                      />
                    ) : (
                      <div style={{ width: '44px', height: '44px', borderRadius: '8px', backgroundColor: '#282828', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <IconNota size={20} color="#1ED760" />
                      </div>
                    )}
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <p style={{ margin: 0, fontSize: '14px', fontWeight: '800', color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {playlistSpotifyInfo.nombre}
                      </p>
                      <p style={{ margin: '2px 0 0 0', fontSize: '11.5px', color: '#1ED760', fontWeight: '600' }}>
                        {playlistSpotifyInfo.canciones.length} canciones • {seleccionadasSpotify.length} seleccionadas
                      </p>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', flexShrink: 0 }}>
                    <button
                      type="button"
                      disabled={importandoColaSpotify}
                      onClick={limpiarYReimportarPlaylistSpotify}
                      title="Purgar canciones descargadas previamente de esta playlist y volver a bajarlas con el filtro oficial de estudio"
                      style={{
                        backgroundColor: 'rgba(245, 158, 11, 0.14)',
                        border: '1px solid rgba(245, 158, 11, 0.45)',
                        color: '#FCD34D',
                        borderRadius: '500px',
                        padding: '5px 11px',
                        fontSize: '11px',
                        fontWeight: '800',
                        cursor: importandoColaSpotify ? 'not-allowed' : 'pointer'
                      }}
                    >
                      🧹 Reimportar limpiando covers
                    </button>

                    <button
                      type="button"
                      disabled={importandoColaSpotify}
                      onClick={() => {
                        if (seleccionadasSpotify.length === playlistSpotifyInfo.canciones.length) {
                          setSeleccionadasSpotify([]);
                        } else {
                          setSeleccionadasSpotify(playlistSpotifyInfo.canciones.map((c) => c.id));
                        }
                      }}
                      style={{
                        background: 'none',
                        border: '1px solid rgba(30, 215, 96, 0.4)',
                        color: '#1ED760',
                        borderRadius: '500px',
                        padding: '5px 11px',
                        fontSize: '11px',
                        fontWeight: '700',
                        cursor: 'pointer'
                      }}
                    >
                      {seleccionadasSpotify.length === playlistSpotifyInfo.canciones.length ? 'Deseleccionar' : 'Seleccionar todas'}
                    </button>
                  </div>
                </div>

                {/* Lista scrolleable de canciones de la playlist */}
                <div style={{
                  flex: 1,
                  overflowY: 'auto',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px',
                  paddingRight: '4px',
                  marginBottom: '14px',
                  minHeight: '150px',
                  maxHeight: '38dvh'
                }}>
                  {playlistSpotifyInfo.canciones.map((track) => {
                    const yaExiste = esPistaSpotifyYaEnBiblioteca(track);
                    const marcada = seleccionadasSpotify.includes(track.id);
                    return (
                      <div
                        key={track.id}
                        onClick={() => {
                          if (importandoColaSpotify) return;
                          setSeleccionadasSpotify((prev) =>
                            prev.includes(track.id) ? prev.filter((id) => id !== track.id) : [...prev, track.id]
                          );
                        }}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '10px',
                          padding: '8px 10px',
                          borderRadius: '10px',
                          backgroundColor: marcada ? 'rgba(30, 215, 96, 0.14)' : 'rgba(255, 255, 255, 0.04)',
                          border: marcada ? '1px solid rgba(30, 215, 96, 0.45)' : '1px solid rgba(255, 255, 255, 0.07)',
                          cursor: importandoColaSpotify ? 'default' : 'pointer'
                        }}
                      >
                        <div style={{
                          width: '18px',
                          height: '18px',
                          borderRadius: '4px',
                          border: marcada ? '1px solid #1ED760' : '1px solid rgba(255, 255, 255, 0.3)',
                          backgroundColor: marcada ? '#1ED760' : 'transparent',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          flexShrink: 0
                        }}>
                          {marcada && <IconCheck size={12} color="#000000" />}
                        </div>

                        {track.thumbnail ? (
                          <img
                            src={track.thumbnail}
                            alt={track.title}
                            style={{ width: '34px', height: '34px', borderRadius: '6px', objectFit: 'cover', flexShrink: 0 }}
                            loading="lazy"
                          />
                        ) : (
                          <div style={{ width: '34px', height: '34px', borderRadius: '6px', backgroundColor: '#282828', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                            <IconNota size={14} color="#A7A7A7" />
                          </div>
                        )}

                        <div style={{ minWidth: 0, flex: 1 }}>
                          <p style={{ margin: 0, fontSize: '13px', fontWeight: '700', color: '#FFFFFF', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {track.title}
                          </p>
                          <p style={{ margin: '2px 0 0 0', fontSize: '11px', color: '#94A3B8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {track.artist} {track.timestamp ? `• ${track.timestamp}` : ''}
                          </p>
                        </div>

                        {yaExiste && (
                          <span style={{
                            fontSize: '10px',
                            fontWeight: '800',
                            color: '#1ED760',
                            backgroundColor: 'rgba(30, 215, 96, 0.14)',
                            padding: '2px 8px',
                            borderRadius: '500px',
                            flexShrink: 0
                          }}>
                            ✓ En biblioteca
                          </span>
                        )}

                        {!importandoColaSpotify && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const q = `${track.title} ${track.artist || ''}`.trim();
                              setModalSpotifyAbierto(false);
                              setTabActiva('buscar');
                              setBusquedaWeb(q);
                              buscarCancionesOnline(q);
                            }}
                            title="Buscar y descargar manualmente en el buscador"
                            style={{
                              background: 'rgba(255, 255, 255, 0.08)',
                              border: '1px solid rgba(255, 255, 255, 0.15)',
                              color: '#FFFFFF',
                              borderRadius: '500px',
                              padding: '4px 8px',
                              fontSize: '11px',
                              cursor: 'pointer',
                              flexShrink: 0
                            }}
                          >
                            🔍
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* Pie del modal con botones de descarga en cola */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', paddingTop: '10px', borderTop: '1px solid rgba(255, 255, 255, 0.08)' }}>
              {importandoColaSpotify ? (
                <button
                  onClick={() => {
                    cancelarColaSpotifyRef.current = true;
                  }}
                  style={{
                    width: '100%',
                    backgroundColor: 'rgba(239, 68, 68, 0.18)',
                    color: '#FCA5A5',
                    border: '1px solid #EF4444',
                    borderRadius: '500px',
                    padding: '12px 18px',
                    fontSize: '13px',
                    fontWeight: '800',
                    cursor: 'pointer'
                  }}
                >
                  Detener cola de importación
                </button>
              ) : (
                <>
                  <button
                    onClick={() => setModalSpotifyAbierto(false)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: '#B3B3B3',
                      fontSize: '13px',
                      fontWeight: '700',
                      cursor: 'pointer',
                      padding: '8px 12px'
                    }}
                  >
                    Cerrar
                  </button>

                  {playlistSpotifyInfo && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      {fallidasSpotifyIds.length > 0 && (
                        <button
                          type="button"
                          onClick={reintentarFallidasSpotify}
                          style={{
                            backgroundColor: 'rgba(245, 158, 11, 0.16)',
                            color: '#FCD34D',
                            border: '1px solid rgba(245, 158, 11, 0.5)',
                            borderRadius: '500px',
                            padding: '10px 16px',
                            fontSize: '12.5px',
                            fontWeight: '800',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '6px'
                          }}
                        >
                          <span>🔄 Reintentar fallidas ({fallidasSpotifyIds.length})</span>
                        </button>
                      )}
                      <button
                        onClick={() => descargarColaSecuencialSpotify()}
                        disabled={seleccionadasSpotify.length === 0}
                        style={{
                          backgroundColor: seleccionadasSpotify.length > 0 ? '#1ED760' : '#282828',
                          color: seleccionadasSpotify.length > 0 ? '#000000' : '#777777',
                          fontWeight: '900',
                          border: 'none',
                          borderRadius: '500px',
                          padding: '11px 22px',
                          fontSize: '13.5px',
                          cursor: seleccionadasSpotify.length > 0 ? 'pointer' : 'not-allowed',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                          boxShadow: seleccionadasSpotify.length > 0 ? '0 4px 18px rgba(30, 215, 96, 0.35)' : 'none'
                        }}
                      >
                        <IconDescargar size={16} color={seleccionadasSpotify.length > 0 ? '#000000' : '#777777'} />
                        <span>Descargar seleccionadas ({seleccionadasSpotify.length})</span>
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default App;