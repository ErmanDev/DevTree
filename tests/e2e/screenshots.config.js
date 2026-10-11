// Generates the documentation screenshots in site/img (see screenshots/docs.shots.js).
const base = require("./playwright.config.js");

module.exports = {
  ...base,
  testDir: "screenshots",
  testMatch: "*.shots.js",
  reporter: "list",
};
