import { CONFIG } from "./config.js";
import { UI } from "./dom.js";

// Single source of truth for tab/panel visibility is CSS (.panel-content / .active).
// Nothing here ever touches Tailwind's hidden/flex utilities on those elements.
export class ASREngine {
  constructor() {
    this.state = "idle";
    this.wsConnected = false;
    this.socket = null;
    this.mediaRecorder = null;
    this.audioStream = null;
    this.timerInterval = null;
    this.recordingTime = 0;
    this.startTime = 0;
    this.selectedFile = null;
    this.mimeType = null;
    this.hasTranscriptContent = false;

    this.audioCtx = null;
    this.analyser = null;
    this.waveformBars = [];
    this.rafId = null;

    this.buildWaveform();
    this.checkRequirements();
    this.initEventListeners();
    this.connectWebSocket();
  }

  buildWaveform() {
    for (let i = 0; i < CONFIG.WAVEFORM_BARS; i++) {
      const bar = document.createElement("div");
      bar.className = "viz-bar";
      UI.waveform.appendChild(bar);
      this.waveformBars.push(bar);
    }
  }

  checkRequirements() {
    const micOk = !!(
      navigator.mediaDevices && navigator.mediaDevices.getUserMedia
    );
    UI.reqMic.querySelector(".req-dot").classList.add(micOk ? "ok" : "bad");
    if (!micOk)
      UI.reqMic.lastChild.textContent =
        " این مرورگر از دسترسی به میکروفون پشتیبانی نمی‌کند";

    this.mimeType =
      CONFIG.CANDIDATE_MIME_TYPES.find(
        (t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t),
      ) || null;
    const dot = UI.reqCodec.querySelector(".req-dot");
    if (this.mimeType) {
      dot.classList.add("ok");
      UI.reqCodec.lastChild.textContent = ` ضبط زنده با ${this.mimeType.split(";")[0]} پشتیبانی می‌شود`;
    } else {
      dot.classList.add("bad");
      UI.reqCodec.lastChild.textContent =
        " این مرورگر فرمت صوتی لازم برای ضبط زنده را پشتیبانی نمی‌کند";
    }
  }

  setState(newState, errorMessage = "") {
    this.state = newState;
    UI.errorBanner.classList.add("hidden");
    UI.transcriptLoader.classList.add("hidden");

    switch (newState) {
      case "idle":
        UI.engineStatus.textContent = "آماده";
        UI.engineStatus.className = "font-medium text-[var(--text-secondary)]";
        UI.btnRecord.disabled = !this.wsConnected || !this.mimeType;
        break;
      case "connecting":
        UI.engineStatus.textContent = "در حال اتصال...";
        UI.engineStatus.className = "font-medium text-[var(--live)]";
        UI.btnRecord.disabled = true;
        break;
      case "loading":
        UI.engineStatus.textContent = "در حال پردازش...";
        UI.engineStatus.className = "font-medium text-[var(--accent)]";
        UI.transcriptLoader.classList.remove("hidden");
        break;
      case "recording":
        UI.engineStatus.textContent = "در حال شنیدن...";
        UI.engineStatus.className = "font-medium text-[var(--live)]";
        break;
      case "success":
        UI.engineStatus.textContent = "انجام شد";
        UI.engineStatus.className = "font-medium text-[var(--success)]";
        UI.btnRecord.disabled = !this.wsConnected || !this.mimeType;
        break;
      case "error":
        UI.engineStatus.textContent = "خطا";
        UI.engineStatus.className = "font-medium text-[var(--error)]";
        UI.errorBanner.textContent = errorMessage;
        UI.errorBanner.classList.remove("hidden");
        UI.btnRecord.disabled = !this.wsConnected || !this.mimeType;
        break;
      case "disconnected":
        UI.wsIndicator.className = "w-2 h-2 rounded-full bg-[var(--error)]";
        UI.wsStatusText.textContent = "قطع شده — تلاش مجدد...";
        UI.brandDot.className = "w-2.5 h-2.5 rounded-full bg-[var(--error)]";
        UI.btnRecord.disabled = true;
        break;
    }
    this.refreshTranscriptVisibility();
  }

  refreshTranscriptVisibility() {
    if (this.hasTranscriptContent) {
      UI.emptyState.classList.add("hidden");
      UI.transcriptText.classList.remove("hidden");
    } else {
      UI.emptyState.classList.remove("hidden");
      UI.transcriptText.classList.add("hidden");
    }
    UI.btnCopy.disabled = !this.hasTranscriptContent;
    UI.btnDownload.disabled = !this.hasTranscriptContent;
  }

  connectWebSocket() {
    this.setState("connecting");
    try {
      this.socket = new WebSocket(
        `${CONFIG.WS_URL}?model=${encodeURIComponent(UI.modelSelect.value)}`,
      );

      this.socket.onopen = () => {
        this.wsConnected = true;
        UI.wsIndicator.className = "w-2 h-2 rounded-full bg-[var(--success)]";
        UI.wsStatusText.textContent = "متصل";
        UI.brandDot.className = "w-2.5 h-2.5 rounded-full bg-[var(--accent)]";
        if (this.state === "connecting") this.setState("idle");
        else this.setState(this.state);
      };

      this.socket.onmessage = (event) => this.handleServerMessage(event);

      this.socket.onclose = () => {
        this.wsConnected = false;
        if (this.state === "recording") this.stopRecording(false);
        this.setState("disconnected");
        setTimeout(() => this.connectWebSocket(), CONFIG.RECONNECT_DELAY);
      };

      this.socket.onerror = () => {
        /* onclose follows */
      };
    } catch (err) {
      this.setState("disconnected");
      setTimeout(() => this.connectWebSocket(), CONFIG.RECONNECT_DELAY);
    }
  }

  handleServerMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.type === "error") {
      this.setState(
        "error",
        data.message || "خطای ناشناخته از سرور دریافت شد.",
      );
      return;
    }

    if (data.type === "cleaned_final") {
      // Server ran the whole session's final text through the LLM cleanup
      // pass once (punctuation/paragraphing needs full context, not
      // per-phrase) — replace the raw concatenation with the polished version.
      UI.finalTranscript.textContent = data.text || "";
      UI.partialTranscript.textContent = "";
      this.hasTranscriptContent = !!data.text;
      this.refreshTranscriptVisibility();
      return;
    }

    if (typeof data.timestamp === "number") {
      UI.latencyMetric.textContent = `${Date.now() - data.timestamp} ms`;
    }

    if (typeof data.text === "string") {
      if (data.is_final) {
        UI.finalTranscript.textContent +=
          (UI.finalTranscript.textContent ? " " : "") + data.text;
        UI.partialTranscript.textContent = "";
        this.hasTranscriptContent = UI.finalTranscript.textContent.length > 0;
      } else {
        UI.partialTranscript.textContent = data.text;
        this.hasTranscriptContent = true;
      }
      this.refreshTranscriptVisibility();
    }
  }

  startWaveform(stream) {
    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = this.audioCtx.createMediaStreamSource(stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 64;
    source.connect(this.analyser);

    const data = new Uint8Array(this.analyser.frequencyBinCount);
    UI.waveform.classList.add("active", "live");

    const draw = () => {
      this.analyser.getByteFrequencyData(data);
      const step = Math.floor(data.length / this.waveformBars.length) || 1;
      this.waveformBars.forEach((bar, i) => {
        const v = data[i * step] || 0;
        bar.style.height = `${Math.max(3, (v / 255) * 44)}px`;
      });
      this.rafId = requestAnimationFrame(draw);
    };
    draw();
  }

  stopWaveform() {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    UI.waveform.classList.remove("active", "live");
    this.waveformBars.forEach((bar) => (bar.style.height = "3px"));
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  async startRecording() {
    if (!this.wsConnected) {
      this.setState("error", "ارتباط با سرور برقرار نیست.");
      return;
    }
    if (!this.mimeType) {
      this.setState("error", "این مرورگر فرمت صوتی لازم را پشتیبانی نمی‌کند.");
      return;
    }

    try {
      this.audioStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      this.mediaRecorder = new MediaRecorder(this.audioStream, {
        mimeType: this.mimeType,
      });

      this.socket.send(
        JSON.stringify({
          action: "start",
          model: UI.modelSelect.value,
          mime_type: this.mimeType,
          sample_rate:
            this.audioStream.getAudioTracks()[0].getSettings().sampleRate ||
            null,
        }),
      );

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && this.socket.readyState === WebSocket.OPEN) {
          this.socket.send(event.data);
        }
      };

      this.mediaRecorder.start(CONFIG.CHUNK_TIMESLICE);
      this.startWaveform(this.audioStream);

      this.hasTranscriptContent = false;
      UI.finalTranscript.textContent = "";
      UI.partialTranscript.textContent = "";
      this.setState("recording");
      this.startTimer();

      UI.btnRecord.setAttribute("aria-pressed", "true");
      UI.btnRecord.setAttribute("aria-label", "توقف ضبط صدا");
      UI.recordIndicator.classList.remove("opacity-0");
      UI.recordIndicator.classList.add("recording-pulse");
      UI.recordText.textContent = "در حال ضبط...";
      UI.btnStopLive.classList.remove("hidden");
    } catch (err) {
      this.setState(
        "error",
        err.name === "NotAllowedError"
          ? "دسترسی به میکروفون رد شد."
          : "خطا در راه‌اندازی میکروفون.",
      );
    }
  }

  stopRecording(sendStopSignal = true) {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive")
      this.mediaRecorder.stop();
    if (this.audioStream) {
      this.audioStream.getTracks().forEach((t) => t.stop());
      this.audioStream = null;
    }
    this.stopTimer();
    this.stopWaveform();

    if (
      sendStopSignal &&
      this.socket &&
      this.socket.readyState === WebSocket.OPEN
    ) {
      this.socket.send(JSON.stringify({ action: "stop" }));
      this.setState("success");
    } else {
      this.setState(this.wsConnected ? "idle" : "disconnected");
    }

    UI.btnRecord.setAttribute("aria-pressed", "false");
    UI.btnRecord.setAttribute("aria-label", "شروع ضبط صدا");
    UI.recordIndicator.classList.add("opacity-0");
    UI.recordIndicator.classList.remove("recording-pulse");
    UI.recordText.textContent = "آماده ضبط";
    UI.btnStopLive.classList.add("hidden");
    UI.partialTranscript.textContent = "";
  }

  formatBytes(bytes) {
    if (!bytes) return "0 KB";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(
      units.length - 1,
      Math.floor(Math.log(bytes) / Math.log(1024)),
    );
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  handleFileUpload(file) {
    if (!file) return;
    if (!file.type.startsWith("audio/")) {
      this.setState("error", "فرمت فایل پشتیبانی نمی‌شود.");
      return;
    }
    if (file.size > CONFIG.MAX_FILE_SIZE_MB * 1024 * 1024) {
      this.setState(
        "error",
        `حجم فایل بیشتر از حد مجاز (${CONFIG.MAX_FILE_SIZE_MB} مگابایت) است.`,
      );
      return;
    }
    this.selectedFile = file;
    UI.selectedFileName.textContent = file.name;
    UI.selectedFileSize.textContent = this.formatBytes(file.size);
    UI.fileActions.classList.remove("hidden");
    UI.errorBanner.classList.add("hidden");
  }

  async processFile() {
    if (!this.selectedFile) return;
    this.setState("loading");
    this.hasTranscriptContent = false;
    UI.finalTranscript.textContent = "";
    UI.partialTranscript.textContent = "";
    this.refreshTranscriptVisibility();
    this.startTime = Date.now();

    const formData = new FormData();
    formData.append("audio", this.selectedFile);
    formData.append("model", UI.modelSelect.value);

    try {
      const response = await fetch(CONFIG.REST_URL, {
        method: "POST",
        body: formData,
      });
      const clientProcessTime = ((Date.now() - this.startTime) / 1000).toFixed(
        2,
      );

      if (!response.ok) {
        let detail = `خطا در پردازش فایل (کد ${response.status}).`;
        try {
          const b = await response.json();
          detail = b.detail || b.message || detail;
        } catch {}
        this.setState("error", detail);
        return;
      }

      const result = await response.json();
      UI.finalTranscript.textContent = result.transcript || "";
      this.hasTranscriptContent = !!result.transcript;
      UI.processingMetric.textContent =
        typeof result.duration_seconds === "number"
          ? `${result.duration_seconds.toFixed(2)} s`
          : `${clientProcessTime} s`;
      this.setState("success");
    } catch (error) {
      this.setState("error", "ارتباط با سرور برقرار نشد.");
    }
  }

  startTimer() {
    this.recordingTime = 0;
    UI.recordTimer.textContent = "00:00";
    this.timerInterval = setInterval(() => {
      this.recordingTime++;
      const m = String(Math.floor(this.recordingTime / 60)).padStart(2, "0");
      const s = String(this.recordingTime % 60).padStart(2, "0");
      UI.recordTimer.textContent = `${m}:${s}`;
    }, 1000);
  }
  stopTimer() {
    clearInterval(this.timerInterval);
  }

  copyTranscript() {
    const text = (
      UI.finalTranscript.textContent +
      " " +
      UI.partialTranscript.textContent
    ).trim();
    if (!text) return;
    navigator.clipboard.writeText(text);
    UI.btnCopy.style.color = "var(--accent)";
    setTimeout(() => {
      UI.btnCopy.style.color = "";
    }, 500);
  }

  downloadTranscript() {
    const text = (
      UI.finalTranscript.textContent +
      " " +
      UI.partialTranscript.textContent
    ).trim();
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `transcript_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Tab switching only ever toggles the single custom 'active' class.
  // Visibility itself is defined once, in style.css (.panel-content / .active).
  initEventListeners() {
    UI.tabs.forEach((tab) => {
      tab.addEventListener("click", (e) => {
        if (tab.dataset.target !== "liveMode" && this.state === "recording")
          this.stopRecording();
        UI.tabs.forEach((t) => {
          t.classList.remove("active");
          t.setAttribute("aria-selected", "false");
        });
        UI.panels.forEach((p) => p.classList.remove("active"));
        e.currentTarget.classList.add("active");
        e.currentTarget.setAttribute("aria-selected", "true");
        document
          .getElementById(e.currentTarget.dataset.target)
          .classList.add("active");
      });
    });

    UI.btnRecord.addEventListener("click", () => {
      if (this.state === "recording") this.stopRecording();
      else this.startRecording();
    });
    UI.btnStopLive.addEventListener("click", () => this.stopRecording());

    UI.audioUpload.addEventListener("change", (e) =>
      this.handleFileUpload(e.target.files[0]),
    );
    UI.btnProcessFile.addEventListener("click", () => this.processFile());

    UI.dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      UI.dropZone.style.borderColor = "var(--accent)";
    });
    UI.dropZone.addEventListener("dragleave", () => {
      UI.dropZone.style.borderColor = "";
    });
    UI.dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      UI.dropZone.style.borderColor = "";
      if (e.dataTransfer.files.length)
        this.handleFileUpload(e.dataTransfer.files[0]);
    });

    UI.btnCopy.addEventListener("click", () => this.copyTranscript());
    UI.btnDownload.addEventListener("click", () => this.downloadTranscript());

    UI.modelSelect.addEventListener("change", () => {
      if (this.state === "recording") this.stopRecording();
      if (this.socket && this.socket.readyState === WebSocket.OPEN)
        this.socket.close();
    });

    window.addEventListener("beforeunload", () => {
      if (this.state === "recording") this.stopRecording(false);
    });
  }
}
