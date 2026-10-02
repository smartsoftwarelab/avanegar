# 🎙️ Avanegar

### Persian Speech-to-Text System

> Initial Design and Implementation of a Persian Speech-to-Text System

---

## 📌 Project Overview

**Avanegar** is an initial prototype of a Persian Automatic Speech Recognition (ASR) system.

The project focuses on Persian speech processing and supports both **audio-file transcription** and **live speech recognition**, using two ASR engines: **Whisper** and **Vosk**.

### Main Objectives

* Collect, prepare, and process Persian speech and text data
* Fine-tune the base Whisper model using the **LoRA** method
* Implement a speech-to-text system supporting both **file-based** and **live** processing

---

## ⚙️ Installation & Usage

### Prerequisites

- **Linux or WSL2 on Windows**
- **Python 3.11**
- **Git**
- **FFmpeg**
- **Unzip**
- Persian Vosk model: `vosk-model-fa-0.42`
- **Optional:** NVIDIA GPU for accelerated Whisper inference

> The installation and execution instructions below were tested on Linux/WSL2.

### 1. Clone the Repository

```bash
git clone <REPOSITORY_URL>
cd avanegar
````

### 2. Create and Activate a Virtual Environment

```bash
python3.11 -m venv venv
source venv/bin/activate
```

### 3. Install Dependencies

```bash
pip install -r backend/requirements.txt
```

### 4. Download the Persian Vosk Model

Download `vosk-model-fa-0.42` from the official Vosk models page:

[https://alphacephei.com/vosk/models](https://alphacephei.com/vosk/models)

Then extract it:

```bash
mkdir -p models
unzip vosk-model-fa-0.42.zip -d models/
mv models/vosk-model-fa-0.42 models/fa-0.42
```

The following file must exist:

```text
models/fa-0.42/am/final.mdl
```

### 5. Configure Environment Variables

Create:

```text
backend/.env
```

with:

```env
WHISPER_DEVICE=auto
GEMINI_API_KEY=
```

`WHISPER_DEVICE=auto` enables automatic GPU detection for Whisper and
falls back to CPU when a compatible GPU is unavailable.

`GEMINI_API_KEY` is optional. If it is left empty, the optional final
text and punctuation cleanup step is disabled.

### 6. Run the Application

```bash
cd backend
uvicorn main:app --host 0.0.0.0 --port 8000
```

A successful startup should produce output similar to:

```text
[startup] loading Vosk model from .../models/fa-0.42
[startup] whisper on cuda (float16)
[startup] Gemini cleanup: DISABLED
Application startup complete.
```

Depending on the available hardware, Whisper may instead start with:

```text
[startup] whisper on cpu (int8)
```

### 7. Open the Application

Open:

```text
http://localhost:8000
```

---

## 🛠️ Common Troubleshooting

| Message                          | Solution                                                                   |
| -------------------------------- | -------------------------------------------------------------------------- |
| `Could not import module "main"` | Make sure you are running the command from the `backend/` directory.       |
| Vosk model not found             | Check that `models/fa-0.42/am/final.mdl` exists.                           |
| CUDA libraries unavailable       | Whisper can fall back to CPU according to the configured device selection. |
| Gemini `403 Forbidden`           | Check that `GEMINI_API_KEY` is valid and correctly configured.             |

---

## 🎥 Demo

A short demonstration of the Avanegar application.

[▶️ Watch the Demo](docs/demo/avanegar-demo.mp4)
