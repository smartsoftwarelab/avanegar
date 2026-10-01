// All tunables live here. Change a value once, it applies everywhere.
export const CONFIG = {
  WS_URL:
    (location.protocol === "https:" ? "wss://" : "ws://") +
    (location.hostname === "" ? "localhost:8000" : location.host) +
    "/api/v1/asr/live",
  REST_URL: "/api/v1/asr/upload",
  CHUNK_TIMESLICE: 250,
  RECONNECT_DELAY: 3000,
  MAX_FILE_SIZE_MB: 100,
  CANDIDATE_MIME_TYPES: ["audio/webm;codecs=opus", "audio/ogg;codecs=opus"],
  WAVEFORM_BARS: 32,
};
