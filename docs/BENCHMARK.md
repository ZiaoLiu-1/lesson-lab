# Inspect the API comparison

This is a small page-editing experiment, separate from the open-ended Canvas demonstration and its voice features. It compares different models and providers; it does not isolate hardware speed or establish equal teaching quality.

## Run a local cohort

1. Configure your own `OPENAI_API_KEY` and `CEREBRAS_API_KEY` in `.env`.
2. Run `npm run benchmark:api`.
3. Open `http://127.0.0.1:4337/`. Open Chrome DevTools → **Network**, enable **Preserve log**, and filter for `api/run`.
4. Inspect **matching request bodies** before submitting. Choose a task and run each lane. Each click can incur API charges.
5. Inspect the request's **Payload**, **Preview/Response**, and **Timing** tabs. Review the rendered result and use the page's export controls to keep the local record.

Startup does not call either provider. The default cohort has a four-call cap, including failures and rehearsals. It is a guard against accidental repeated spending, not a statistically sufficient sample size.

To try another effort in a fresh, separately labeled directory, set these values in `.env` before starting:

```dotenv
API_EFFORT=medium
API_DATA_DIR=.local/benchmark-api/my-medium-trial
```

Use `high` for high effort. Do not delete failed runs to make room for successful ones, pool different configurations, or overwrite the included historical results. Equal effort names do not mean equal computation across models.

## What is matched

Both lanes run through the same local server and direct Chat Completions HTTP function. They receive the same authored prompt, starting HTML, output schema, reasoning-effort value, and 8,192 completion-token cap. That budget includes reasoning tokens, not only visible output. Streaming is off; tools and automatic retries are off. Only the provider endpoint, credential, and model differ.

The browser submits the expected provider request body to the local server. The server rejects a body mismatch before calling the provider. The models return a complete replacement for the same small task document. Neither lane uses a CLI or an agent tool loop in this comparison. The task supplies mathematical facts; this is not an open-ended knowledge test.

## Two clocks, two boundaries

| Clock | Starts | Ends | Includes |
| --- | --- | --- | --- |
| Chrome Network duration | Browser HTTP request to the local app | Complete local response received | Local proxy, provider request and response, parsing, and server source checks. |
| App checked-visible time | Run button handler, before preview reset | Returned page passes display checks | Pre-fetch setup, the HTTP interval, and browser display checks. |

Chrome is measuring the request **to the local proxy**, not a browser request directly to the provider. API keys stay on the server. Source checks happen before the HTTP response is returned, so they are already inside Network duration.

The saved server dispatch timestamp is recorded immediately before `fetch`; it is not a wire-level timestamp. With non-streaming responses, the interface cannot honestly show live generated token counts or tokens per second. Returned usage totals are not a live generation trace. The app does not expose private reasoning.

A source or display pass does not prove mathematical correctness. Keep content review, request failure, and render status separate.

## Recorded results supplied with the demo

Open [results.html](results.html) for the comparison companion and [results.json](results.json) for its data. Cohorts remain separate:

| Cohort | Samples and interpretation |
| --- | --- |
| Direct APIs | Four low-effort requests: two recorded pairs. The final pair was about 31.447 s / 2.248 s checked-visible for Astra / Qwen; the earlier pair was about 17.881 s / 1.682 s. These are individual observations. |
| Historical low effort | 45 measured runs: three models, three tasks, five runs per model/task. Astra used Codex CLI; Qwen and GPT-OSS used Cerebras APIs. Qwen was a later collection, not a simultaneous paired run. |
| Historical matched effort | 18 runs: Astra and Qwen at low, medium, and high, across three tasks. One sample per model/effort/task; medians combine the three different tasks. Astra includes Codex CLI startup. |
| Separate high comparison | Six runs: Astra through Codex at high effort versus Qwen API at low effort, one sample per task. |
| Earlier rehearsals | Retained separately; excluded from the measured cohorts above. |

The direct API pair's HTTP durations are about 31.055 s and 2.039 s. They must not be relabeled as checked-visible times. Historical CLI model labels reflect the requested configuration, not independent provider attestation.

Raw private recordings and local request logs are not bundled. New attempts create your own local records and never alter this published historical snapshot. Avoid a general “times faster” claim from these small, differently scoped experiments.
