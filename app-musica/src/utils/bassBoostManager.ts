// Motor de Sonido Puro (Hardware Audio Offload 100% Nativo cuando Bass Boost está Off)
// + Keep-Alive Irrompible de AudioContext y Bass Boost Auto-Adaptativo (Anti-Clipping JBL)
import { smartAutomixEngine, type DeckChannelNodes } from './SmartAutomixEngine';

export type NivelBassBoost = 'suave' | 'medio' | 'fuerte' | 'extremo';
export type PerfilBassBoost = 'sub' | 'punch' | 'hifi' | 'extremo';
export type ModoAudioMaster = 'original';

// Pre-atenuación de Headroom (-4.5 dB = 10^(-4.5 / 20) ≈ 0.5956621435)
const HEADROOM_PRE_GAIN_LINEAR = Math.pow(10, -4.5 / 20);

// Frecuencia central base del filtro Lowshelf a velocidad 1.0x
const BASE_LOWSHELF_FREQ_HZ = 65;

interface AudioNodes {
  deckChannel: DeckChannelNodes;
  preGain: GainNode;
  bassFilter: BiquadFilterNode;
  limiter: DynamicsCompressorNode;
  analyser: AnalyserNode;
  conectadoDsp: boolean;
  muestrasLeveling: number;
  sumaEnergiaTotal: number;
}

class AudioMasterManager {
  private ctx: AudioContext | null = null;
  private nodesMap = new WeakMap<HTMLAudioElement, AudioNodes>();
  private elementosConectados = new Set<HTMLAudioElement>();
  private activo: boolean = false;
  private autoBassDb: number = 4.5;
  private playbackRate: number = 1.0;
  private freqData = new Uint8Array(128);
  private intervaloAdaptativo: ReturnType<typeof setInterval> | null = null;
  private intervaloKeepAlive: ReturnType<typeof setInterval> | null = null;
  private keepAliveIniciado: boolean = false;

  constructor() {
    // Iniciar Desactivado por defecto para preservar Hardware Audio Offload nativo en Android WebView.
    // Conectar <audio> a createMediaElementSource() cuando Bass Boost está apagado desactiva el offload de hardware.
    this.activo = false;
    try {
      localStorage.removeItem('app_musica_bass_boost_activo');
    } catch (_) {}

    this.iniciarLoopAdaptativo();
    this.iniciarKeepAliveLoop();
  }

  /**
   * Keep-Alive Irrompible cada 1000ms:
   * Si el AudioContext fue creado (porque el usuario encendió el Bass Boost) y cualquiera de los Decks
   * se está reproduciendo (!el.paused), fuerza ctx.resume() y mantiene viva la fuente silenciosa de 0.00001
   * para impedir que Android WebView suspenda el hilo de audio con la pantalla apagada.
   */
  private iniciarKeepAliveLoop() {
    if (this.intervaloKeepAlive || typeof window === 'undefined') return;
    this.intervaloKeepAlive = setInterval(() => {
      if (!this.ctx) return;

      let hayAudioReproduciendo = false;
      for (const el of this.elementosConectados) {
        if (el && !el.paused && !el.ended) {
          hayAudioReproduciendo = true;
          break;
        }
      }

      if (hayAudioReproduciendo && this.ctx.state !== 'running') {
        this.ctx.resume().catch(() => {});
      }
    }, 1000);
  }

  private asegurarNodoKeepAliveSilencioso(ctx: AudioContext) {
    if (this.keepAliveIniciado) return;
    try {
      const gain = ctx.createGain();
      gain.gain.value = 0.00001; // -100 dBFS (totalmente inaudible, mantiene activo el mixer de Android)
      gain.connect(ctx.destination);

      if (typeof ctx.createConstantSource === 'function') {
        const constantSource = ctx.createConstantSource();
        constantSource.offset.value = 1.0;
        constantSource.connect(gain);
        constantSource.start(0);
      } else {
        const osc = ctx.createOscillator();
        osc.frequency.value = 1;
        osc.connect(gain);
        osc.start(0);
      }

      this.keepAliveIniciado = true;
    } catch (_) {}
  }

  private iniciarLoopAdaptativo() {
    if (this.intervaloAdaptativo || typeof window === 'undefined') return;
    this.intervaloAdaptativo = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      if (!this.activo || !this.ctx || this.ctx.state !== 'running') {
        return;
      }
      this.analizarYAdaptarGravesYVolumen();
    }, 350);
  }

  private analizarYAdaptarGravesYVolumen() {
    if (!this.ctx || !this.activo) return;

    for (const el of this.elementosConectados) {
      if (el && !el.paused && !el.ended && el.currentTime > 0.3) {
        const nodes = this.nodesMap.get(el);
        if (!nodes || !nodes.conectadoDsp) continue;

        nodes.analyser.getByteFrequencyData(this.freqData);

        // 1. Adaptación de Graves (+3.5 dB a +5.5 dB)
        const energiaGraves = this.freqData[0] * 0.65 + this.freqData[1] * 0.35;

        if (energiaGraves <= 95) {
          this.autoBassDb = 5.5;
        } else if (energiaGraves >= 165) {
          this.autoBassDb = 3.5;
        } else {
          const factor = (energiaGraves - 95) / 70;
          this.autoBassDb = Math.round((5.5 - factor * 2.0) * 100) / 100;
        }

        const now = Math.max(0, this.ctx.currentTime);
        nodes.bassFilter.gain.setTargetAtTime(this.autoBassDb, now, 0.18);

        // 2. Auto-Leveling (ReplayGain en vivo durante los primeros segundos)
        if (
          el.currentTime >= 1.2 &&
          el.currentTime <= 12 &&
          nodes.muestrasLeveling < 16 &&
          !smartAutomixEngine.isMixing()
        ) {
          let sumaBins = 0;
          const totalBins = 48;
          for (let i = 0; i < totalBins; i++) {
            sumaBins += this.freqData[i];
          }
          const promedioBin = sumaBins / totalBins;

          if (promedioBin > 35) {
            nodes.muestrasLeveling += 1;
            nodes.sumaEnergiaTotal += promedioBin;

            if (nodes.muestrasLeveling >= 6) {
              const mediaPercibida = nodes.sumaEnergiaTotal / nodes.muestrasLeveling;
              const delta = (122 - mediaPercibida) * 0.08;
              const ajusteDb = Math.max(-2.5, Math.min(2.5, Math.round(delta * 100) / 100));
              smartAutomixEngine.aplicarReplayGain(this.ctx, el, ajusteDb);
            }
          }
        }
        break;
      }
    }
  }

  /**
   * Desactivado para prevenir falsos positivos cuando AnalyserNode devuelve 0 con pantalla apagada
   * o en pasajes suaves. El punto de mezcla se rige únicamente por cueOut pre-calculado (máx 4.5s).
   */
  public verificarSilencioFinalEnVivo(_el: HTMLAudioElement | null): boolean {
    return false;
  }

  public resetearDetectorSilencio(_el: HTMLAudioElement | null): void {
    // No-op: el detector en vivo fue desactivado por seguridad
  }

  public initContext(): AudioContext {
    if (!this.ctx) {
      const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioContextClass();

      this.asegurarNodoKeepAliveSilencioso(this.ctx);

      if (typeof window !== 'undefined') {
        const desbloquear = () => {
          if (this.ctx && this.ctx.state !== 'running') {
            this.ctx.resume().catch(() => {});
          }
        };
        window.addEventListener('touchstart', desbloquear, { passive: true });
        window.addEventListener('touchend', desbloquear, { passive: true });
        window.addEventListener('click', desbloquear, { passive: true });
        window.addEventListener('keydown', desbloquear, { passive: true });

        document.addEventListener('visibilitychange', () => {
          if (this.ctx && this.ctx.state !== 'running') {
            this.ctx.resume().catch(() => {});
          }
        });
      }
    }

    if (this.ctx.state !== 'running') {
      this.ctx.resume().catch(() => {});
    }

    return this.ctx;
  }

  public getContext(): AudioContext | null {
    return this.ctx;
  }

  // Cuando Bass Boost está activo, mantiene vivo el AudioContext en cada cambio de pista
  public async asegurarActivo(): Promise<void> {
    if (!this.activo) {
      return;
    }
    if (!this.ctx) {
      this.initContext();
    }
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (_) {}
    }
  }

  public getFrecuenciaLowshelfCompensada(): number {
    return Math.round(BASE_LOWSHELF_FREQ_HZ * this.playbackRate * 10) / 10;
  }

  public actualizarVelocidadReproduccion(rate: number): void {
    const rateSeguro = rate > 0.5 && rate < 2.0 ? rate : 1.0;
    this.playbackRate = rateSeguro;

    if (!this.ctx) return;
    const freqObjetivo = this.getFrecuenciaLowshelfCompensada();
    const now = Math.max(0, this.ctx.currentTime);

    for (const el of this.elementosConectados) {
      const nodes = this.nodesMap.get(el);
      if (nodes) {
        try {
          nodes.bassFilter.frequency.setTargetAtTime(freqObjetivo, now, 0.12);
        } catch (_) {
          nodes.bassFilter.frequency.value = freqObjetivo;
        }
      }
    }
  }

  public async prepararDeckParaNuevaPista(audioEl: HTMLAudioElement | null, replayGainInicialDb: number = 0): Promise<void> {
    if (!audioEl || !this.activo) return;
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch (_) {}
    }
    const nodes = this.nodesMap.get(audioEl);
    if (nodes) {
      nodes.muestrasLeveling = replayGainInicialDb !== 0 ? 16 : 0;
      nodes.sumaEnergiaTotal = 0;
    }
    if (this.ctx && nodes) {
      smartAutomixEngine.aplicarReplayGain(this.ctx, audioEl, replayGainInicialDb);
    }
  }

  /**
   * REGLA DE ORO DE HARDWARE AUDIO OFFLOAD EN ANDROID:
   * Si el usuario tiene Bass Boost Desactivado (!this.activo), NO conectamos deckARef ni deckBRef
   * a ctx.createMediaElementSource(). En Android WebView, conectar <audio> a Web Audio API desactiva
   * el Hardware Audio Offload y Android mata el audio tras 2 o 3 canciones en segundo plano.
   */
  public async connectAudioElement(audioEl: HTMLAudioElement | null): Promise<void> {
    if (!audioEl) return;
    // Si Bass Boost está Desactivado, PROHIBIDO conectar deckARef o deckBRef a createMediaElementSource()
    if (!this.activo) {
      const existing = this.nodesMap.get(audioEl);
      if (existing) {
        this.configurarRutaNodos(existing);
      }
      return;
    }

    try {
      const existing = this.nodesMap.get(audioEl);
      if (existing) {
        if (this.ctx && this.ctx.state !== 'running') {
          await this.ctx.resume().catch(() => {});
        }
        this.configurarRutaNodos(existing);
        return;
      }

      // No capturar el elemento por primera vez si la pantalla está apagada
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }

      const ctx = this.initContext();
      if (ctx.state !== 'running') {
        try {
          await ctx.resume();
        } catch (_) {}
      }

      const reanudarSiSuspended = () => {
        if (this.ctx && this.ctx.state !== 'running') {
          this.ctx.resume().catch(() => {});
        }
      };

      audioEl.addEventListener('play', reanudarSiSuspended);
      audioEl.addEventListener('playing', reanudarSiSuspended);
      audioEl.addEventListener('timeupdate', reanudarSiSuspended);

      const preGain = ctx.createGain();
      preGain.gain.value = HEADROOM_PRE_GAIN_LINEAR;

      const bassFilter = ctx.createBiquadFilter();
      bassFilter.type = 'lowshelf';
      bassFilter.frequency.value = this.getFrecuenciaLowshelfCompensada();
      bassFilter.Q.value = 0.707;
      bassFilter.gain.value = this.autoBassDb;

      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.5;
      limiter.knee.value = 6;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.82;

      const deckChannel = smartAutomixEngine.ensureDeckChannel(ctx, audioEl, preGain);

      const nodes: AudioNodes = {
        deckChannel,
        preGain,
        bassFilter,
        limiter,
        analyser,
        conectadoDsp: false,
        muestrasLeveling: 0,
        sumaEnergiaTotal: 0
      };

      this.nodesMap.set(audioEl, nodes);
      this.elementosConectados.add(audioEl);

      this.configurarRutaNodos(nodes);
    } catch (err) {
      console.warn('[AudioMasterManager]: No se pudo conectar elemento de audio:', err);
    }
  }

  private configurarRutaNodos(nodes: AudioNodes) {
    if (!this.ctx) return;
    try {
      nodes.deckChannel.crossfadeGainNode.disconnect();
      nodes.preGain.disconnect();
      nodes.bassFilter.disconnect();
      nodes.limiter.disconnect();
    } catch (_) {}

    const freqCompensada = this.getFrecuenciaLowshelfCompensada();

    if (!this.activo) {
      // Bypass 100% puro y plano (Flat 0.0 dB) si ya había sido conectado previamente
      nodes.preGain.gain.value = 1.0;
      nodes.bassFilter.gain.value = 0.0;
      nodes.deckChannel.crossfadeGainNode.connect(this.ctx.destination);
      nodes.conectadoDsp = false;
    } else {
      const now = Math.max(0, this.ctx.currentTime);
      nodes.preGain.gain.setValueAtTime(HEADROOM_PRE_GAIN_LINEAR, now);
      nodes.bassFilter.frequency.setValueAtTime(freqCompensada, now);
      nodes.bassFilter.Q.setValueAtTime(0.707, now);
      nodes.bassFilter.gain.setValueAtTime(this.autoBassDb, now);

      nodes.limiter.threshold.setValueAtTime(-1.5, now);
      nodes.limiter.knee.setValueAtTime(6, now);
      nodes.limiter.ratio.setValueAtTime(12, now);
      nodes.limiter.attack.setValueAtTime(0.003, now);
      nodes.limiter.release.setValueAtTime(0.15, now);

      nodes.deckChannel.crossfadeGainNode.connect(nodes.analyser);
      nodes.deckChannel.crossfadeGainNode.connect(nodes.preGain);
      nodes.preGain.connect(nodes.bassFilter);
      nodes.bassFilter.connect(nodes.limiter);
      nodes.limiter.connect(this.ctx.destination);
      nodes.conectadoDsp = true;
    }
  }

  public setActivo(activo: boolean, audioElements: (HTMLAudioElement | null)[]) {
    this.activo = activo;
    try {
      localStorage.setItem('app_musica_bass_boost_activo', activo.toString());
    } catch (_) {}
    if (activo) {
      this.initContext();
    }
    this.aplicarGanancia(audioElements);
  }

  public aplicarGanancia(audioElements: (HTMLAudioElement | null)[], _forzarParaSmartMix: boolean = false) {
    for (const el of audioElements) {
      if (!el) continue;
      if (this.activo) {
        this.connectAudioElement(el);
      }
      const nodes = this.nodesMap.get(el);
      if (nodes) {
        this.configurarRutaNodos(nodes);
      }
    }
  }

  public isActivo(): boolean {
    return this.activo;
  }

  public getAutoBassDb(): number {
    return this.activo ? this.autoBassDb : 0;
  }

  public resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      this.ctx.resume().catch(() => {});
    }
  }
}

export const bassBoostManager = new AudioMasterManager();
export { smartAutomixEngine, liberarHardwareDeck } from './SmartAutomixEngine';
export type { CueAnalysisResult, DeckChannelNodes } from './SmartAutomixEngine';
