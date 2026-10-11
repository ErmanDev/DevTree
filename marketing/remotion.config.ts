// Remotion settings for the DevTree promo videos. See https://www.remotion.dev/docs/config
import { Config } from "@remotion/cli/config";

// Use the docs site's screenshots directly, so a re-render always shows the current app.
Config.setPublicDir("../site/img");
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(92);
Config.setOverwriteOutput(true);
