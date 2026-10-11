import "@fontsource/vt323";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/600.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/600.css";
import { Composition } from "remotion";
import { Promo, PROMO_FRAMES } from "./Promo";

export const FPS = 30;

export const Root: React.FC = () => (
  <>
    {/* 16:9 for YouTube, the website and presentations. */}
    <Composition id="DevTreePromo" component={Promo} durationInFrames={PROMO_FRAMES} fps={FPS} width={1920} height={1080} />
    {/* 1:1 for X, LinkedIn and Instagram feeds. */}
    <Composition id="DevTreeSquare" component={Promo} durationInFrames={PROMO_FRAMES} fps={FPS} width={1080} height={1080} />
  </>
);
