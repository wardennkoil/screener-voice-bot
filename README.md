# Screener Voice Bot

An outbound phone screener for research studies. It dials a participant, holds a natural spoken conversation, asks the study's eligibility questions one at a time, decides eligibility server-side, and appends the answers to a CSV.

**Stack:** Twilio ConversationRelay (Deepgram Flux turn detection + ElevenLabs voice + barge-in) ↔ Fastify/TypeScript WebSocket server ↔ a model via OpenRouter (default `google/gemini-3.8-flash`, streaming, function tools; direct Gemini also supported).

**Laptop mode:** the same conversation engine, driven from a browser page with your microphone and speakers, using Deepgram Flux and ElevenLabs directly, so you can hear and tune the experience without Twilio.

```
phone ──PSTN──▶ Twilio ──ConversationRelay (STT/TTS/interrupts)──▶ wss://your-host/cr
                                                                      │
                                              CallSession ─ ConversationEngine ─ Gemini
                                                  │              │
                                            timers/pacing   tools: record_answer, …
                                                  │
                                       data/screening_results.csv + data/calls/<sid>.json
```

## Setup

1. Node 22+. `npm install`.
2. Copy `.env.example` to `.env`. Minimum for the laptop mode: `OPENROUTER_API_KEY`, `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY`. For phone calls add Twilio (account SID, auth token, a voice-capable number, `PUBLIC_HOST` from ngrok) and a random `SESSION_TOKEN_SECRET`.
3. Edit `config/questionnaire.yaml`: study wording, persona name, the questions and their `eligible_if` rules. The CSV columns are derived from it.
4. `npm run typecheck && npm test`.

## Talk to it on your laptop (no Twilio)

```bash
npm run dev
```

Open `http://localhost:3000/local`, click **Start call**, allow the microphone, and say "Hello?" the way you would when picking up. The page shows the live transcript, the state (listening / thinking / speaking), and per-turn latency (your last word → first model token → first audio). Use headphones to test interrupting mid-sentence; a lone "uh-huh" while Sam is talking is ignored, real speech stops Sam and the model is told exactly what you heard. Results go to `data/local_results.csv` and `data/calls/LOCAL-*.json`.

The voice is parsed from `ELEVENLABS_VOICE`; if that voice id is not in your ElevenLabs library, set `ELEVENLABS_VOICE_ID` (premade voices work on the free tier).

## Choosing the model

Everything goes through OpenRouter (`LLM_PROVIDER=openrouter`). `OPENROUTER_MODEL` defaults to `openai/gpt-5.6-luna`: on this conversation's tool-calling turns it answered in about 0.9 s, against 2.3 s for `google/gemini-3.8-flash` and 6 s for `anthropic/claude-sonnet-5` (Sept 2026 measurements; Gemini also cannot run with reasoning disabled through OpenRouter). Requests ask OpenRouter for latency-sorted providers with data collection denied and low reasoning effort. Compare candidates on your own questionnaire with simulated participants:

```bash
npm run bench -- --models openai/gpt-5.6-luna,google/gemini-3.8-flash --persona eligible --n 2
```

It prints p50/p90 time-to-first-token, expectation pass rate, and tool-call errors per model. `npm run chat` and `npm run sim` accept `--model` too.

## Phone calls (Twilio)

Expose the server with `ngrok http 3000` and put the hostname in `PUBLIC_HOST`.

```bash
npm run dev                       # server on :3000 (Twilio must reach it via PUBLIC_HOST)
npm run dial -- --to +1555… --contact-id C001 --name Jordan --wait
npm run dial -- --contacts contacts.example.csv --dry-run
npm run dial -- --contacts contacts.csv         # batch, MAX_CONCURRENT_CALLS at a time, calling window enforced
```

Iterate on the conversation without placing calls:

```bash
npm run chat -- --name Jordan     # text harness: you are the person; /interrupt <heard words>; /quit
npm run sim -- --persona eligible --n 3   # Gemini plays a participant; see data/sim/
npm run sim -- --persona confused         # personas: eligible, ineligible, chatty, confused, declines, callback, wrong_person
```

Optional: drop a `assets/voicemail.mp3` (record it with the same ElevenLabs voice) and it is played when answering-machine detection fires; otherwise a Google voice reads a short message built from the questionnaire.

The control API (`POST /calls`, `GET /calls/:sid`) is what the dial CLI talks to. It is reachable through ngrok, so it requires `Authorization: Bearer <SESSION_TOKEN_SECRET>`; the CLI adds this automatically from `.env`. Attempt numbers are derived from prior rows in the CSV, so re-running a batch later retries `no_answer`/`busy`/`voicemail` contacts as attempt 2, 3, … while skipping contacts with a final outcome.

**Twilio trial accounts do not work for this project.** Twilio blocks the ConversationRelay verb on trial accounts (the call connects, Twilio says the verb is unavailable, and hangs up within seconds), rejects several Calls API parameters (`Method`, `Timeout`, answering-machine detection, `Record`, inline TwiML), only calls up to five verified recipients, and sends the TwiML fetch unsigned. The server detects a trial account at startup and refuses to dial with an explanation (`ALLOW_TRIAL_CALLS=true` overrides). To go live: upgrade the account in the Twilio Console (Billing -> Upgrade), buy a voice-capable phone number and set it as `TWILIO_FROM_NUMBER` (trial accounts use a shared Twilio number you don't own), restart the server. The dialer then uses the full parameter set automatically.

## Output

- `OUTPUT_CSV` (default `data/screening_results.csv`): one row per call attempt. Fixed columns, then one column per question id, optional `<id>__verbatim` columns, then callback/notes/transcript/recording. The header is created once; a header that no longer matches the questionnaire makes writes fail loudly instead of corrupting the file.
- `data/calls/<CallSid>.json`: full transcript, tool calls, per-turn latency (`firstTokenMs`), and raw ConversationRelay events.

Outcomes: `completed`, `partial`, `declined`, `callback_requested`, `wrong_person`, `voicemail`, `no_response`, `hung_up`, `no_answer`, `busy`, `failed`. Eligibility: `yes`, `no`, `undetermined`.

## Making it feel human (tuning knobs)

| Knob | Where | Notes |
|---|---|---|
| End-of-turn sensitivity | `EOT_THRESHOLD` (0.5–0.9) | 0.7 default. Lower = replies faster but may cut people off; raise if it interrupts. |
| False barge-ins | `INTERRUPT_SENSITIVITY` | `medium` + `ignoreBackchannel` keeps "uh-huh" from stopping the assistant. |
| Voice | `ELEVENLABS_VOICE` | `<VoiceID>-<model>-<speed>_<stability>_<similarity>`; try `turbo_v2_5` for richer delivery, `flash_v2_5` for speed. |
| Reply latency | `OPENROUTER_REASONING_EFFORT=low`, `OPENROUTER_PROVIDER_SORT=latency`, model choice (`npm run bench`), short system prompt, 400-token cap | Read `firstTokenMs` in the transcript JSON; target well under a second. |
| Pacing | `src/conversation/session.ts` `DEFAULT_TIMERS` | 2.5 s wait for "hello", 7 s silence before a nudge, goodbye allowed to finish before hang-up. |
| Silent gap after an answer | `BRIDGE_ACKS` in `src/conversation/engine.ts` | Models answer a recording with a bare tool call and speak one round later; the engine says "Got it." / "Okay." itself the moment the recording succeeds and tells the model not to repeat it. |
| Invented answers | premature-recording guard in `src/conversation/tools.ts` | A reply may only record the question that was pending when the person spoke; recording the question it just asked is refused and the question stands. |
| Wording | `src/conversation/prompt.ts` | Style rules and call flow. Run `npm run sim` after each change. |

## Compliance (read before real calls)

Only call people who consented to be phoned about the study. The assistant discloses it is automated at the start (required in several states) and offers a human callback; "stop / remove me" is honored immediately. Recording is off by default (`RECORD_CALLS`); if on, the assistant announces it. Keep calls within `CALL_WINDOW_LOCAL`. Screening answers are sensitive: protect `data/`, and check whether HIPAA obligations apply to your sponsor. This is not legal advice.
