# Lesson Lab — all recorded comparison configurations

Recalculated from saved records on September 19, 2026. Public export also made September 19, 2026, without new model requests. The eight source JSON files here are byte-identical to the saved records. Original-project manifest checks are retained as historical verification, not a claim that all 56 original project files are included in this demo.

**The added low / medium / high results are the earlier Codex-CLI-versus-Cerebras-API experiment. The newer same-path direct API comparison has only tested low effort.** These are separate evidence sets.

The clock below is each browser lane's own handler start to checked visible update, including its request, source validation, iframe load and display checks. It is not speech latency, first-token latency, decode tokens/second, or isolated hardware performance. Source validation happens before the HTTP response is returned; display checks happen afterward.

## Earlier effort sweep — 18 measured requests

Both models were explicitly requested at low, medium and high. Each cell contains one run of each of three different bounded tasks. Medians summarize that task basket; they are not three repetitions of the same task. Equal effort names do not equate internal compute.

| Requested model / route | Effort | Runs | Visible median (s) | Observed range (s) | Code median (s) |
| --- | --- | ---: | ---: | ---: | ---: |
| Requested Astra / Codex CLI | low | 3 | 23.743 | 21.629–25.186 | 23.706 |
| Requested Astra / Codex CLI | medium | 3 | 24.218 | 20.410–25.879 | 24.186 |
| Requested Astra / Codex CLI | high | 3 | 24.763 | 22.289–24.843 | 24.721 |
| Qwen 3.8 27B / Cerebras API | low | 3 | 1.212 | 0.937–1.385 | 1.175 |
| Qwen 3.8 27B / Cerebras API | medium | 3 | 1.167 | 0.845–1.533 | 1.139 |
| Qwen 3.8 27B / Cerebras API | high | 3 | 2.903 | 2.311–3.388 | 2.864 |

All 18 source/DOM checks and stored AI-assisted review flags pass. Qwen high T2 has a sparse-explanation caveat. Astra includes fresh CLI setup and wrapper instructions, has no matching explicit completion cap, and reports no served-model ID. This cannot establish that high effort is ineffective or that one model has equal teaching quality.

## Earlier initial suite — 45 measured requests, all low

Three tasks × five runs per model. The GPT-OSS/Astra series ran sequential paired requests; Qwen was a later, unpaired supplemental series. The frozen primary report presents task-specific medians, retained here. The two initial rehearsals are excluded.

| Model / route | T1 tangent: median s (range) | T2 finite step: median s (range) | T3 misconception: median s (range) |
| --- | ---: | ---: | ---: |
| Requested Astra / Codex CLI | 21.390 (20.432–25.190) | 24.459 (23.489–24.777) | 24.436 (23.144–25.735) |
| GPT-OSS 120B / Cerebras API | 0.567 (0.388–0.878) | 0.447 (0.383–0.615) | 0.509 (0.434–0.894) |
| Qwen 3.8 27B / Cerebras API | 0.643 (0.610–0.835) | 0.859 (0.785–1.875) | 1.338 (1.284–1.391) |

Each cell has n=5. All 45 source/DOM and AI-assisted review checks pass; the five GPT-OSS T2 notes meet minimum requirements with less explanatory detail. Validation strengthened between T1 and T2, as disclosed in the original report. No p95 or general-quality ranking is inferred.

For completeness, JSON also includes a separately labelled descriptive median over each model's 15 observations: requested Astra 24.382 s, GPT-OSS 0.518 s, Qwen 0.859 s. Those task-mixture values do not replace the nine task-specific cells or turn different tasks into repeated samples.

## Separate initial high-setting trial — 6 measured requests

This earlier cohort compared Astra high with Qwen low; it is not the matched-label effort sweep. One request per model/task.

| Task | Requested Astra high / Codex CLI visible (s) | Qwen low / Cerebras API visible (s) |
| --- | ---: | ---: |
| T1 | 22.179 | 0.687 |
| T2 | 25.841 | 1.028 |
| T3 | 23.928 | 1.108 |

All six source/DOM and AI-assisted review flags pass. Their separate three-task basket medians are 23.928 s for requested Astra high and 1.028 s for Qwen low. Do not add these to either the initial 45-run suite or the later 18-run sweep.

## Newer direct API rehearsals — low only

Same client/server execution path, same source and request body except model; provider URL and authentication differ. Both responses identify the requested model. The four records are rehearsals with `review:pending`; independent AI source/math review is documented separately. They are individual observations, excluded from measured/reviewed aggregate filters.

| Protocol / model | Browser HTTP (s) | Complete code (s) | Checked visible (s) |
| --- | ---: | ---: | ---: |
| api-v1 / gpt-6-astra low | 17.837 | 17.659 | 17.881 |
| api-v1 / qwen-3.8-27b low | 1.587 | 1.599 | 1.681 |
| api-v2 / gpt-6-astra low | 31.055 | 31.074 | 31.447 |
| api-v2 / qwen-3.8-27b low | 2.039 | 2.072 | 2.248 |

v1 used an open local NDJSON response, while v2 returned a complete ordinary JSON response; keep them separate. Native Chrome HTTP measures Chrome → local server and ends before display confirmation. The v2 native Timing panel showed 31.05 s and 2.04 s; HAR precision is retained in JSON. Neither view independently times the server → provider wire. Speech recognition, ChatGPT Voice Chat and audio playback are excluded.

**No direct API medium/high result exists in this index.** Historical CLI medium/high values must not be relabelled as direct OpenAI API results.

## Rehearsals retained outside measured summaries

| Source | Model / route | Visible (s) | Run ID |
| --- | --- | ---: | --- |
| baseline45 | GPT-OSS 120B / Cerebras API / low | 1.5190 | `8480aea8-20c2-4aa9-9680-4f71558b8d47` |
| baseline45 | Requested Astra / Codex CLI / low | 26.0353 | `c67835cd-0f7b-435e-8f84-4be782c22ce7` |
| cli-rehearsal2 | Requested Astra / Codex CLI / low | 29.8257 | `bf95623e-ab2b-4c63-84fe-573f5c73a103` |
| cli-rehearsal2 | Qwen 3.8 27B / Cerebras API / low | 0.9561 | `71bee08a-8b3d-4210-90a4-df85d2668e09` |

The filmed September 18 T1 pair (29.8257 s / 0.9561 s) is an earlier CLI rehearsal, not the new direct API pair or an extra effort-sweep sample.

## Configuration and review boundaries

- Historical Astra: explicitly requested `gpt-6-astra`, selected low/medium/high, fresh ephemeral Codex CLI with tools disabled; reported model is null. CLI startup and additional wrapper context are included.
- Historical Cerebras: provider-reported `gpt-oss-120b` or `qwen-3.8-27b`, explicit effort, temperature 0, completion cap 8,192, parsed reasoning, nonstreaming, 90-second deadline. GPT-OSS was tested only at low here.
- New direct APIs: reported `gpt-6-astra` and `qwen-3.8-27b`, low, completion cap 8,192, nonstreaming, no temperature override/tools/retries, 90-second deadline. Same effort/cap does not equal same internal work.
- Indexed totals: 69 historical measured requests, four historical rehearsals, four direct-API rehearsals. Zero failures among these 77 indexed bounded-edit attempts; four saved review flags remain pending. This does not assert zero development or free-form Canvas failures.
- Old summary filters require measured + rendered + review pass + finite visible time; they also suppress mixed per-task configurations. This appendix preserves those exclusions and explicitly separates new rehearsal observations.
- Every output hash was recomputed. All 56 paths named in the three frozen manifests match. No original record, metric, review flag, failed attempt or source file was changed.

## Derived output efficiency for the 18-run sweep

This optional derived rate is reviewed edits × 60 / summed active request seconds. It excludes idle and review time. It is not measured sustained throughput, concurrency, user productivity or token speed. No failures occurred in this cohort; failures would otherwise remain in an explicitly defined active-time denominator.

| Model / route | Effort | Summed active seconds | Reviewed edits / active minute |
| --- | --- | ---: | ---: |
| Requested Astra / Codex CLI | high | 71.894 | 2.50 |
| Requested Astra / Codex CLI | low | 70.558 | 2.55 |
| Requested Astra / Codex CLI | medium | 70.507 | 2.55 |
| Qwen 3.8 27B / Cerebras API | high | 8.602 | 20.93 |
| Qwen 3.8 27B / Cerebras API | low | 3.534 | 50.94 |
| Qwen 3.8 27B / Cerebras API | medium | 3.545 | 50.78 |

## Source index

Exact per-run metadata, IDs, input/output hashes, source file hashes, original numeric timings, independent recalculated summaries and all film points are in [results.json](../results.json). The following are byte-identical copies of the saved source records:

| Cohort | Records | Packaged original | SHA-256 |
| --- | ---: | --- | --- |
| baseline45 | 47 | [baseline47.json](baseline47.json) | `4aa98b7c46958d9fdbde0f0cff70cd3c72a2f8a698e8f7219463b2acd3d73e0e` |
| high6 | 6 | [high6.json](high6.json) | `aef0a2af5d3f2bdf14127f43b9dade68d11fc9e20d34bee3c258f673e0e82f59` |
| effort18 | 6 | [effort-low6.json](effort-low6.json) | `9d79e2d75b1e16b7f0b9c8540b88821ec6b8580029e26f054a7cd1a93609020b` |
| effort18 | 6 | [effort-medium6.json](effort-medium6.json) | `be5f5719bd93c6b5ba4b5d02e0ecdd8ccf839420cef0067c61ad40ba80729a3a` |
| effort18 | 6 | [effort-high6.json](effort-high6.json) | `3e6bd961c5db871632733ca504b7f07b487518f489b4cf4cb454deec6f94d166` |
| cli-rehearsal2 | 2 | [cli-rehearsal2.json](cli-rehearsal2.json) | `b5d5a104b20b005d26bc8ad8ea9bcb715813bd5f346981af226766971cd48707` |
| api-v1 | 2 | [api-v1.json](api-v1.json) | `f93d4b490de11ac67c5fd29ae352040ea5098a409d77c0fcd32dc17c64bb6e97` |
| api-v2 | 2 | [api-v2.json](api-v2.json) | `b33301a156f7db40b82b660df11a8bb8c6f83a57619f32995a7f6582ef1ead3b` |

Canonical-record SHA-256 in JSON hashes UTF-8 JSON serialized with sorted keys, no separator whitespace and non-ASCII characters preserved. Whole-file SHA-256 hashes the exact source bytes. Canvas generation/correction logs and diagnostic connectivity calls are outside this bounded-comparison index.

## Public distribution

Open [the comparison viewer](../results.html), inspect [all indexed values](../results.json), or run `python3 docs/results/verify.py` from the repository root. [PROVENANCE.json](PROVENANCE.json) records exact file hashes and transformations.

No private environment files, credentials, raw HAR captures, audio, raw videos, installed speech binaries or private university coursework are included. No redaction was necessary in the eight source JSONs: their bytes and measurements are unchanged. The derived index and HTML only update package links and add this export context. Run, provider and request IDs remain as non-credential correlation identifiers.

The Studio Evidence view loads the same 47-record initial file (45 measured requests plus two rehearsals) from `benchmark/evidence/runs-2026-09-18.json`. It is a byte-identical duplicate of `baseline47.json`.
