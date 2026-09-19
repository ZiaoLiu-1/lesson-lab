# Working on Lesson Lab

Read `README.md`, `docs/DEMO.md`, and `docs/BENCHMARK.md` before changing behavior. State and delivery contracts are implemented in `studio/core.js`, `studio/canvas.js`, and their tests; inspect those before changing cancellation, persistence, or speech. This is a local feature demo, not a multi-user service.

- Use Node.js 24 and vanilla browser modules unless a concrete need justifies another dependency. `npm start` runs Studio on 4320; `npm run benchmark:api` runs the separate direct API comparison on 4337.
- Keep API keys server-side. Never commit `.env`, `.local`, private course material, speech recordings, or unreviewed request exports. `.env.example` must contain placeholders only.
- Canvas receives the complete static HTML/CSS/SVG document. Preserve the scripts-blocked preview, source policy, revision/hash checks, visible acknowledgement, cancellation, and undo. Do not describe Canvas as unrestricted application-file or JavaScript editing.
- The prepared route and Canvas have different math guarantees. Markup validation and successful display do not prove teaching correctness. Preserve review disclosures and failures.
- Speech must use the final teaching narration, never provider reasoning, source markup, or planning/status text. Keep microphone activation explicit and cancellation reliable; do not claim acoustic validation from synthetic tests.
- Preserve the included historical comparison snapshot. New attempts use a fresh local cohort directory. Never merge CLI and direct API results or silently relabel models, efforts, timing boundaries, failures, or review states.
- Both direct API lanes must use the same request implementation and matching body except for model. Endpoint and credential also differ. No hidden retries or extra tools in one lane.
- Do not make paid inference requests merely to run tests. `npm test` uses offline fixtures and injected providers. Obtain scope for new live experiments, publishing, or changing the license.
- Keep UI, authored sample content, and public documentation in English. Keep the tone concrete and make limitations understandable without turning every page into an audit report.
