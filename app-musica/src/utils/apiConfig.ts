/**
 * Módulo de Configuración de API y Backend Universal
 * Soporta ejecución en navegador Web, PWA y entorno nativo Capacitor / Android Studio
 */

export const BACKEND_URL_DEFAULT = 'https://servidor-musica-i7m3.onrender.com';

/**
 * Determina si la aplicación se está ejecutando dentro de un entorno nativo (Capacitor / Android / iOS)
 */
export function esEntornoNativo(): boolean {
  if (typeof window === 'undefined') return false;
  
  const protocol = window.location.protocol;
  
  const win = window as unknown as {
    Capacitor?: {
      isNativePlatform?: () => boolean;
      platform?: string;
    };
  };

  const isCapacitor = Boolean(
    win.Capacitor?.isNativePlatform?.() ||
    win.Capacitor?.platform === 'android' ||
    win.Capacitor?.platform === 'ios'
  );

  return (
    isCapacitor ||
    protocol === 'capacitor:' ||
    protocol === 'file:'
  );
}

/**
 * Determina si la aplicación se está ejecutando en un entorno móvil o nativo
 * (Capacitor Android/iOS, WebViews móviles o navegadores móviles de pantalla táctil).
 */
export function esDispositivoMovil(): boolean {
  if (typeof window === 'undefined') return false;
  
  if (esEntornoNativo()) return true;

  const ua = (navigator.userAgent || navigator.vendor || '').toLowerCase();
  const esMovilUA = /android|iphone|ipad|ipod|windows phone|mobile/i.test(ua);
  const esTouchScreen = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
  const esPantallaPequena = window.innerWidth <= 768;

  return esMovilUA || (esTouchScreen && esPantallaPequena);
}

/**
 * Aplica clases de optimización móvil al DOM de inmediato para desactivar
 * desenfoques pesados (backdrop-filter) y acelerar el renderizado por hardware en Android.
 */
export function inicializarOptimizacionesMovil(): void {
  if (typeof document === 'undefined') return;
  if (esDispositivoMovil()) {
    document.documentElement.classList.add('plataforma-movil');
    if (document.body) {
      document.body.classList.add('plataforma-movil');
    }
  }
}

/**
 * Determina si existe una URL de backend remota explícita configurada (localStorage o .env)
 */
export function tieneBackendRemotoConfigurado(): boolean {
  if (typeof window === 'undefined') return false;
  const configurada = localStorage.getItem('app_musica_backend_url')?.trim();
  const envUrl = (import.meta.env.VITE_BACKEND_URL || '').trim();
  return Boolean(configurada || envUrl || BACKEND_URL_DEFAULT);
}

/**
 * Obtiene la URL base actual configurada para el backend.
 */
export function obtenerBackendBaseUrl(): string {
  if (typeof window === 'undefined') return '';

  // 1. Configuración guardada por el usuario en localStorage
  const configurada = localStorage.getItem('app_musica_backend_url')?.trim();
  if (configurada) {
    return configurada.replace(/\/$/, '');
  }

  // 2. Entorno web local o mismo origen (puerto 4000 Express, Vite 5173 con proxy, o Render):
  // Usar rutas relativas al mismo origen para evitar apuntar a otro entorno por .env
  if (!esEntornoNativo()) {
    const host = window.location.hostname;
    const port = window.location.port;
    if (port === '4000' || port === '5173' || host.includes('onrender.com')) {
      return '';
    }
  }

  // 3. Variable de entorno Vite (.env / .env.production)
  const envUrl = (import.meta.env.VITE_BACKEND_URL || '').trim();
  if (envUrl) {
    return envUrl.replace(/\/$/, '');
  }

  // 4. En entorno nativo móvil Capacitor (Android / iOS) o dominio externo:
  // Conectar al servicio en la nube por defecto
  return BACKEND_URL_DEFAULT.replace(/\/$/, '');
}

/**
 * Guarda o resetea la URL del backend en localStorage
 */
export function guardarBackendBaseUrl(url: string): void {
  if (typeof window === 'undefined') return;
  const limpia = (url || '').trim();
  if (!limpia) {
    localStorage.removeItem('app_musica_backend_url');
  } else {
    localStorage.setItem('app_musica_backend_url', limpia);
  }
}

/**
 * Convierte una ruta relativa de API en una URL completa accesible según la plataforma
 */
export function obtenerUrlApi(ruta: string): string {
  const base = obtenerBackendBaseUrl();
  const rutaNormalizada = ruta.startsWith('/') ? ruta : `/${ruta}`;

  // En entorno nativo móvil sin URL remota configurada, no generar rutas relativas
  if (esEntornoNativo() && !base) {
    return '';
  }

  if (!base) {
    return rutaNormalizada;
  }

  return `${base}${rutaNormalizada}`;
}

/**
 * Envoltorio de fetch con timeout configurable
 */
export async function fetchConTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = 25000
): Promise<Response> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error('Modo sin conexión • Biblioteca local lista');
  }

  const controller = new AbortController();
  const parentSignal = init?.signal;

  if (parentSignal) {
    if (parentSignal.aborted) {
      controller.abort();
    } else {
      parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`Tiempo de espera agotado (${Math.round(timeoutMs / 1000)}s)`));
  }, timeoutMs);

  try {
    const res = await fetch(input, {
      ...init,
      signal: controller.signal
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ejecuta una petición HTTP asegurando respuesta JSON válida con validación de tipo Content-Type
 */
export async function fetchJsonSeguro<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs: number = 25000
): Promise<T> {
  const opciones: RequestInit = {
    ...init,
    headers: {
      'Accept': 'application/json',
      ...(init?.headers || {})
    }
  };

  const resp = await fetchConTimeout(input, opciones, timeoutMs);

  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }

  const contentType = (resp.headers.get('content-type') || '').toLowerCase();
  
  if (contentType.includes('text/html') || (!contentType.includes('json') && !contentType.includes('javascript'))) {
    throw new Error('El servidor devolvió un formato no compatible (esperaba application/json).');
  }

  const texto = await resp.text();
  const recortado = texto.trim();

  if (
    recortado.startsWith('<') ||
    recortado.toLowerCase().startsWith('<!doctype') ||
    recortado.toLowerCase().startsWith('<html') ||
    recortado.toLowerCase().startsWith('<head') ||
    recortado.toLowerCase().startsWith('<body')
  ) {
    throw new Error('El servidor devolvió un documento HTML en lugar de JSON.');
  }

  try {
    return JSON.parse(texto) as T;
  } catch (err: any) {
    throw new Error(`Error al procesar JSON: ${err.message || 'Formato no válido'}`);
  }
}

/**
 * Prueba la conectividad con el backend haciendo un ping al endpoint /health
 */
export async function probarConexionBackend(urlPrueba?: string): Promise<{ ok: boolean; status: number; mensaje: string }> {
  const base = (urlPrueba || obtenerBackendBaseUrl() || '').trim().replace(/\/$/, '');
  if (!base && esEntornoNativo()) {
    return {
      ok: false,
      status: 0,
      mensaje: 'Ingresa la IP local de tu PC (ej: http://192.168.1.X:4000) o tu enlace Ngrok'
    };
  }

  const urlFinal = `${base}/health`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);

    const data = await fetchJsonSeguro<{ status?: string; server?: string }>(urlFinal, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' }
    });
    clearTimeout(timer);

    return {
      ok: true,
      status: 200,
      mensaje: `Servidor conectado (${data.server || 'servidor-musica'})`
    };
  } catch (err: any) {
    return {
      ok: false,
      status: 0,
      mensaje: err.name === 'AbortError' ? 'Tiempo de espera agotado (Timeout)' : `Fallo de conexión: ${err.message || err}`
    };
  }
}
