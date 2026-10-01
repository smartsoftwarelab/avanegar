// Single place that knows about DOM element IDs.
// If a UI element gets renamed in index.html, this is the only file to touch.
export const UI = {
  brandDot: document.getElementById("brandDot"),
  tabs: document.querySelectorAll(".tab-btn"),
  panels: document.querySelectorAll(".panel-content"),
  wsIndicator: document.getElementById("wsIndicator"),
  wsStatusText: document.getElementById("wsStatusText"),
  engineStatus: document.getElementById("engineStatus"),
  latencyMetric: document.getElementById("latencyMetric"),
  processingMetric: document.getElementById("processingTimeMetric"),
  modelSelect: document.getElementById("modelSelect"),
  errorBanner: document.getElementById("errorBanner"),
  reqMic: document.getElementById("reqMic"),
  reqCodec: document.getElementById("reqCodec"),

  btnRecord: document.getElementById("btnRecord"),
  btnStopLive: document.getElementById("btnStopLive"),
  recordIndicator: document.getElementById("recordIndicator"),
  recordText: document.getElementById("recordText"),
  recordTimer: document.getElementById("recordTimer"),
  waveform: document.getElementById("waveform"),

  dropZone: document.getElementById("dropZone"),
  audioUpload: document.getElementById("audioUpload"),
  fileActions: document.getElementById("fileActions"),
  selectedFileName: document.getElementById("selectedFileName"),
  selectedFileSize: document.getElementById("selectedFileSize"),
  btnProcessFile: document.getElementById("btnProcessFile"),

  transcriptLoader: document.getElementById("transcriptLoader"),
  transcriptText: document.getElementById("transcriptText"),
  finalTranscript: document.getElementById("finalTranscript"),
  partialTranscript: document.getElementById("partialTranscript"),
  emptyState: document.getElementById("emptyState"),
  btnCopy: document.getElementById("btnCopy"),
  btnDownload: document.getElementById("btnDownload"),
};
