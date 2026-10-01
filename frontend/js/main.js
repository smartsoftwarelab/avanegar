// Entry point. Anything genuinely new (a new panel, a new model) starts here
// by wiring a new module in — this file stays tiny on purpose.
import { ASREngine } from "./asr-engine.js";

document.addEventListener("DOMContentLoaded", () => {
  window.ASR = new ASREngine();
});
