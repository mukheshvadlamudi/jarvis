# Jarvis: best practices and finishing plan — November 2026

Research date: **3 November 2026**. Reviewed `AGENTS.md`, all of `CLAUDE.md`, `SPEC.md`, `docs/DESIGN.md`, the named modules and their connected flows. Code citations refer to **main `49e13df`**, except citations explicitly prefixed **voice branch**, which refer to `fix/voice-stalls` at `988fa44`. No implementation, configuration, credentials or real vault was changed. No live agent calls, model downloads or hardware benchmarks were run. Only this report was written.

**Recommendation:** finish the existing Node 24 / React / Markdown + SQLite product. Borrow interaction and memory patterns; add at most a streaming Markdown renderer and selectively approved browser model assets. Replacing Jarvis with a larger harness or memory platform would consume the laptop's budget and delay completion.

**Evidence convention:** stars are rounded GitHub totals observed during research, not quality scores. Dates are upstream release dates where verified; **NV** means the latest release/date was not independently resolved, not that a project is abandoned. A current README can describe newer work than its release page. Model download size is distinct from runtime RAM and GPU memory. All effort estimates below are developer hours including focused verification, not owner review time.

## Priority by how finished it will feel

| Rank | Area | What the owner notices | First useful implementation |
|---|---|---|---|
| 1 | D — chat and run visibility | Answers look intentional; no internal instructions/JSON masquerading as conversation | Typed run purpose + visibility, truthful steps, streaming Markdown: 8–14 h |
| 2 | A — voice lifecycle and turns | Jarvis consistently hears, responds and stops; no stuck states | Repair branch edge cases, explicit duplex mode, turn epochs: 6–10 h; semantic endpointing adds 8–14 h |
| 3 | E — SDK/MCP orchestration | Both agents can actually use memory and explain a blocked action | Per-tool MCP policy + annotations + smoke diagnostics: 3–5 h |
| 4 | F — recovery and onboarding | Sleep, reconnect, expired login and missing devices are recoverable | Reconnect reconciliation, resource cap, readiness diagnostics: 8–14 h |
| 5 | C — memory quality | Remembers corrections, finds loosely phrased facts, shows evidence | Relaxed FTS retrieval + provenance/supersession proposals: 10–18 h |
| 6 | B — voice model quality | Better pronunciation and naturalness after the conversation works | Keep Kokoro; measured browser A/B of one challenger: 4–8 h |

E has a functional blocker and belongs in the first implementation batch even though D/A dominate perceived polish.

## What is actually current

Checked all three requested discovery sites live:

| Source | Observation on 3 Nov | Consequence |
|---|---|---|
| [Trendshift live](https://trendshift.io/) | Live list included DeepSeek Harness, `rerun-build/rerun` and local Windows/Android `thtbee/nectarlink`; it mixes small new projects with established ones | Discovery leads only. Their presence does not establish compatibility with the two official SDKs |
| [OSSInsight](https://ossinsight.io/) | Explicitly pauses star-based rankings because public-event ingestion undercounted events since mid-2025 | Do not cite its current star-growth rankings as November evidence |
| [GitHub Trending](https://github.com/trending) | Retrieved the current trending page/filter shell; repository rows were not exposed in the fetched result | No invented November rank or claim that a named candidate is trending |

More decision-relevant than hype: [Supertonic was archived on 9 Sep 2026](https://github.com/supertone-oss-archive/supertonic); [Crystal was deprecated in February 2026](https://github.com/stravu/crystal); [Vibe Kanban's April release includes sunsetting changes](https://github.com/BloopAI/vibe-kanban/releases); [Pocket TTS added sub-20M models in October](https://github.com/kyutai-labs/pocket-tts); [basic-memory 1.0 shipped 29 Oct](https://github.com/basicmachines-co/basic-memory/releases), and its current repository lists AGPL-3.0. Older comparison articles miss these changes.

## A. Voice turn-taking, interruption and wake word

### Worst current practices

| Finding and concrete failure | Evidence | Smallest correction |
|---|---|---|
| Fixed 700 ms silence is treated as an entire turn; a pause in “research… the backup options” splits the request | `web/src/voice/engine.ts:338`, `:361`; `stt.worker.ts:42` | Separate VAD segments from conversational turns; bounded buffering plus a completion decision |
| Any VAD speech stops output immediately, including speaker echo | `engine.ts:351–355` | Explicit speaker/headset modes and a cancellable interruption state |
| Transcription promise has no deadline; worker errors without an ID leave it unresolved | `engine.ts:239–241`, `:391–400` | Branch deadlines/restarts, with the additional corrections below |
| Every noise segment joins an unbounded serial Whisper queue | `stt.worker.ts:49–50` | One executing + one pending segment; expose dropped/superseded status |
| Wake word is recognized only after STT; idle speech still pays full ASR cost | `controller.ts:124–136`; `intents.ts:35` on main | Keep push-to-talk/follow-up first; add a small wake detector only after latency measurements |
| Resetting `queue = Promise.resolve()` cannot cancel callbacks already attached to the old promise; an older announcement can play after a reply | `controller.ts:90–103` | Speech generation/epoch checked before every queued action; cancellation settles all waits |

**Echo cancellation already exists:** `web/src/voice/microphone.ts:10–15` requests `echoCancellation: true`, noise suppression, AGC and mono. Do not prescribe adding the same flag again. Inspect actual `track.getSettings()` and test the real output device: requesting browser AEC does not prove successful cancellation of all Web Audio playback. [Browser constraint semantics](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/echoCancellation).

### Best patterns/projects to take

| Candidate | Licence / stars / recency | Take exactly | Jarvis integration / effort |
|---|---|---|---|
| [Pipecat Smart Turn](https://github.com/pipecat-ai/smart-turn), [weights](https://huggingface.co/pipecat-ai/smart-turn-v3) | BSD-2-Clause; ~1.6k; README v3.2, no GitHub releases found | **Model file + inference/preprocessing idea**, not the Python Pipecat stack | Browser worker with existing ONNX runtime; start with ~8 MB int8 on WASM to avoid GPU competition. 8–14 h |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx), [keyword-spotting design](https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/kws/index.rst) | Apache-2.0 code; ~15.7k; current changelog/release activity, latest date NV; model licences separate | **Browser WASM keyword-spotting artifact + model**, if its English checkpoint passes the owner's accent test | Worker receives mic frames; detector opens follow-up window and releases pre-roll into STT. No Node addon. 8–14 h |
| [openWakeWord](https://github.com/dscripka/openWakeWord) | Apache-2.0 code; ~2.9k; README's latest announced release v0.6.0, 2024-02-11; pretrained weights CC BY-NC-SA 4.0 | **Feature pipeline and “hey jarvis” model only as an optional port** | Requires mel frontend, shared embedding model and wake classifier in browser, not just one ONNX file. 12–20 h; defer behind sherpa evaluation |
| [Moonshine browser streaming examples](https://github.com/moonshine-ai/moonshine/blob/main/docs/examples.md) | MIT streaming STT/code; ~11.4k; v0.1.5, [2026-08-24](https://github.com/moonshine-ai/moonshine/releases) | **Browser WASM STT library/artifacts**; partial/final transcript pattern | One alternative STT worker behind the current contract; final transcript alone dispatches a command. 8–14 h |

openWakeWord's documented web examples stream to Python; they are not proof of an official browser-only implementation. Its model licence differs from the code licence. [Upstream FAQ/licensing](https://github.com/dscripka/openWakeWord). [Porcupine Web](https://picovoice.ai/docs/quick-start/porcupine-web/) supports browsers but requires an AccessKey; reject it under the owner's no-key goal. Python wake-word services need explicit owner sign-off and are not recommended here.

### Concrete turn and interruption design

- Keep Silero for detecting speech; run Smart Turn only after candidate silence. Its reference uses **16 kHz mono, last 8 seconds**, Whisper feature extraction and normalization before ONNX inference. It is **not** `session.run(rawPCM)`. Match [reference preprocessing](https://github.com/pipecat-ai/smart-turn/blob/main/inference.py) in JS and test fixed audio fixtures for parity before judging accuracy. Pin the model revision: README says v3.2 while the example still names v3.1.
- Begin with 250–350 ms candidate silence; incomplete endpoint decisions extend the same turn, capped at about 1.5–2 s silence and a bounded total recording. These are tuning proposals, not model-author guarantees. Preserve the full turn for ASR while endpoint classification sees its bounded trailing window. Fallback to current silence detection if the classifier fails.
- **Speaker-safe mode:** half-duplex by default if the real laptop fails echo tests. Suppress normal recognition during playback, keep a visible/keyboard Stop and push-to-talk override. State clearly that acoustic barge-in is unavailable in this mode.
- **Headset/full-duplex mode:** AEC-enabled capture + persistent VAD. After a short sustained-speech confirmation, duck/pause output immediately; confirm human input from streaming STT/wake evidence, then cancel all buffered audio and obsolete synthesis. Target <200 ms audible pause, measured locally. Resume only on a rejected false trigger. Lexical similarity is a weak secondary signal, not an acoustic echo canceller.
- Use `turnId`, `speechEpoch` and worker generation on every request/result. A stopped turn cannot later submit a task, reopen a follow-up timer or resume an old announcement. Distinguish **Stop speaking**, **Stop agent**, and **Mute microphone**.
- Partial STT revises captions, never creates tasks. Commit once at endpoint/final. Keep pre-roll; cap buffered PCM; permit one active inference and one bounded pending item.

### Review of `fix/voice-stalls`

**What this change does:** six commits add memory path-policy normalization, echo filtering, capped ASR backlog, speech deadlines/restarts and a better follow-up window. The direction is good; it repairs real hangs, but is not a finished turn-taking implementation.

Reviewed `git log main..fix/voice-stalls` and `git diff main...fix/voice-stalls`, including tests and callers. Commits: `90602b6`, `9a95048`, `afc8349`, `5b729cf`, `555d311`, `988fa44`. The memory-policy fix is unrelated to voice but valuable: `./CORE.md`, casing and backslashes no longer bypass protected-note approval. Keep it as an independently reviewable change.

| Severity | Remaining issue, with branch evidence | Required fix |
|---|---|---|
| Must fix | **A speech reply can disappear during startup.** Any `ready` message reads and clears `held`, including `what: 'ears'`. If STT becomes ready before TTS, “Yes?” is resolved without being spoken. **Voice branch** `engine.ts:208–217` | Touch `held` only inside the voice-ready path; regression fixture emits ears-ready before voice-ready. 0.5–1 h |
| Must fix for claimed responsive interruption | Output stops only after full segment STT completes; the owner must finish speaking while Jarvis continues. **Voice branch** `engine.ts:411–431` | Immediate duck/pause on qualified onset in full-duplex mode; sentence-final STT cannot provide low-latency barge-in. 3–5 h |
| Should fix | **Timeout uses a stale loaded flag.** A request submitted while downloading captures `loaded=false`; even if the model becomes ready a second later and inference hangs, it waits 120 s and then drops without restarting. **Voice branch** `engine.ts:436–446` | Separate download readiness deadline from execution deadline; re-arm when inference starts. 1–2 h |
| Should fix | Lexical echo filter discards legitimate replies sharing words with the answer. If Jarvis says “The backup is at two” and the owner says “at two?” during overlap, all reply words match. Wake words bypass echo protection entirely. **Voice branch** `intents.ts:28–35`; `engine.ts:424` | Never use word overlap as the sole rejection criterion. Add speaker tests and constrain heuristic to credible playback echo. 1–2 h |
| Should fix | TTS cancel marks `current`, but cannot abort an executing `generate`; replacement speech waits behind the old render. `tts.worker.ts:103–110`, `:117` onward (unchanged) | Deadline + bounded synthesis chunks; terminate/recreate only when cancellation latency exceeds budget. Measure GPU release cost. 2–4 h |

The bounded STT queue, per-request completion, restart ceiling, TTS watchdog and wake-window extension are worth retaining. Tests cover several stalls and echo cases, but mocks do not validate AEC, actual ONNX cancellation, playback suspension or GPU memory. Branch tests were inspected, not executed from this read-only main checkout. **Verdict: fix the held-reply bug and loading/execution deadline split before merging; label the echo change as a mitigation, not full-duplex completion.**

## B. Voice quality within an 8 GB Windows laptop

### Current weak points

- `tts.worker.ts:40–47`, `:69–76` couples “best” to fp32; Kokoro's 326 MB graph can be much larger than an appropriate quantized variant. No owner-device listening result justifies that default.
- `stt.worker.ts:19–29` chooses fp32 encoder whenever any GPU adapter exists, without testing its limits or providing an inference-failure WASM fallback. Selecting large-v3-turbo with this policy can load a **2.55 GB encoder plus decoder**, before runtime copies/workspaces.
- `tts.worker.ts:105–110` generates a complete sentence before output; this is sentence chunking, not token/audio-frame streaming. First-sentence length determines first-audio delay.
- Both models preload (`engine.ts:250–260`); “has a GPU” does not establish discrete VRAM. An integrated GPU shares the already scarce system RAM. Retention and quality need an actual resource profile.

### Four best TTS choices for this project

**Keep Kokoro as the reliable baseline; evaluate Pocket TTS first for streaming, Kitten 0.8 for minimum footprint, Supertonic only as a pinned archived option.** No source proves one universally best-sounding browser model on this unspecified GPU. Choose by blind listening and measured first-audio latency.

RAM below is an **engineering planning range for the voice worker**, excluding OS, browser chrome and agent processes; actual peaks can exceed it. Latency targets are warm short-utterance targets to measure, not benchmark results from this laptop.

| Model / adoption | Licence, popularity, recency | Realistic assets and runtime budget | Streaming / latency and fit |
|---|---|---|---|
| [Kokoro v1 82M](https://github.com/hexgrad/kokoro) — **retain library/model** | Apache-2.0; ~9.9k; v1.0 model, latest package release date NV | [ONNX files](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/tree/main/onnx): q8 **92.4 MB**, fp16 **163 MB**, fp32 **326 MB**; plan ~0.3–0.8 GB q8 or ~0.6–1.2 GB fp32 peak | Browser WASM/WebGPU established through current stack. Sentence streaming; target first audio <0.5–1 s. Tune voice/pronunciation before replacing. 2–4 h |
| [Pocket TTS](https://github.com/kyutai-labs/pocket-tts) — **browser WASM artifact**, conditional | MIT code; base model commonly CC BY-4.0, voices have individual terms; ~10.2k; [v4.0.1 2026-10-21](https://github.com/kyutai-labs/pocket-tts/releases) | Base 100M: ~200 MB fp16 / ~400 MB fp32 weight arithmetic; budget ~0.5–1.2 GB with decoder/runtime. October **18.2M / 6.9M / 1.9M** variants include decoder: ~73/28/8 MB fp32 arithmetic, not verified browser bundle sizes | True audio streaming. Upstream reports ~200 ms first chunk and ~6x realtime on M4 Air, not Windows evidence. Community browser ports; verify version parity. 8–16 h |
| [KittenTTS 0.8](https://github.com/KittenML/KittenTTS) — **small ONNX + frontend** | Apache-2.0 repo; ~16.8k; [0.8.1 2026-02-24](https://github.com/KittenML/KittenTTS/releases); current main also advertises Kitten 2 | 15M nano int8 **25 MB**, micro **41 MB**, mini **80 MB** upstream sizes; plan ~0.15–0.6 GB for 0.8 worker plus phonemizer/runtime | Sentence generation; browser port must reproduce phonemization and validate supported operators. Do not assume WebGPU is faster than WASM. 6–12 h |
| [Supertonic 3](https://github.com/supertone-oss-archive/supertonic) — **pinned web example and weights**, optional | MIT code; weight terms separate; ~13.8k; archived **2026-09-09**, v3 release activity May 2026 | 99M; ~396 MB fp32 arithmetic before other assets; plan ~0.6–1.3 GB. Confirm exact four-graph bundle and archived model licence before downloading | Official browser/WebGPU example exists; iterative synthesis, sentence chunks rather than proven continuous token streaming. Speed claims are vendor/platform dependent. 6–10 h; maintenance burden makes it secondary |

**Important November corrections:** Kitten 2 is not the 25 MB ONNX model: its README describes **1.7B, 492 MB backbone**, about **2 GB disk**, **6 GB CPU RAM or ~8 GB free GPU memory**. Reject for this laptop; do not confuse compressed weights with end-to-end runtime. Pocket's upstream-linked `KevinAHM/pocket-tts-onnx-export` returned **404** during research; an old demo link is not an integration dependency. Prefer a reachable WASM port listed by upstream and pin it, or budget an export-validation spike. [Kitten requirements](https://github.com/KittenML/KittenTTS), [Pocket browser-port list](https://github.com/kyutai-labs/pocket-tts#in-browser-implementations).

### Other named TTS families: screen them out accurately

| Family | Licence / stars / recency signal | Size, memory, latency and streaming reality | Decision |
|---|---|---|---|
| [Chatterbox](https://github.com/resemble-ai/chatterbox) | MIT; ~27.5k; current README includes **110M Nano**, **350M Turbo**, **500M multilingual V3**; latest release date NV | fp16 backbone arithmetic ~220/700/1000 MB plus decoder/vocoder. Plan ~0.6–1.5 GB Nano, 1.5–3+ GB Turbo, implementation dependent. Nano claims 3x realtime on 8 CPU cores; browser first-audio and streaming unverified here | Nano merits a later **6–10 h browser-export spike**, not a promised drop-in. Python reference sidecar would require sign-off; no reason to add it before lighter candidates |
| [Orpheus](https://github.com/canopyai/Orpheus-TTS) | Apache-2.0 repo, check base-model terms; ~6.4k; release date NV | Main 3B-class model: ~6 GB fp16 backbone alone, KV cache and speech decoder extra; quantized backbone ~1.5–2 GB still needs runtime. Native streaming claims do not establish browser latency | Reject default. Browser/WebGPU port is substantial work; native/Python service needs sign-off |
| [Dia](https://github.com/nari-labs/dia) | Apache-2.0; ~19.4k; release date NV | 1.6B baseline: ~3.2 GB fp16 weights before codec/activations; multi-GB runtime. Baseline generates dialogue in one pass; chunking a recording is not low-latency streaming | Reject for assistant turns on this machine. Later Dia-family releases require separate evaluation |
| [Sesame CSM](https://github.com/SesameAILabs/csm) | Apache-2.0 repo; ~14.7k; release date NV; check backbone/gated asset terms | 1B backbone + audio decoder; >2 GB fp16 weights and several-GB runtime. Conversational audio research model, not an established small browser speech service | Reject default; no validated Windows-browser first-audio result |
| [Kyutai delayed streams](https://github.com/kyutai-labs/delayed-streams-modeling) | Separate from Pocket; model-specific licences, stars/date NV | Multi-billion-parameter STT/TTS family; model-native streaming, but multi-GB weights and accelerator runtime. Server benchmarks cannot be carried over to WebGPU | Take the incremental-audio idea; use Pocket for the lightweight experiment |
| [NeuTTS](https://github.com/neuphonic/neutts) | ~6.3k; Air listed Apache-2.0, other families use **NeuTTS Open License 1.0**; [licence updated 2025-12-11](https://github.com/neuphonic/neutts/blob/main/LICENSE); latest release date NV | Air ~0.5B, Nano ~0.23B class: q4 backbone ~0.15–0.4 GB plus codec/runtime; plan ~0.7–2 GB. Current table says **streaming GGUF only**. ONNX codec decoder is not an ONNX speech backbone | Reject as a browser ONNX drop-in. GGUF/browser or sidecar is a separate 16–30 h project needing owner sign-off for sidecar |

### STT comparison and concrete integration

| Choice | Evidence / licence / recency | Size, working budget, latency / streaming | Take and effort |
|---|---|---|---|
| Existing Whisper tiny/base through Transformers.js | [Whisper](https://github.com/openai/whisper) MIT; model asset date NV; already installed pipeline | Quantized tiny/base roughly tens to ~150 MB, dtype dependent; budget ~0.2–0.8 GB. Current code is endpoint batch, not live caption streaming | **Retain baseline model** and fix lifecycle. 2–4 h; chunked overlapping windows/committed prefix add 4–8 h |
| [Moonshine streaming](https://github.com/moonshine-ai/moonshine), [licence](https://github.com/moonshine-ai/moonshine/blob/main/LICENSE) | ~11.4k; MIT all streaming STT, with named legacy non-streaming language exceptions; v0.1.5 **2026-08-24** | Tiny/small/medium assets vary by architecture/quantization; reserve roughly 30–300 MB download pending manifest, ~0.2–0.8 GB runtime. True partial/final streaming; upstream's tens-of-ms native decode timings are not browser end-to-end latency | **Best streaming spike:** official browser WASM example; no native npm binding. 8–14 h. Measure supported language/accent and Hindi/English mixing |
| [Whisper large-v3-turbo ONNX](https://huggingface.co/onnx-community/whisper-large-v3-turbo/tree/main/onnx) | MIT underlying Whisper; ONNX conversion by community; asset release date NV; GitHub stars do not apply to HF model | fp16 encoder **1.27 GB** + merged q4f16 decoder **194 MB**; current Jarvis fp32 encoder is **2.55 GB** + q4 decoder **334 MB**. Plan **2.5–5+ GB** runtime peak including staging/cache; unknown GPU may not fit | **Optional model profile only**, never default with 0.5–2 GB free RAM. Whisper remains windowed ASR; “streaming” requires overlapping windows + stabilization. 4–8 h compatibility spike, contingent on memory |
| [Parakeet TDT v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3), [WebGPU conversion](https://huggingface.co/striimit/parakeet-tdt-0.6b-v3-webgpu/tree/main) | CC BY-4.0 model; NVIDIA upstream, community browser conversion; release date NV; no GitHub stars for model | 0.6B; inspected browser bundle **1.31 GB** (~1.24 GB fp16 encoder). Quantized alternatives around 0.65–0.75 GB exist but need operator validation. Plan **1.5–3+ GB** working memory. Fast offline model; TDT does not automatically mean causal streaming | **Take model + decoder algorithm only after Moonshine**. Needs log-mel frontend and TDT decode state, not current Whisper opts. 12–20 h. v3's language coverage does not make it a Hindi ASR replacement |

Acceptance for any model change: 20 owner-approved short clips (accent, names, numbers, pauses, noise, echo), five cold/warm launches, first/final transcript latency and word error rate; five fixed TTS passages and blind A/B; peak browser private memory and GPU allocation with **both agents active**. Keep one STT and one TTS loaded. Initial product target: voice pipeline comfortably below ~1 GB incremental memory; if not, unload on idle or choose a smaller model. No Python sidecar is justified before these browser options fail a measured quality gate.

## C. Memory: keep Markdown + SQLite; improve the write/retrieval contract

### Worst current practices

| Gap | Evidence / failure | Concrete replacement |
|---|---|---|
| Every search token is mandatory in both FTS and LIKE; a natural-language query can miss an obvious fact | `server/src/memory/vault.ts:211–237`: implicit AND in FTS; explicit AND in fallback | Strict query first, then escaped OR/coverage-ranked fallback, aliases and time/project filters; return why a hit matched |
| Whole-note replacement is the update primitive; no fact validity/supersession contract | `server/src/memory/proposals.ts:70–75`, `:78–103` | Stable fact ID + proposed add/update/retract/no-op; preserve source and valid time |
| Protected-note classification on main compares raw casing/path spelling | `proposals.ts:29–31`, `:56–62` | Retain branch canonicalization before policy; containment still enforced by vault resolver |
| Consolidation is a broad prose instruction, without durable cursor or bounded changed-note set | `server/src/memory/maintenance.ts:70–75` | Index-derived list since last checkpoint, changed-note budget, result receipt and resumable next batch |

Already good: vault remains editable; FTS has BM25/title weighting; proposals back up files and detect stale replacement hashes (`proposals.ts:145` onward). Extend these, do not replace them with a black-box memory daemon.

### Comparison: four strongest patterns plus the requested alternatives

| Project | Licence / stars / release evidence | What to take; why not install its runtime |
|---|---|---|
| [basic-memory](https://github.com/basicmachines-co/basic-memory) | **AGPL-3.0 current**, ~4.5k; [1.0.0 **2026-10-29**](https://github.com/basicmachines-co/basic-memory/releases) | **Idea:** Markdown observations, typed links and MCP context expansion. Closest storage fit, but Python and a second index/writer duplicate Jarvis. Implement the simple schema in TS; do not copy code without reviewing licence obligations. 4–6 h |
| [Mem0](https://github.com/mem0ai/mem0) | Apache-2.0; ~68.3k; [Python 2.2.1 **2026-09-25**](https://github.com/mem0ai/mem0/releases/tag/v2.2.1); Node release stream separate | **Idea:** extract candidate facts, compare existing records, choose add/update/delete/no-op. Its default storage/provider approach does not meet the no-vector/no-key goal; an npm package does not remove that mismatch. 4–6 h |
| [Graphiti / Zep OSS engine](https://github.com/getzep/graphiti) | Apache-2.0; ~32.5k; [0.31.2 **2026-10-20**](https://github.com/getzep/graphiti/releases/tag/v0.31.2) | **Idea:** distinguish event time from recording time and invalidate superseded facts. Use SQLite columns; no Neo4j/FalkorDB/embedding runtime. Zep hosted service is not required. 4–6 h |
| [Letta](https://github.com/letta-ai/letta) | Apache-2.0 listed; ~25.3k; current README redirects active development; V1 server retired to `archive`; current release date NV | **Idea:** explicit bounded always-loaded memory and deliberate background consolidation. Keep Jarvis's 2k CORE / 6k context limits. Do not adopt a second agent runtime. 2–4 h |
| [memU](https://github.com/NevaMind-AI/memU) | ~14.6k; README says Apache-2.0 but GitHub does not classify the licence; exact licence text/release date NV | Hierarchical resource → item → category summaries are useful **ideas** for retrieval. No package recommendation until licence and current runtime requirements are resolved; Python/service route needs sign-off |
| [cognee](https://github.com/topoteretes/cognee) | Apache-2.0 listed; ~33k; [1.6.6 **2026-10-29**](https://github.com/topoteretes/cognee/releases) | **Ideas:** provenance and explicit conflict resolution. Its graph/vector ingestion pipeline is disproportionate here. Newer keyless/local options do not make its full stack compatible with this machine |
| [Claude Code native memory](https://code.claude.com/docs/en/memory) | Official feature; package/repository licence and star count not meaningful for memory feature | CLAUDE.md + auto-memory are agent-local recall/instructions. Useful for project conventions; not shared canonical personal memory or a replacement for approval-governed vault facts |
| [Codex native memories](https://learn.chatgpt.com/docs/customization/memories) | Official feature; feature stars/licence N/A; current docs checked Nov 3 | Local memory generation/consolidation has idle and quota controls; generated files live under Codex home. Borrow the delayed/quota-aware schedule; do not manually rewrite SDK-owned memory. Keep Jarvis MCP as shared truth |

### Exact no-vector integration

1. **Fact extraction:** after meaningful completed runs, use one small structured-output pass through the already selected official agent, with source run/message IDs. Extract only stable preferences, decisions, project status and useful commitments. Distinguish owner assertion from agent inference. No extraction for greetings, retries, unaccepted suggestions or internal runs. Start with max 5 candidates/run and a daily quota budget.
2. **Update/replace:** candidate `{id, subject, predicate, value, source, observedAt, validFrom, validTo, supersedes, confidence, sensitivity}`. Match subject/predicate + aliases with FTS; ask the agent to return `add | update | retract | noop`, and evidence. Update approval becomes a small fact diff; CORE/Projects/People/Areas still need approval. Rejected facts stay rejected by fingerprint, avoiding repeated prompts.
3. **Temporal validity:** “uses X” can end when “now uses Y” is approved; preserve the old claim with `validTo`. Keep `recordedAt` separate from real-world `validFrom`; unknown date stays unknown. Store stable IDs/metadata in Markdown; SQLite is a rebuildable projection, not the only copy.
4. **Relaxed retrieval:** normalize → strict FTS → if insufficient results, OR terms with minimum coverage, aliases and title/project boost → recency/validity tie-breakers. Label partial matches and include note path, excerpt, source and valid dates. Use existing [FTS5 Boolean/BM25 support](https://www.sqlite.org/fts5.html); no embeddings needed. Add deterministic fixtures for paraphrase, correction, date and conflicting preferences.
5. **Schedule:** deterministic changed-note indexing on file events; daily idle candidate batching with at least a few hours of inactivity; weekly bounded consolidation using existing scheduler. Skip while voice/models are loading, both agent slots are busy or quota headroom is low. Checkpoint batches and produce proposals, not silent authoritative rewrites. Keep backups, base-hash conflict checks and a reviewable receipt.

Combined implementation: **10–18 h** for a minimal coherent slice (estimates above overlap). No compelling argument for a vector store at this vault scale; revisit only if an owner-specific retrieval benchmark shows sustained misses after aliases and relaxed FTS.

## D. Chat UI and internal runs

**Intended hierarchy:** the owner's question and readable answer dominate; live activity is a compact secondary disclosure, with routing/debug data on demand. This follows `docs/DESIGN.md`; this is a source review, not a rendered visual-quality certification.

### Worst practices in current flow

| Finding | Evidence | Consequence |
|---|---|---|
| Run persistence doubles as conversation message storage | `server/src/tasks/orchestrator.ts:408–413`; `web/src/pages/Ask.tsx:84–87`, `:155–166` | Consult/learning runs appear as top-level owner turns |
| UI recognizes only `side:both` / `side:second opinion`; ordinary prompt splitting is used as a display boundary | `web/src/lib/ask.ts:60–68`; `server/src/collab/index.ts:35–42`; `server/src/skills/learning.ts:24–33` | `[jarvis:consult]`, `[jarvis:learn]` and structured JSON are rendered as conversation |
| Hidden-run contamination also affects next-agent context and history previews | `server/src/tasks/orchestrator.ts:279–291`; `server/src/api/conversations.ts:107` | Switching agents can tell the next agent that the owner wrote an internal learning instruction; latest preview can become JSON |
| A later tool call makes earlier still-running steps look completed without a result | `web/src/components/Thread.tsx:67` | Parallel/long-running tools falsely show success |
| Home-grown Markdown reparses the whole source per render and uses simple pipe splitting | `web/src/lib/markdown.tsx:25–44`, `:58–61`, `:257–258`; `Thread.tsx:199–200` | Open fences/formatting can jump; pipe-containing inline code can split table cells. Mermaid is rendered as ordinary code; no typed citation data |
| Composer drops failed attachments from submitted IDs while allowing send once uploads finish/fail | `web/src/components/Composer.tsx:118–135` | A question about an attachment can be sent without that attachment unless the owner notices the error |

### Best references and exact adoption

| Project | Licence / stars / recency | Take exactly / effort |
|---|---|---|
| [Vercel Streamdown](https://github.com/vercel/streamdown) | [Apache-2.0](https://github.com/vercel/streamdown/blob/main/LICENSE); ~5.7k; [2.7.1 **2026-10-19**](https://github.com/vercel/streamdown/releases) | **Library** for incomplete Markdown, GFM tables, code and optional lazy Mermaid. Keep current typography/CSS/wikilink adapter. No Vercel hosting or AI SDK/provider change. 4–7 h |
| [assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT; ~12.9k; [release activity **2026-10-28**](https://github.com/assistant-ui/assistant-ui/releases), react 0.15.32 listed | **Ideas first:** typed message parts, tool states, scroll anchoring and composer semantics. Full runtime migration unnecessary; headless components only if they remove code. 3–5 h |
| [LibreChat](https://github.com/LibreChat-AI/LibreChat) | MIT; ~46.7k; current repo, last release date NV | **Interaction ideas:** source references, artifact/code separation, grouped tool disclosures. Do not import its backend/provider infrastructure. 3–5 h |
| [Open WebUI](https://github.com/open-webui/open-webui) | ~157.6k; [custom licence with branding condition/exceptions](https://github.com/open-webui/open-webui/blob/main/LICENSE), not simply MIT; last release date NV | **Ideas:** citations linked to evidence, useful retry and status surfaces. Avoid copying large Svelte/Python app code. 2–4 h |

[Lobe Chat now redirects to LobeHub](https://github.com/lobehub/lobehub): ~83.7k, **LobeHub Community License**, latest release date NV. Useful reference for agent identity, navigation and composed message parts; a changed brand/licence and expanding runtime make it a design reference, not a fifth dependency.

### Model hidden/system work properly

- Add persisted `runPurpose: user_reply | second_opinion | consult | learning | consolidation | maintenance`, `visibility: conversation | activity | internal`, `parentRunId`, `triggerMessageId`. Store **owner text separately from executable prompt**. Do not infer roles from bracket prefixes or agent-written text.
- `user_reply` attaches an assistant message to the actual user message. `second_opinion` attaches a visible alternate answer. `consult` attaches a compact tool/activity disclosure to its parent; its raw prompt stays debug-only. `learning` stores validated proposal JSON and updates Skills/Memory, never an answer bubble or spoken reply.
- Enforce this in the conversation API/projection **and** history builder, preview/search, last-agent selection and voice subscription. Client-only hiding leaves the context poisoning intact. Keep raw audit runs in an explicit inspector, with sensitive tool output redacted.
- Backfill known `route_reason` labels once, preserving audit records. Prefix matching can assist migration but must not be the ongoing security/model boundary. Existing `[jarvis:*]` text in a real owner message must remain visible.
- Introduce typed content parts: `text`, `tool_call`, `tool_result`, `citation`, `file`, `proposal`. Correlate a call/result by `(runId, callId)`; only result/error/cancel events change terminal state. Cancelled and interrupted are distinct from done.
- Streamdown adapter: throttle updates to an animation frame or short bounded batch, memoize stable blocks, preserve “scrolled up” state, show a jump-to-latest affordance. Lazy-load Mermaid/highlighter; theme from tokens; strict Mermaid security, sanitized links, and disable remote images by default so agent output cannot silently fetch tracking URLs. [Current Streamdown security/release notes](https://github.com/vercel/streamdown/releases).
- Citations are structured source IDs and verified URLs from SDK/tool results, rendered as discreet footnotes/source chips with evidence on demand. Never turn an arbitrary model string into a trusted source badge. Tool rows show human labels/duration and an explicit raw input/output expander.

Typed visibility/history repair **4–6 h**, renderer **4–7 h**, attachment send guard **0.5–1 h**; integrate these before larger visual redesign. Verify actual screens at 375×812 and 1440×900 in both themes, reduced motion, keyboard focus and a long streamed answer; no visual pass was claimed in this report.

## E. Claude + Codex orchestration and MCP approvals

### Current bad practices

- `server/src/runners/codex.ts:35–46` supplies MCP transport and hardcodes `approvalPolicy: 'never'` without MCP per-tool policy. A tool needing confirmation cannot surface an interactive approval in this SDK exec flow.
- `server/src/mcp/tools.ts:2–6`, `:10–71` provides no annotations. Codex cannot distinguish a vault read from a mutation using tool metadata.
- `server/src/mcp/stdio.ts:22–28` has no fetch deadline; a hung loopback call can outlive the agent tool timeout. Add `AbortSignal.timeout()` and a useful retryable tool error, with a distinct longer bound for approval waiting.
- `server/src/tasks/orchestrator.ts:399–436` side runs are not registered in the main active-handle map. They can outlive task Stop and escape its normal concurrency accounting. `ask()` also intentionally bypasses the background queue (`:249–275`). Resource management must cover every official agent process.

### Reference shortlist, not replacement harnesses

| Reference | Licence / stars / recency | What it does better; take exactly |
|---|---|---|
| [CloudCLI / claudecodeui](https://github.com/siteboon/claudecodeui) | AGPL-3.0; ~14.4k; [1.37.7 **2026-10-31**](https://github.com/siteboon/claudecodeui/releases) | Current multi-CLI session UX, queued follow-ups, fork/history handling and mobile composer fixes. **Take session/recovery interaction ideas**, not server/auth/provider code. 4–8 h |
| [Vibe Kanban](https://github.com/BloopAI/vibe-kanban) | Apache-2.0; ~28.6k; [0.1.44 **2026-04-24**](https://github.com/BloopAI/vibe-kanban/releases), sunsetting notice/changes | Worktree isolation, normalized execution logs and review/diff workflow. **Take review-before-merge pattern**; do not start a new dependency on the sunset runtime. 4–6 h |
| [Opcode](https://github.com/winfunc/opcode) | AGPL-3.0; ~22.4k; latest release date NV | Claude session/checkpoint/usage and MCP management reference. **Take inspector/checkpoint ideas**; it is not evidence of a maintained dual-SDK backend. Rust/Tauri stack does not fit Jarvis server. 3–6 h |
| [Crystal](https://github.com/stravu/crystal) | MIT; ~3.1k; deprecated **February 2026**, replaced by Nimbalyst | Parallel Claude/Codex worktree comparison. **Take side-by-side diff/result comparison idea**. Do not adopt deprecated shell/PTY/session implementation or its concurrency assumptions. 4–8 h |

Also checked conductor-like and bridge options: [charannyk06/conductor-oss](https://github.com/charannyk06/conductor-oss) is Apache-2.0, **54 stars**, release date NV; local workspace/diff/preview surface, with a Rust backend. Pattern reference only. [Dunqing/claude-codex-bridge](https://github.com/Dunqing/claude-codex-bridge) has **14 stars**, no root licence exposed in fetched listing, release date NV; bidirectional MCP consultation duplicates Jarvis's existing collab service and setup writes agent registrations. Do not install. “codex-bridge” names multiple unrelated projects; some offer provider substitution, keys or remote tunnels, which do not meet this task. Existing `consult_agent` + `handoff_to_agent` is enough once lifecycle/visibility is repaired.

### Correct fix for “requires approval but approval policy is never”

**`never` means never ask, not approve everything.** Official [Codex MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) documents server defaults and `tools.<tool>.approval_mode`; the [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) lists `auto | prompt | writes | approve`. Upstream [auto-approval resolver](https://github.com/openai/codex/blob/main/codex-rs/codex-mcp/src/mcp/mod.rs) checks explicit `Approve` before the global `Never` handling. This supports a narrow per-tool override while retaining `workspace-write`/`read-only` sandboxing.

Proposed **per-run SDK config**, not a change to `~/.codex/config.toml`:

```toml
# Preserve generated command/args/env for the jarvis stdio server.
[mcp_servers.jarvis]
enabled_tools = ["search_memory", "search_conversations", "read_note", "list_projects", "get_usage", "save_memory", "request_approval"]
default_tools_approval_mode = "prompt"

[mcp_servers.jarvis.tools.search_memory]
approval_mode = "approve"
[mcp_servers.jarvis.tools.search_conversations]
approval_mode = "approve"
[mcp_servers.jarvis.tools.read_note]
approval_mode = "approve"
[mcp_servers.jarvis.tools.list_projects]
approval_mode = "approve"
[mcp_servers.jarvis.tools.get_usage]
approval_mode = "approve"
[mcp_servers.jarvis.tools.save_memory]
approval_mode = "approve"
[mcp_servers.jarvis.tools.request_approval]
approval_mode = "approve"
```

`save_memory` and `request_approval` are **stateful**, deliberately allowed to enter Jarvis's own proposal/approval gate; they are not falsely labelled read-only. `save_memory` may also auto-append allowed notes, so the owner must approve that policy, not just trust its name. Do **not** apply `default_tools_approval_mode = 'approve'` indiscriminately to every connector. Only expose consult/handoff/create/update tools after their scopes, concurrency/cancellation and policy are separately reviewed. `notify_owner` may send Telegram: it is outward-facing, not a harmless read.

Implementation: extend the config object built at `codex.ts:38–40` with `enabled_tools`, server default and `tools` maps. Installed **`@openai/codex-sdk 0.166.0`** supports arbitrary structured `config`/`configOverrides` (`node_modules/@openai/codex-sdk/dist/index.d.ts:221–240`); thread `approvalPolicy` stays `never`, sandbox stays explicit, API-key stripping stays intact. The **spawned CLI version** must also support those keys: log/version-check it, don't infer that from SDK version alone.

Add honest MCP annotations in `ToolDef` and `tools/list`: the five reads above `{readOnlyHint: true, destructiveHint: false, openWorldHint: false}`; mutations `readOnlyHint: false` with accurate other hints. [Official annotation guidance](https://developers.openai.com/plugins/build/mcp-server) says annotations inform confirmation behaviour but do not replace server authorization. With an annotation-aware `writes` policy, true reads may stop requiring prompts; annotations alone do not override an explicit prompt/managed requirement. Per-tool `approve` is the deterministic intended policy for this trusted local list.

Known upstream reports include [exec MCP auto-cancellation #29857](https://github.com/openai/codex/issues/29857) and [headless approval limitations #24135](https://github.com/openai/codex/issues/24135). They establish that related failures exist, not that every release/config is fixed. Acceptance: mocked config/annotation checks, then **owner-run real smoke** reads fixture memory, proposes a protected change and verifies it remains pending, declines an outward action and confirms nothing was sent. Include rejection from an unapproved external MCP tool. If supported per-tool config still fails, show CLI version and effective policy; don't disable sandbox or switch to API keys. **3–5 h** including diagnostic UI; owner smoke ~15 min.

### Subscription compatibility must be established, not assumed

The current [Anthropic Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says third-party developers may not offer claude.ai login/rate limits in products without prior approval, including SDK-based agents. Its quickstart points to API authentication. This is newer/more restrictive wording than the repo's assumption that official SDK usage alone establishes permission.

For this owner's private, local app, this research does **not** establish a definitive entitlement interpretation. Keep the official CLI/SDK and existing native login mechanism; never extract/replay OAuth tokens through another client. Have the owner verify permitted personal SDK use with Anthropic before treating “Claude Pro powers Jarvis” as a finished supported feature. Do not add API keys to resolve the mismatch. Codex should likewise use the official SDK/CLI's ChatGPT login, not Responses API MCP `require_approval` settings: those are a different product/config surface.

## F. Finishing work beyond new integrations

### Highest-value gaps with evidence

| Gap | Evidence / concrete failure | Implementation and effort |
|---|---|---|
| Reconnect can lose state | `server/src/api/core.ts:44–68`: per-connection IDs restart at 0, no replay; `web/src/lib/live.ts:33–44`: creates a new EventSource after error | On every hello/reconnect re-fetch authoritative task/run/approval state, merge persisted events by ID and discard stale deltas. Add a stream epoch/cursor later if needed. 3–5 h |
| Side work evades Stop/resource budget | `orchestrator.ts:118–119`, `:249–275`, `:399–436` | Register every run handle under one process budget; Stop cancels appropriate children. Avoid deadlock when a parent occupies a slot waiting for a consult: reserve capacity or reject/defer consult explicitly. 4–7 h |
| Readiness check only proves a text reply | `server/src/api/setup.ts:85–110`: verification prompt says no tools | Add separate cheap fixture MCP read test and a mic→caption→sample-voice check; distinguish auth, SDK/CLI version, tool policy, model loading, device and WebGPU failures. 3–5 h |
| Attachment failure is not a send barrier | `Composer.tsx:118–135` | Block until retry/remove/explicit “send without attachment”; preserve draft and file chips on server error. 0.5–1 h |
| Generic failure in a central thread | `Thread.tsx:56` fallback “Something went wrong”; Stop API catch swallowed at `Ask.tsx:99–100` | Specific next step and retry scope; expose failure to stop, not a false success state. 1–2 h |

### Best lightweight patterns to take

| Pattern/reference | Licence / stars / recency | Exact use |
|---|---|---|
| [SSE reconnect semantics](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events) | Web platform; project stars/release N/A; live docs checked | **Pattern**, no dependency: reconnect + snapshot reconciliation; replay only persisted events, not a second live answer |
| [Playwright visual comparisons](https://playwright.dev/docs/test-snapshots) | Apache-2.0 [project](https://github.com/microsoft/playwright); stars/latest release NV | **Dev-only test library** if not already present; fixture long answer, streaming, error, approval and mobile composer at the four required viewport/theme combinations. 3–5 h |
| [SQLite online backup](https://www.sqlite.org/backup.html), [Node SQLite](https://nodejs.org/api/sqlite.html) | SQLite public domain; Node's own distribution licence; stars/release not relevant to pattern | **Built-in backup/restore pattern**: consistent DB backup plus vault/config snapshot, retention and a fixture restore drill. Verify the backup API against installed Node 24: the unversioned web docs currently show Node 26. Do not copy only a live WAL database file. 3–5 h |

Minimum finish gate: cold start → login readiness → one question → one fixture memory lookup → interrupted voice reply → protected proposal → owner rejection → laptop sleep/wake → reopen same conversation. Visible errors must offer a specific next action; activity lamps must reflect actual runs. Keep diagnostics export local and redact tokens, prompts and real vault contents. No new workflow engine, monitoring service, vector database or sidecar is needed.

## Do these first — fits in ~2 hours of the owner's time

These are **owner review/validation slots**, not a claim that the full engineering work fits into two hours. Implementation estimates above remain separate. Total owner time: **115 minutes**.

| Order | Owner action / decision | Owner time | Expected impact |
|---|---|---|---|
| 1 | Confirm acceptable private Claude Pro SDK usage from current Anthropic guidance; approve keeping official native login only | 15 min | Resolves the central support/entitlement assumption before integration work expands |
| 2 | Approve typed run-purpose/visibility repair across UI, history, previews and voice; developer implements the D slice | 15 min | Removes internal prompt/JSON turns and prevents the next agent inheriting them as owner instructions |
| 3 | Review branch findings and approve the held-reply/deadline corrections; then review merge result | 15 min | Eliminates concrete startup/stall failures while preserving useful branch fixes |
| 4 | Approve the narrow Jarvis MCP allowlist/annotations; run fixture read + protected-write/deny smoke after implementation | 15 min | Makes memory tools usable without disabling sandboxing or opening all MCP tools |
| 5 | Choose speaker-safe default vs headset full-duplex after a real echo/interrupt check | 15 min | Replaces unpredictable interruption with a mode the owner can trust |
| 6 | Approve Streamdown adapter and review one long streamed answer/table/code/Mermaid fixture on phone and desktop | 15 min | Largest visible chat polish gain; keeps Jarvis's existing design and SDKs |
| 7 | Record/approve a small accent/name/noise clip set; select Kokoro baseline plus **one** challenger (Pocket streaming or Kitten small) | 15 min | Turns model selection into measured quality and memory decisions instead of repeated replacements |
| 8 | Approve relaxed FTS + source/validity/supersession proposals and run the reconnect/sleep acceptance script | 10 min | Better recall and corrections, plus confidence that finished work survives everyday laptop use |
