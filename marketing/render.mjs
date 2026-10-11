// Renders the promo videos, then masters their sound to web/social loudness (-16 LUFS).
//   node render.mjs                 both videos
//   node render.mjs DevTreeSquare   one of them
// Extra arguments after "--" go to `remotion render` (e.g. -- --browser-executable=/path/to/chrome).
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";

const OUTPUTS = { DevTreePromo: "out/devtree-promo.mp4", DevTreeSquare: "out/devtree-promo-square.mp4" };
const dash = process.argv.indexOf("--");
const extra = dash >= 0 ? process.argv.slice(dash + 1) : [];
const picked = (dash >= 0 ? process.argv.slice(2, dash) : process.argv.slice(2)).filter(Boolean);
const ids = picked.length ? picked : Object.keys(OUTPUTS);
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const run = (args) => execFileSync(npx, args, { stdio: "inherit", shell: process.platform === "win32" });

mkdirSync("out", { recursive: true });
for (const id of ids) {
  const out = OUTPUTS[id];
  if (!out) throw new Error(`unknown composition ${id}; pick from ${Object.keys(OUTPUTS).join(", ")}`);
  const raw = out.replace(/\.mp4$/, ".raw.mp4");
  run(["remotion", "render", id, raw, ...extra]);
  // Remotion's own ffmpeg: copy the video, normalise the audio.
  run(["remotion", "ffmpeg", "-v", "error", "-y", "-i", raw, "-c:v", "copy", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "48000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out]);
  rmSync(raw);
  console.log(`✓ ${out}`);
}
