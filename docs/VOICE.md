# Optional local voice

Start with typing to verify the page-editing workflow. Voice is an experimental input/output option, and this repository does not connect Cerebras to ChatGPT's built-in Voice Chat.

## Apple Silicon macOS setup

The bundled installer targets Apple Silicon macOS. It downloads pinned whisper.cpp source and the approximately 78 MB English tiny model, verifies their expected hashes, and builds a local transcription CLI. A C++ toolchain and network connection are required. Files stay under ignored `.local/speech`; it does not install global packages.

```sh
npm run voice:setup
npm run voice:check
npm start
```

Use **Start learning** and explicitly allow microphone access. The microphone is off on page load. A pause ends an utterance; local Whisper transcribes it, then the question text is sent to Cerebras. Speech onset attempts to interrupt the previous answer. **End learning** releases capture. Use headphones for your first test.

Say **“Continue the lesson”** to resume prepared teaching, **“Go to chapter two”** to navigate, or **“Stop speaking”** to pause. Canvas questions are sent with the current complete document and may generate new page source.

## Other options

- **Typing:** works without a speech installation.
- **Teach without microphone:** reads the prepared lesson when a supported speech output is available.
- **Mic in Text & tools:** creates an editable transcript before manual submission. It uses browser speech recognition, which may be online.
- **Your own Whisper installation:** set `LESSON_LAB_WHISPER_BIN` and `LESSON_LAB_WHISPER_MODEL` to compatible local files. Other platforms are not verified by the bundled installer.

Speech output uses native macOS speech when available, or a browser voice reported as local and English. Availability varies by platform and browser. No paid speech API is required by these routes; Cerebras language-model requests remain metered.

## What has and has not been verified

The code has automated checks for state changes, cancellation, and delivery boundaries. Those tests do not establish recognition accuracy, natural-sounding output, or reliable acoustic interruption on your device. Echo cancellation is best effort. Successful text editing is not evidence that continuous voice works.

Only the final teaching narration is eligible for speech. Source code, provider reasoning, and planning/status text are not the lesson script. A checked visible page is required before narration tied to an edit is delivered. Mathematical accuracy still needs review.

If capture or playback fails, stop the conversation and use typing. Check microphone permission, the selected output voice, and `npm run voice:check`; do not repeatedly submit paid model calls to diagnose a local audio problem.
