# Privacy and local storage

Lesson Lab runs on your computer and binds to `127.0.0.1`. It is intended for one local user, not as an authenticated public service. Do not expose its development server to the internet.

## What leaves your computer

- **Canvas edit:** your question, selected-section context, complete current HTML document, and relevant final narration are sent to the chosen Cerebras model.
- **Prepared lesson question:** relevant lesson content, page/session state, and question context are sent to Cerebras.
- **API comparison:** the authored benchmark prompt and starting document are sent to the selected provider using your own credentials.
- **Optional browser Mic button:** browser-provided speech recognition may use an online service. This is different from the continuous local Whisper route.

Provider account terms govern their handling of submitted content. Do not import private course material or personal information unless you intend to send it with these requests. “Local app” does not mean local language-model inference.

## Keys and files

API keys belong in the server environment or the ignored `.env` file. The browser never needs them. `.env.example` contains empty placeholders. Never paste keys into a prompt, issue, screenshot, or exported document.

By default, runtime data is under ignored `.local/`:

- Studio saves prepared lesson progress, parameters, and notes in `session.json`; finalized prepared turns in `turns.jsonl`.
- Canvas separately saves source, narration, revisions, and bounded undo history in `canvas.json`.
- The API comparison saves requests, returned source, failures, and measured times in its configured cohort directory.
- Optional local speech dependencies and model weights are downloaded into `.local/speech`.

`STUDIO_DATA_DIR` and `API_DATA_DIR` can point elsewhere. Keep those directories private too: Git's default ignore rules do not protect arbitrary locations.

Continuous local transcription uses temporary local audio files and deletes them after transcription. Native speech uses temporary files as well. Recognized question text can remain in session records and can be sent to the language-model provider. Refreshing the page does not erase saved state.

## Before sharing

Share a reviewed HTML export or a deliberately selected result, not the whole working directory. An HTML export may contain your questions or lesson content. Benchmark exports contain submitted prompts and returned source. Inspect them before publication even though authorization headers are excluded by the application.

The public demo package excludes personal `.env` files, runtime state, raw recordings, private slides, local provider logs, and machine-specific configuration. Its included mathematics sample and comparison snapshot are selected public resources; future local records are your responsibility to review.
