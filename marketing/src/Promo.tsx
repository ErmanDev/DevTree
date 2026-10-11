// The DevTree promo: a CRT boot intro, four features replayed from real app recordings, the key facts,
// and a call to action, with a voice-over, captions and a retro music bed. Each scene lasts as
// long as its voice-over line (voiceover/script.json → src/voiceover/lines.ts), and every scene
// adapts to the composition's shape (16:9 or square).
import { AbsoluteFill, Audio, Easing, Img, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, REPO, SITE } from "./theme";
import { MUSIC, VOICE } from "./voiceover/lines";
import conflictsRec from "../public/promo/conflicts.json";
import graphRec from "../public/promo/graph.json";
import rebaseRec from "../public/promo/rebase.json";
import stagingRec from "../public/promo/staging.json";

const FPS = 30;

const FEATURES: (FeatureProps & { voice: string })[] = [
  {
    voice: "graph",
    kicker: "01 · Commit graph",
    title: "See your whole history",
    body: "Colored lanes, curved merges and author pictures. Smooth even with 30,000 commits.",
    recording: graphRec as Recording,
  },
  {
    voice: "staging",
    kicker: "02 · Partial staging",
    title: "Stage exactly the lines you mean",
    body: "Click the lines you want. Stage, unstage or discard just those.",
    recording: stagingRec as Recording,
  },
  {
    voice: "conflicts",
    kicker: "03 · Conflict editor",
    title: "Resolve conflicts side by side",
    body: "Keep yours, take theirs, keep both, or edit by hand. Then continue.",
    recording: conflictsRec as Recording,
  },
  {
    voice: "rebase",
    kicker: "04 · Interactive rebase",
    title: "Rewrite history by drag and drop",
    body: "Reorder, reword, squash, fixup or drop commits in one editor.",
    recording: rebaseRec as Recording,
  },
];

/** One scene: what it shows, its voice-over line, when the line starts and how long it holds after. */
type Scene = { key: string; voice: string; lead: number; tail: number; min: number; render: () => React.ReactNode };

const SCENES: Scene[] = [
  // The line starts as the logo lands.
  { key: "boot", voice: "intro", lead: 36, tail: 18, min: 105, render: () => <Boot /> },
  ...FEATURES.map(({ voice, ...f }) => ({ key: f.recording.scene, voice, lead: 12, tail: 18, min: 120, render: () => <Feature {...f} /> })),
  { key: "facts", voice: "facts", lead: 10, tail: 15, min: 120, render: () => <Facts /> },
  // Hold the call to action after the last line.
  { key: "outro", voice: "outro", lead: 15, tail: 75, min: 150, render: () => <Outro /> },
];

/** Frame timeline: each scene's start, length, and voice-over interval. */
const TIMELINE = (() => {
  let at = 0;
  return SCENES.map((scene) => {
    const line = VOICE[scene.voice];
    const speech = Math.ceil(line.seconds * FPS);
    const length = Math.max(scene.min, scene.lead + speech + scene.tail);
    const entry = { scene, line, from: at, length, voFrom: at + scene.lead, voTo: at + scene.lead + speech };
    at += length;
    return entry;
  });
})();

export const PROMO_FRAMES = TIMELINE.reduce((sum, t) => sum + t.length, 0);

export const Promo: React.FC = () => (
  <AbsoluteFill style={{ background: C.bg, color: C.text, fontFamily: FONT.sans }}>
    <Audio src={MUSIC} volume={musicVolume} />
    {TIMELINE.map((t) => (
      <Sequence key={t.scene.key} from={t.from} durationInFrames={t.length}>
        {t.scene.render()}
        <Sequence from={t.scene.lead} durationInFrames={t.voTo - t.voFrom + 6}>
          <Audio src={t.line.src} />
        </Sequence>
      </Sequence>
    ))}
    <Captions />
    <Crt />
  </AbsoluteFill>
);

/** Music sits under the voice: quieter while someone speaks, and fades out at the end. */
function musicVolume(frame: number) {
  const full = 0.32;
  const ducked = 0.1;
  const ramp = 8;
  let level = full;
  for (const t of TIMELINE) {
    const inside = Math.min(
      interpolate(frame, [t.voFrom - ramp, t.voFrom], [0, 1], clamp),
      interpolate(frame, [t.voTo, t.voTo + ramp * 2], [1, 0], clamp),
    );
    level = Math.min(level, full - (full - ducked) * inside);
  }
  return level * interpolate(frame, [PROMO_FRAMES - 60, PROMO_FRAMES], [1, 0], clamp) * interpolate(frame, [0, 15], [0, 1], clamp);
}

/** Captions for the voice-over, a sentence at a time, timed by sentence length. */
const Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const wide = useWide();
  const t = TIMELINE.find((t) => frame >= t.voFrom && frame < t.voTo + 10);
  if (!t) return null;
  const sentences = t.line.text.match(/[^.?!]+[.?!]+/g)?.map((x) => x.trim()) ?? [t.line.text];
  const total = sentences.reduce((n, x) => n + x.length, 0);
  const progress = (frame - t.voFrom) / Math.max(1, t.voTo - t.voFrom);
  let acc = 0;
  let current = sentences[sentences.length - 1];
  for (const x of sentences) {
    acc += x.length / total;
    if (progress < acc) {
      current = x;
      break;
    }
  }
  const fade = Math.min(interpolate(frame, [t.voFrom, t.voFrom + 6], [0, 1], clamp), interpolate(frame, [t.voTo + 4, t.voTo + 10], [1, 0], clamp));
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: wide ? 46 : 40, pointerEvents: "none" }}>
      <div
        style={{
          opacity: fade,
          maxWidth: wide ? 1400 : 960,
          background: "rgba(8, 17, 20, .86)",
          borderLeft: `6px solid ${C.teal}`,
          padding: wide ? "14px 28px" : "14px 24px",
          fontFamily: FONT.sans,
          fontWeight: 600,
          fontSize: wide ? 38 : 36,
          lineHeight: 1.3,
          color: C.text,
          textAlign: "center",
          boxShadow: `6px 6px 0 ${C.shadow}`,
        }}
      >
        {current}
      </div>
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ helpers

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** Fades a scene in over its first frames and out over its last. */
function useSceneFade(fadeIn = 10, fadeOut = 10) {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  return Math.min(
    interpolate(frame, [0, fadeIn], [0, 1], clamp),
    interpolate(frame, [durationInFrames - fadeOut, durationInFrames], [1, 0], clamp),
  );
}

function useWide() {
  const { width, height } = useVideoConfig();
  return width / height > 1.3;
}

/** Scanlines, a vignette and a faint flicker over everything: the CRT. */
const Crt: React.FC = () => {
  const frame = useCurrentFrame();
  const flicker = 0.035 + 0.02 * Math.abs(Math.sin(frame * 1.7) * Math.sin(frame * 0.31));
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <AbsoluteFill
        style={{ background: "repeating-linear-gradient(0deg, rgba(0,0,0,.22) 0 2px, transparent 2px 4px)", opacity: 0.55 }}
      />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.55) 100%)" }} />
      <AbsoluteFill style={{ background: C.teal, opacity: flicker, mixBlendMode: "overlay" }} />
    </AbsoluteFill>
  );
};

/** The ⎇ mark from the app icon. */
const Mark: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 32 32">
    <rect width="32" height="32" rx="4" fill={C.bg} />
    <path d="M10 6v20M10 17c0-6 12-4 12-11" stroke={C.teal} strokeWidth="3.5" fill="none" strokeLinecap="round" />
    <circle cx="10" cy="25" r="3.5" fill={C.teal} />
    <circle cx="22" cy="7" r="3.5" fill={C.yellow} />
  </svg>
);

const Cursor: React.FC<{ color?: string }> = ({ color = C.teal }) => {
  const frame = useCurrentFrame();
  return <span style={{ color, opacity: Math.floor(frame / 15) % 2 === 0 ? 1 : 0 }}>_</span>;
};

/** A git graph drawing itself: the background of the intro. */
const DrawingGraph: React.FC<{ progress: number; width: number; height: number }> = ({ progress, width, height }) => {
  const lanes = [
    { color: C.teal, d: `M ${width * 0.12} ${height} V 0` },
    { color: C.yellow, d: `M ${width * 0.12} ${height * 0.8} C ${width * 0.12} ${height * 0.7}, ${width * 0.2} ${height * 0.7}, ${width * 0.2} ${height * 0.6} V ${height * 0.25} C ${width * 0.2} ${height * 0.15}, ${width * 0.12} ${height * 0.15}, ${width * 0.12} ${height * 0.05}` },
    { color: C.pink, d: `M ${width * 0.2} ${height * 0.5} C ${width * 0.2} ${height * 0.42}, ${width * 0.28} ${height * 0.42}, ${width * 0.28} ${height * 0.34} V ${height * 0.2}` },
    { color: C.blue, d: `M ${width * 0.88} ${height} V ${height * 0.55} C ${width * 0.88} ${height * 0.45}, ${width * 0.8} ${height * 0.45}, ${width * 0.8} ${height * 0.35} V 0` },
    { color: C.violet, d: `M ${width * 0.8} ${height * 0.75} C ${width * 0.8} ${height * 0.68}, ${width * 0.72} ${height * 0.68}, ${width * 0.72} ${height * 0.6} V ${height * 0.3}` },
  ];
  return (
    <svg width={width} height={height} style={{ position: "absolute", inset: 0, opacity: 0.35 }}>
      {lanes.map((l, i) => (
        <path
          key={i}
          d={l.d}
          stroke={l.color}
          strokeWidth={6}
          fill="none"
          strokeLinecap="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={1 - Math.min(1, Math.max(0, progress * 1.4 - i * 0.12))}
        />
      ))}
    </svg>
  );
};

// ------------------------------------------------------------------ scenes

const Boot: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const fade = useSceneFade(1, 12);
  const command = "$ devtree";
  const typed = command.slice(0, Math.floor(interpolate(frame, [4, 24], [0, command.length], clamp)));
  const logo = spring({ frame: frame - 30, fps, config: { damping: 14, mass: 0.6 } });
  const tagline = interpolate(frame, [52, 66], [0, 1], clamp);
  const scale = width / 1920;
  return (
    <AbsoluteFill style={{ opacity: fade, justifyContent: "center", alignItems: "center" }}>
      <DrawingGraph progress={interpolate(frame, [0, 90], [0, 1], clamp)} width={width} height={height} />
      <div
        style={{
          position: "absolute",
          top: height / 2 - 170 * scale - 120,
          fontFamily: FONT.mono,
          fontSize: 40 * Math.max(scale, 0.75),
          color: C.muted,
          opacity: interpolate(frame, [28, 40], [1, 0], clamp),
        }}
      >
        {typed}
        {frame < 30 && <Cursor />}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 36 * scale + 10, transform: `scale(${logo})` }}>
        <Mark size={170 * scale + 60} />
        <div style={{ fontFamily: FONT.pixel, fontSize: 230 * scale + 60, color: C.teal, lineHeight: 1, textShadow: `6px 6px 0 ${C.shadow}` }}>
          DevTree
          <Cursor color={C.yellow} />
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          top: height / 2 + 150 * scale + 80,
          fontFamily: FONT.pixel,
          fontSize: 76 * scale + 24,
          color: C.yellow,
          opacity: tagline,
          transform: `translateY(${(1 - tagline) * 20}px)`,
        }}
      >
        git, with a retro soul.
      </div>
    </AbsoluteFill>
  );
};

type FeatureProps = { kicker: string; title: string; body: string; recording: Recording };

const Feature: React.FC<FeatureProps> = ({ kicker, title, body, recording }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const wide = useWide();
  const fade = useSceneFade();
  const enter = spring({ frame, fps, config: { damping: 18 } });
  const s = width / 1920;

  const text = (
    <div style={{ width: wide ? 560 : "100%", transform: `translateY(${(1 - enter) * 40}px)`, opacity: enter }}>
      <div style={{ fontFamily: FONT.mono, fontSize: wide ? 26 : 30, color: C.yellow, textTransform: "uppercase", letterSpacing: 3 }}>{kicker}</div>
      <div style={{ fontFamily: FONT.pixel, fontSize: wide ? 104 : 92, lineHeight: 0.95, color: C.teal, margin: "18px 0 22px", textShadow: `4px 4px 0 ${C.shadow}` }}>
        {title}
      </div>
      <div style={{ fontSize: wide ? 34 : 34, lineHeight: 1.4, color: C.muted }}>{body}</div>
    </div>
  );

  const shotW = wide ? 1160 : 1080 - 2 * 70;
  const shot = (
    <div
      style={{
        width: shotW,
        border: `3px solid ${C.line}`,
        borderRadius: 8,
        overflow: "hidden",
        background: C.bg2,
        boxShadow: `14px 14px 0 ${C.shadow}`,
        transform: `translateX(${(1 - enter) * (wide ? 80 : 0)}px) translateY(${(1 - enter) * (wide ? 0 : 60)}px)`,
      }}
    >
      <div style={{ display: "flex", gap: 9, alignItems: "center", padding: "11px 14px", background: C.panel, borderBottom: `2px solid ${C.line}` }}>
        {[C.pink, C.yellow, C.green].map((c) => (
          <span key={c} style={{ width: 13, height: 13, borderRadius: "50%", background: c, display: "inline-block" }} />
        ))}
        <span style={{ fontFamily: FONT.mono, fontSize: 17, color: C.faint, marginLeft: 12 }}>DevTree — acme-web</span>
      </div>
      <Playback recording={recording} />
    </div>
  );

  return (
    <AbsoluteFill
      style={{
        opacity: fade,
        // Leave room at the bottom for the captions.
        padding: wide ? `0 ${100 * s}px 130px` : "60px 70px 170px",
        display: "flex",
        flexDirection: wide ? "row" : "column",
        alignItems: wide ? "center" : "flex-start",
        justifyContent: wide ? "space-between" : "center",
        gap: wide ? 60 : 56,
        background: `radial-gradient(ellipse at ${wide ? "75% 50%" : "50% 75%"}, ${C.bg2} 0%, ${C.bg} 70%)`,
      }}
    >
      {text}
      {shot}
    </AbsoluteFill>
  );
};

// ------------------------------------------------------------------ recorded interactions

type Point = { x: number; y: number };
type Beat = { image: string; action?: "hover" | "click" | "drag"; to?: Point; from?: Point };
/** A recording from tests/e2e/screenshots/promo.shots.js: a screenshot per step, and where the pointer went. */
export type Recording = { scene: string; width: number; height: number; beats: Beat[] };

const MOVE = 16; // frames to glide to a target
const CARRY = 20; // frames to carry a dragged item
const SWAP = 5; // frames for the app to "respond"

/** Plans when each step happens: the pointer moves, acts, then the next screenshot appears. */
function plan(recording: Recording, duration: number) {
  const steps = recording.beats.slice(1);
  const first = 22;
  const last = duration - 30;
  const gap = steps.length ? (last - first) / steps.length : 0;
  let pos: Point = { x: recording.width * 0.9, y: recording.height * 0.95 };
  return steps.map((beat, i) => {
    const start = Math.round(first + i * gap);
    const grab = beat.action === "drag" && beat.from ? beat.from : null;
    // Dragged items move along the list, so carry them straight down or up from the handle.
    const to = grab ? { x: grab.x, y: beat.to!.y } : beat.to!;
    const step = { beat, index: i + 1, start, from: pos, grab, to, arrive: start + MOVE, act: start + MOVE + (grab ? CARRY : 0) };
    pos = to;
    return step;
  });
}

const ease = Easing.bezier(0.45, 0, 0.2, 1);

const Playback: React.FC<{ recording: Recording }> = ({ recording }) => {
  const frame = useCurrentFrame();
  const { durationInFrames } = useVideoConfig();
  const steps = plan(recording, durationInFrames);
  const { width: W, height: H, beats } = recording;

  // Which screenshot is showing, and the next one fading in after an action.
  let shown = 0;
  let incoming = -1;
  let blend = 0;
  for (const st of steps) {
    const swap = st.act + (st.beat.action === "hover" ? 0 : 2);
    if (frame >= swap + SWAP) shown = st.index;
    else if (frame >= swap) {
      incoming = st.index;
      blend = (frame - swap) / SWAP;
    }
  }

  // Where the pointer is, and whether it is pressed.
  let pos = steps.length ? steps[0].from : { x: W * 0.9, y: H * 0.95 };
  let pressed = false;
  for (const st of steps) {
    if (frame < st.start) break;
    if (st.grab) {
      if (frame < st.arrive) pos = lerp(st.from, st.grab, interpolate(frame, [st.start, st.arrive], [0, 1], { ...clamp, easing: ease }));
      else {
        pos = lerp(st.grab, st.to, interpolate(frame, [st.arrive + 4, st.act], [0, 1], { ...clamp, easing: ease }));
        pressed = frame < st.act + 2;
      }
    } else {
      pos = lerp(st.from, st.to, interpolate(frame, [st.start, st.arrive], [0, 1], { ...clamp, easing: ease }));
      pressed = st.beat.action === "click" && frame >= st.arrive && frame < st.arrive + 4;
    }
  }
  const arrived = steps.length && frame >= steps[0].start;
  const parked = arrived ? 1 : interpolate(frame, [8, 18], [0, 1], clamp);

  const pct = (p: Point) => ({ left: `${(p.x / W) * 100}%`, top: `${(p.y / H) * 100}%` });
  return (
    <div style={{ position: "relative", aspectRatio: `${W} / ${H}`, overflow: "hidden" }}>
      <Img src={staticFile(beats[shown].image)} style={{ position: "absolute", inset: 0, width: "100%" }} />
      {incoming >= 0 && <Img src={staticFile(beats[incoming].image)} style={{ position: "absolute", inset: 0, width: "100%", opacity: blend }} />}
      {steps
        .filter((st) => st.beat.action !== "hover")
        .map((st) => {
          const at = st.grab ? st.act : st.arrive;
          const t = interpolate(frame, [at, at + 16], [0, 1], clamp);
          if (frame < at || t >= 1) return null;
          return (
            <div
              key={st.index}
              style={{
                position: "absolute",
                ...pct(st.to),
                width: 90,
                height: 90,
                marginLeft: -45,
                marginTop: -45,
                borderRadius: "50%",
                border: `4px solid ${C.teal}`,
                transform: `scale(${0.2 + t})`,
                opacity: 1 - t,
              }}
            />
          );
        })}
      <div style={{ position: "absolute", ...pct(pos), opacity: parked, transform: `scale(${pressed ? 0.86 : 1})`, transformOrigin: "0 0" }}>
        <Pointer grabbing={pressed && steps.some((st) => st.grab && frame >= st.arrive && frame < st.act + 2)} />
      </div>
    </div>
  );
};

const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** A chunky retro arrow (or a closed hand while dragging). */
const Pointer: React.FC<{ grabbing: boolean }> = ({ grabbing }) =>
  grabbing ? (
    <svg width="40" height="40" viewBox="0 0 24 24" style={{ marginLeft: -14, marginTop: -10, filter: `drop-shadow(3px 3px 0 ${C.shadow})` }}>
      <path d="M7 10V8.5a1.5 1.5 0 0 1 3 0V10m0-1.5V7.5a1.5 1.5 0 0 1 3 0V10m0-2a1.5 1.5 0 0 1 3 0v2m0-1a1.5 1.5 0 0 1 3 0v5a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-3l-2.5-4a1.5 1.5 0 0 1 2.5-1.6L7 13v-3" fill="#fff" stroke={C.ink} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="38" height="46" viewBox="0 0 19 23" style={{ filter: `drop-shadow(3px 3px 0 ${C.shadow})` }}>
      <path d="M1 1 L1 18 L5.5 14 L8.5 21.5 L12 20 L9 12.8 L15 12.8 Z" fill="#fff" stroke={C.ink} strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );

const FACT_TILES = [
  { big: "~3 MB", small: "one small program", color: C.teal },
  { big: "0", small: "accounts, trackers or Electron", color: C.yellow },
  { big: "3 OSes", small: "Windows, macOS & Linux", color: C.pink },
  { big: "MIT", small: "open source, free forever", color: C.blue },
];

const Facts: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const wide = useWide();
  const fade = useSceneFade();
  return (
    <AbsoluteFill style={{ opacity: fade, justifyContent: "center", alignItems: "center", padding: 80 }}>
      <div style={{ fontFamily: FONT.pixel, fontSize: wide ? 96 : 84, color: C.text, marginBottom: 60, textAlign: "center" }}>
        Lightweight by design.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: wide ? "repeat(4, 360px)" : "repeat(2, 400px)", gap: 34 }}>
        {FACT_TILES.map((t, i) => {
          const pop = spring({ frame: frame - 8 - i * 8, fps, config: { damping: 12, mass: 0.7 } });
          return (
            <div
              key={t.big}
              style={{
                border: `3px solid ${C.line}`,
                background: C.panel,
                boxShadow: `8px 8px 0 ${C.shadow}`,
                borderRadius: 6,
                padding: "34px 30px",
                transform: `scale(${pop})`,
                opacity: pop,
              }}
            >
              <div style={{ fontFamily: FONT.pixel, fontSize: 104, color: t.color, lineHeight: 1 }}>{t.big}</div>
              <div style={{ fontFamily: FONT.mono, fontSize: 25, color: C.muted, marginTop: 14 }}>{t.small}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const WindowsMark: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24">
    <path fill="currentColor" d="M0 0h11.4v11.4H0zM12.6 0H24v11.4H12.6zM0 12.6h11.4V24H0zM12.6 12.6H24V24H12.6z" />
  </svg>
);

const Outro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const wide = useWide();
  const fade = useSceneFade(10, 1);
  const logo = spring({ frame, fps, config: { damping: 15 } });
  const cta = spring({ frame: frame - 18, fps, config: { damping: 13 } });
  const links = interpolate(frame, [34, 48], [0, 1], clamp);
  return (
    <AbsoluteFill style={{ opacity: fade, justifyContent: "center", alignItems: "center", gap: 46 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 30, transform: `scale(${logo})` }}>
        <Mark size={wide ? 150 : 130} />
        <div style={{ fontFamily: FONT.pixel, fontSize: wide ? 200 : 170, color: C.teal, lineHeight: 1, textShadow: `6px 6px 0 ${C.shadow}` }}>DevTree</div>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 26,
          background: C.teal,
          color: C.ink,
          padding: "26px 44px",
          border: `3px solid ${C.shadow}`,
          borderRadius: 6,
          boxShadow: `10px 10px 0 ${C.shadow}`,
          transform: `scale(${cta})`,
          opacity: cta,
        }}
      >
        <WindowsMark size={58} />
        <div>
          <div style={{ fontFamily: FONT.mono, fontWeight: 600, fontSize: 46 }}>Download for Windows</div>
          <div style={{ fontFamily: FONT.mono, fontSize: 24, opacity: 0.8 }}>free · macOS & Linux: build from source</div>
        </div>
      </div>
      <div style={{ opacity: links, textAlign: "center", fontFamily: FONT.mono }}>
        <div style={{ fontSize: wide ? 46 : 40, color: C.yellow }}>{SITE}</div>
        <div style={{ fontSize: wide ? 30 : 27, color: C.muted, marginTop: 14 }}>open source · {REPO}</div>
      </div>
    </AbsoluteFill>
  );
};
