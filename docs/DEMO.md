# Try the demo

Start with the bundled English mathematics lesson. You do not need private slides, Codex, or a paid speech service. Live model requests require your own Cerebras API access.

## Five-minute walkthrough

1. Run `npm start` and open the printed loopback address, normally `http://127.0.0.1:4320/`.
2. Choose **Edit this page**. This seeds Canvas from the prepared page. Open **Text & tools** for the prompt box.
3. Ask for a visible change:

   > Redesign this page with a midnight blue background, warm cream text, and coral accents. Keep the mathematical content readable and unchanged.

4. After reviewing the result, try a function edit:

   > Change the function to 20*x**3. Update the SVG graph, axis scale, tangent, equations, and explanation consistently. Keep the tangent anchored at x = 1.

5. Ask a follow-up:

   > Keep the tangent anchored at x = 1. Add a visual section comparing the curve and tangent at x = 2. Mark the vertical gap and explain why it appears.

6. Inspect **Complete HTML source**, then **Save HTML**. Try **Undo** to restore the previous version.

Each submitted prompt is a new provider request. The model receives the complete current HTML, your question, and section context. Clicking a section focuses a request; it does not limit the model to changing only that section.

For a smaller first edit, use the **Try coefficient 15** button. Canvas has different capabilities from the prepared graph: the prepared route limits coefficients to 0.5–10 and integer powers to 1–5, while Canvas can rewrite the static page itself.

## Check the mathematics

For the example above, `f(x) = 20x³`, `f′(x) = 60x²`, and the tangent at `x = 1` is `L(x) = 20 + 60(x − 1)`. At `x = 2`, the curve is 160, the tangent is 80, and the gap is 80.

At fixed anchor and step, doubling the coefficient doubles this gap. The filmed demo's first two edits included misleading prose even though the diagrams were right. Explicit feedback corrected the explanation. Fast generation and valid markup do not establish mathematical accuracy.

## Prepared teaching and the closing cue

Use **Prepared lesson** to return to the three-page study guide. **Teach without microphone** reads prepared steps with passage highlighting when local speech output is available. Continuous voice needs additional setup described in [VOICE.md](VOICE.md).

**Showcase complete** is an optional local closing animation: a Thank you screen, countdown ring, and navigation to the official Cerebras website. Escape cancels it. This cue is presentation code, not a model-generated edit or benchmark result.

## Configuration

Copy the repository's `.env.example` to `.env` and keep that file local.

| Setting | Purpose |
| --- | --- |
| `CEREBRAS_API_KEY` | Live Studio questions and page edits. |
| `OPENAI_API_KEY` | Optional direct API comparison. |
| `STUDIO_PORT` | Local Studio port; default 4320. |
| `STUDIO_DATA_DIR` | Separate local Studio state directory. |
| `API_PORT` | Comparison port; default 4337. |
| `API_DATA_DIR` | Separate comparison cohort directory. |
| `API_EFFORT` | Comparison setting: `low`, `medium`, or `high`. |

The Studio selector requests `qwen-3.8-27b` or `gpt-oss-120b` on Cerebras. The direct comparison requests `gpt-6-astra` from OpenAI and `qwen-3.8-27b` from Cerebras. These are the project's configured model IDs, not a guarantee that every account can access them. Do not substitute a model and label the result as an unchanged reproduction.

## Limits

- Canvas accepts a restricted static HTML/CSS/SVG document, up to 80 KB. Scripts, forms, embedded frames, and external resource loads are blocked. It cannot build an arbitrary interactive web application.
- Markup checks and limited declared-number checks cannot verify every equation, explanation, or SVG shape.
- A rejected edit leaves the previous source available. Timeouts and failed edits are possible; no automatic paid retry is made.
- **Save HTML** exports the current Canvas document. Prepared **Export session** is a different format and does not include Canvas history.
- One local reader is supported. Another connected tab can replace the current connection.
- The public package includes an authored sample lesson, not a PDF extraction pipeline, private course material, or the video-production workspace.
