/**
 * A soft ambient bed for the tour, made in the browser with the Web Audio API:
 * slow pad chords through a low-pass filter and a gentle generated reverb, in a
 * calm key, with no percussion. Nothing to license and no file to ship.
 */

// C major 7, A minor 7, F major 7, G6: a slow, open loop
const CHORDS = [
  [48, 55, 59, 64],
  [45, 52, 55, 60],
  [41, 48, 52, 57],
  [43, 50, 55, 64],
];
const CHORD_S = 8;
const DUCK = 0.25; // about −12 dB under the voice

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class Ambient {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private duck_gain: GainNode | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private step = 0;
  private level = 0.5;

  /** Starts the bed; call it from a user gesture the first time. */
  start(): void {
    if (this.timer) return;
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    void ctx.resume();
    this.master!.gain.cancelScheduledValues(ctx.currentTime);
    this.master!.gain.setTargetAtTime(this.level * 0.09, ctx.currentTime, 1.2);
    this.chord();
    this.timer = setInterval(() => this.chord(), CHORD_S * 1000);
  }

  /** Fades the bed out and stops scheduling chords. */
  stop(): void {
    if (!this.ctx || !this.master) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.6);
  }

  /** The bed's volume, from 0 to 1. */
  volume(v: number): void {
    this.level = v;
    if (this.ctx && this.master && this.timer)
      this.master.gain.setTargetAtTime(v * 0.09, this.ctx.currentTime, 0.3);
  }

  /** Lowers the bed while the narrator speaks, and brings it back after. */
  duck(on: boolean): void {
    if (!this.ctx || !this.duck_gain) return;
    this.duck_gain.gain.setTargetAtTime(
      on ? DUCK : 1,
      this.ctx.currentTime,
      on ? 0.15 : 0.6
    );
  }

  private build(): void {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    const duck_gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 900;
    filter.Q.value = 0.4;
    // a short generated hall: decaying noise in both channels
    const reverb = ctx.createConvolver();
    const len = ctx.sampleRate * 3.2;
    const impulse = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = impulse.getChannelData(ch);
      for (let i = 0; i < len; i++)
        data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 2.6;
    }
    reverb.buffer = impulse;
    const wet = ctx.createGain();
    wet.gain.value = 0.45;
    filter.connect(duck_gain);
    filter.connect(reverb).connect(wet).connect(duck_gain);
    duck_gain.connect(master).connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    this.duck_gain = duck_gain;
    this.filter = filter;
  }

  private filter: BiquadFilterNode | undefined;

  private chord(): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + 0.05;
    const notes = CHORDS[this.step++ % CHORDS.length]!;
    for (const [i, midi] of notes.entries()) {
      for (const detune of [-6, 5]) {
        const osc = ctx.createOscillator();
        osc.type = i === 0 ? "sine" : "triangle";
        osc.frequency.value = hz(midi);
        osc.detune.value = detune;
        const env = ctx.createGain();
        const peak = (i === 0 ? 0.32 : 0.18) / notes.length;
        env.gain.setValueAtTime(0, t);
        env.gain.linearRampToValueAtTime(peak, t + 2.4);
        env.gain.setValueAtTime(peak, t + CHORD_S - 1);
        env.gain.linearRampToValueAtTime(0, t + CHORD_S + 2.5);
        osc.connect(env).connect(this.filter!);
        osc.start(t);
        osc.stop(t + CHORD_S + 2.6);
      }
    }
  }
}
