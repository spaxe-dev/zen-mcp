import { offerSkillInstall } from "./skill-offer.js";

// Entry point for the npm lifecycle script. npm install runs without a
// terminal in CI, so stay silent there rather than writing into build logs.
await offerSkillInstall({}, { quietWhenNonInteractive: true });
