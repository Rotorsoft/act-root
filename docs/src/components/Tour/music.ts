/**
 * A light, story-like bed for the tour, made in the browser with the Web Audio
 * API: soft chords on a gentle I–V–vi–IV loop, a round bass, and a plucked
 * melody that wanders over the chord with a little echo. Nothing to license
 * and no file to ship. It ducks under the narrator's voice.
 */

const BPM = 96;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
// C, G, A minor, F: root and chord tones (MIDI)
const CHORDS = [
  { root: 36, tones: [60, 64, 67] },
  { root: 43, tones: [59, 62, 67] },
  { root: 45, tones: [60, 64, 69] },
  { root: 41, tones: [60, 65, 69] },
];
// the melody picks from the C major pentatonic, two octaves up from middle C
const SCALE = [72, 74, 76, 79, 81, 84, 86, 88];
// eighth-note rhythm per bar: 1 plays, 0 rests
const RHYTHMS = [
  [1, 0, 1, 1, 0, 1, 0, 0],
  [1, 0, 0, 1, 0, 1, 1, 0],
  [1, 1, 0, 1, 0, 0, 1, 0],
  [0, 1, 0, 1, 1, 0, 1, 0],
];
const DUCK = 0.32; // about −10 dB under the voice
const LEVEL = 1; // the bed's loudness at full volume: clearly there, under the voice

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

export class Ambient {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private duck_gain: GainNode | undefined;
  private bus: GainNode | undefined;
  private echo: GainNode | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private bar = 0;
  private next_bar = 0;
  private note = 2;
  private level = 0.6;

  /** Starts the bed; call it from the Play click, which lets the page make sound. */
  start(): void {
    if (!this.ctx) this.build();
    const ctx = this.ctx!;
    void ctx.resume();
    if (this.timer) return;
    this.master!.gain.cancelScheduledValues(ctx.currentTime);
    this.master!.gain.setTargetAtTime(this.level * LEVEL, ctx.currentTime, 0.4);
    this.next_bar = ctx.currentTime + 0.1;
    // schedule a little ahead, one bar at a time
    const tick = () => {
      while (this.next_bar < ctx.currentTime + BAR) {
        this.play_bar(this.next_bar);
        this.next_bar += BAR;
      }
    };
    tick();
    this.timer = setInterval(tick, 250);
  }

  /** Fades the bed out and stops scheduling. */
  stop(): void {
    if (!this.ctx || !this.master) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
  }

  /** The bed's volume, from 0 to 1. */
  volume(v: number): void {
    this.level = v;
    if (this.ctx && this.master && this.timer)
      this.master.gain.setTargetAtTime(v * LEVEL, this.ctx.currentTime, 0.3);
  }

  /** Lowers the bed while the narrator speaks, and brings it back after. */
  duck(on: boolean): void {
    if (!this.ctx || !this.duck_gain) return;
    this.duck_gain.gain.setTargetAtTime(
      on ? DUCK : 1,
      this.ctx.currentTime,
      on ? 0.12 : 0.5
    );
  }

  private build(): void {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    const duck_gain = ctx.createGain();
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 3200;
    // a soft feedback echo for the plucks
    const delay = ctx.createDelay(1);
    delay.delayTime.value = BEAT * 0.75;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.28;
    const echo = ctx.createGain();
    echo.gain.value = 0.35;
    echo.connect(delay).connect(feedback).connect(delay);
    delay.connect(tone);
    const bus = ctx.createGain();
    bus.connect(tone);
    tone.connect(duck_gain).connect(master).connect(ctx.destination);
    this.ctx = ctx;
    this.master = master;
    this.duck_gain = duck_gain;
    this.bus = bus;
    this.echo = echo;
  }

  private voice(
    type: OscillatorType,
    freq: number,
    t: number,
    attack: number,
    hold: number,
    release: number,
    peak: number,
    echo = false
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(peak, t + attack);
    env.gain.setTargetAtTime(peak * 0.6, t + attack, hold / 3);
    env.gain.setTargetAtTime(0, t + attack + hold, release / 4);
    osc.connect(env).connect(this.bus!);
    if (echo) env.connect(this.echo!);
    osc.start(t);
    osc.stop(t + attack + hold + release + 0.1);
  }

  private play_bar(t: number): void {
    const chord = CHORDS[this.bar % CHORDS.length]!;
    const rhythm =
      RHYTHMS[Math.floor(this.bar / CHORDS.length) % RHYTHMS.length]!;
    this.bar++;
    // the chord: soft and round, under everything
    for (const m of chord.tones)
      this.voice("sine", hz(m), t, 0.25, BAR - 0.4, 0.8, 0.07);
    // the bass: a round note on beats one and three
    this.voice("sine", hz(chord.root), t, 0.02, BEAT * 1.2, 0.4, 0.2);
    this.voice(
      "sine",
      hz(chord.root + 7),
      t + BEAT * 2,
      0.02,
      BEAT * 1.2,
      0.4,
      0.15
    );
    // the melody: plucked steps that wander, leaning on the chord's tones
    for (const [i, on] of rhythm.entries()) {
      if (!on) continue;
      const step = [-1, 1, 1, -1, 2, -2, 1, 0][(this.bar * 3 + i) % 8]!;
      this.note = Math.max(0, Math.min(SCALE.length - 1, this.note + step));
      let m = SCALE[this.note]!;
      // on the downbeat, land on a tone of the chord
      if (i === 0) m = chord.tones[(this.bar + 1) % chord.tones.length]! + 12;
      this.voice(
        "triangle",
        hz(m),
        t + i * (BEAT / 2),
        0.005,
        0.08,
        0.5,
        0.2,
        true
      );
    }
  }
}
