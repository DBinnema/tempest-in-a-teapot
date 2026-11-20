/**
 * All sound is synthesised from the patches in THEME.sound — there are no
 * audio files. The AudioContext is only created after a user gesture
 * (browsers, and Discord's iframe, refuse to start audio before one).
 */
import { THEME } from "../../shared/src/theme";

interface Patch {
  type: string;
  f0: number;
  f1: number;
  dur: number;
  gain: number;
  noise: number;
  cut?: number;
  partial?: number;
}

export class Sfx {
  muted = false;
  private ctx?: AudioContext;
  private master?: GainNode;
  private music?: GainNode;
  private noise?: AudioBuffer;
  private last = new Map<string, number>();
  private step = 0;
  private nextNote = 0;
  private musicLevel = 1;

  /** "none" until the first gesture, then the AudioContext's state. */
  get state(): string {
    return this.ctx?.state ?? "none";
  }

  /** Call from a pointer/key handler. Safe to call repeatedly. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as any).webkitAudioContext;
    if (!AC) return;
    try {
      const ctx: AudioContext = new AC();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : THEME.sound.master;
      // A gentle limiter so eight simultaneous booms do not clip.
      const comp = ctx.createDynamicsCompressor();
      this.master.connect(comp).connect(ctx.destination);
      this.music = ctx.createGain();
      this.music.gain.value = THEME.sound.music.gain;
      this.music.connect(this.master);
      const len = ctx.sampleRate;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.nextNote = ctx.currentTime + 0.1;
      setInterval(() => this.schedule(), 100);
    } catch {
      this.ctx = undefined;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : THEME.sound.master, this.ctx.currentTime, 0.02);
  }

  /** 0..1 — the loop ducks under the show. */
  setMusic(level: number): void {
    this.musicLevel = level;
    if (this.music && this.ctx) this.music.gain.setTargetAtTime(THEME.sound.music.gain * level, this.ctx.currentTime, 0.3);
  }

  play(key: string, o: { gain?: number; pitch?: number; delay?: number } = {}): void {
    const ctx = this.ctx;
    const p = THEME.sound[key] as Patch | undefined;
    if (!ctx || !this.master || !p || this.muted || ctx.state !== "running") return;
    // The same sound twice within a few ms is just louder, and wasteful.
    const now = ctx.currentTime + (o.delay ?? 0);
    if (now - (this.last.get(key) ?? -1) < 0.03) return;
    this.last.set(key, now);
    this.voice(p, now, o.gain ?? 1, o.pitch ?? 1, this.master);
  }

  private voice(p: Patch, t0: number, gain: number, pitch: number, out: AudioNode): void {
    const ctx = this.ctx!;
    const g = Math.max(0.0002, p.gain * gain);
    const t1 = t0 + p.dur;
    if (p.type !== "noise") {
      const freqs = p.partial ? [1, p.partial] : [1];
      freqs.forEach((mul, i) => {
        const osc = ctx.createOscillator();
        osc.type = p.type as OscillatorType;
        osc.frequency.setValueAtTime(Math.max(20, p.f0 * pitch * mul), t0);
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, p.f1 * pitch * mul), t1);
        const env = ctx.createGain();
        env.gain.setValueAtTime(g * (i ? 0.35 : 1), t0);
        env.gain.exponentialRampToValueAtTime(0.0002, t1);
        osc.connect(env).connect(out);
        osc.start(t0);
        osc.stop(t1 + 0.02);
      });
    }
    if (p.noise > 0 && this.noise) {
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const filt = ctx.createBiquadFilter();
      if (p.type === "noise") {
        filt.type = "bandpass";
        filt.frequency.setValueAtTime(p.f0 * pitch, t0);
        filt.frequency.exponentialRampToValueAtTime(Math.max(40, p.f1 * pitch), t1);
        filt.Q.value = 0.8;
      } else {
        filt.type = "lowpass";
        filt.frequency.setValueAtTime((p.cut ?? 2400) * pitch, t0);
        filt.frequency.exponentialRampToValueAtTime(Math.max(60, (p.cut ?? 2400) * 0.25), t1);
      }
      const env = ctx.createGain();
      env.gain.setValueAtTime(g * p.noise, t0);
      env.gain.exponentialRampToValueAtTime(0.0002, t1);
      src.connect(filt).connect(env).connect(out);
      src.start(t0, Math.random() * 0.5);
      src.stop(t1 + 0.02);
    }
  }

  /** Music-box loop in 3/4, scheduled a little ahead of the audio clock. */
  private schedule(): void {
    const ctx = this.ctx;
    const m = THEME.sound.music;
    if (!ctx || !this.music || ctx.state !== "running") return;
    if (this.nextNote < ctx.currentTime) this.nextNote = ctx.currentTime + 0.05;
    const beat = 60 / m.bpm;
    while (this.nextNote < ctx.currentTime + 0.3) {
      if (this.musicLevel > 0.01) {
        const semis = m.pattern[this.step % m.pattern.length];
        const f = m.root * Math.pow(2, semis / 12);
        const down = this.step % 3 === 0;
        this.voice({ type: "sine", f0: f, f1: f * 0.999, dur: down ? 1.1 : 0.7, gain: down ? 1 : 0.6, noise: 0, partial: 3.01 }, this.nextNote, 1, 1, this.music);
        if (down) this.voice({ type: "triangle", f0: f / 4, f1: f / 4, dur: 0.9, gain: 0.7, noise: 0 }, this.nextNote, 1, 1, this.music);
      }
      this.step++;
      this.nextNote += beat;
    }
  }
}
