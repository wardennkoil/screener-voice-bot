# Screener Voice Bot

An outbound phone screener for research studies. It dials a participant, holds a natural spoken conversation, asks the study's eligibility questions one at a time, decides eligibility server-side, and appends the answers to a CSV.

**Stack:** Twilio ConversationRelay (Deepgram Flux turn detection + ElevenLabs voice + barge-in) ↔ Fastify/TypeScript WebSocket server ↔ a model via OpenRouter (default `google/gemini-3.8-flash`, streaming, function tools; direct Gemini also supported).

**Laptop mode:** the same conversation engine, driven from a browser page with your microphone and speakers, using Deepgram Flux and Cartesia (Sonic 3.6) directly, so you can hear and tune the experience without Twilio. Twilio ConversationRelay has no Cartesia option, so phone calls keep speaking with ElevenLabs.

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
2. Copy `.env.example` to `.env`. Minimum for the laptop mode: `OPENROUTER_API_KEY`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`. For phone calls add Twilio (account SID, auth token, a voice-capable number, `PUBLIC_HOST` from ngrok) and a random `SESSION_TOKEN_SECRET`.
3. Edit `config/questionnaire.yaml`: study wording, persona name, the questions and their `eligible_if` rules. The CSV columns are derived from it. See [Editing the script](#editing-the-script).
4. `npm run typecheck && npm test`.

## Talk to it on your laptop (no Twilio)

```bash
npm run dev
```

Open `http://localhost:3000/local`, click **Start call**, allow the microphone, and say "Hello?" the way you would when picking up. The page shows the live transcript, the state (listening / thinking / speaking), and per-turn latency (your last word → first model token → first audio). Use headphones to test interrupting mid-sentence; a lone "uh-huh" while Maria is talking is ignored, real speech stops her and the model is told exactly what you heard. Results go to `data/local_results.csv` and `data/calls/LOCAL-*.json`.

The voice is Cartesia's Katie on `sonic-3.6`; change it with `CARTESIA_VOICE_ID` (the startup log confirms the key and voice, and lists alternatives if the id is unknown). Cartesia's free plan covers 20K characters a month, roughly 10–15 test calls. To go back to ElevenLabs, set `TTS_PROVIDER=elevenlabs` and `ELEVENLABS_API_KEY`; the voice is then parsed from `ELEVENLABS_VOICE` (override the id with `ELEVENLABS_VOICE_ID`; premade voices work on the free tier).

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
npm run sim -- --persona confused         # personas: eligible, ineligible, bmi_borderline, chatty, confused, placebo_no, declines, callback, wrong_person
```

Optional: drop a `assets/voicemail.mp3` (record it with the phone path's ElevenLabs voice) and it is played when answering-machine detection fires; otherwise a Google voice reads a short message built from the questionnaire.

The control API (`POST /calls`, `GET /calls/:sid`) is what the dial CLI talks to. It is reachable through ngrok, so it requires `Authorization: Bearer <SESSION_TOKEN_SECRET>`; the CLI adds this automatically from `.env`. Attempt numbers are derived from prior rows in the CSV, so re-running a batch later retries `no_answer`/`busy`/`voicemail` contacts as attempt 2, 3, … while skipping contacts with a final outcome.

**Twilio trial accounts do not work for this project.** Twilio blocks the ConversationRelay verb on trial accounts (the call connects, Twilio says the verb is unavailable, and hangs up within seconds), rejects several Calls API parameters (`Method`, `Timeout`, answering-machine detection, `Record`, inline TwiML), only calls up to five verified recipients, and sends the TwiML fetch unsigned. The server detects a trial account at startup and refuses to dial with an explanation (`ALLOW_TRIAL_CALLS=true` overrides). To go live: upgrade the account in the Twilio Console (Billing -> Upgrade), buy a voice-capable phone number and set it as `TWILIO_FROM_NUMBER` (trial accounts use a shared Twilio number you don't own), restart the server. The dialer then uses the full parameter set automatically.

## Editing the script

`config/questionnaire.yaml` holds the LMC Healthcare weight management screener: Maria calls someone who filled out the website form, checks it's a good time for about ten minutes, gets their okay, explains the elecoglipron study and its placebo, confirms the screening answers one at a time, offers a screening visit, gives the visit instructions and answers questions from the listed facts. The previous sleep-study sample lives on as the test fixture `test/fixtures/sleep-questionnaire.yaml`.

- **Wording**: `study.consent_script`, `study.briefing`, `study.facts` and `study.next_steps_if_eligible` are what Maria says, in her own words; she only answers from `briefing` and `facts` and sends anything else to the study team.
- **Callback number**: `study.callback_number_spoken` is still a placeholder; put the clinic's number there, written the way it should be spoken.
- **Visit slots**: the `screening_visit` options. Update them as slots change and keep `none of these` last; picking it makes Maria ask when they're available instead.
- **Early exit**: with `settings.stop_on_disqualify: true` the screening ends the moment an answer fails a rule (or loses interest after the placebo explanation). Maria thanks them, says this study isn't the right fit right now, and does not name the answer. A correction ("actually I stopped Ozempic five months ago") reopens the questions.
- **BMI**: the `bmi` block computes it from `height_inches` and `weight_lbs` (Maria converts metric) and qualifies at 30+, or 27+ when `high_blood_pressure` is yes. Results get a `bmi` column after the weight.

## Output

- `OUTPUT_CSV` (default `data/screening_results.csv`): one row per call attempt. Fixed columns, then one column per question id, optional `<id>__verbatim` columns, then callback/notes/transcript/recording. The header is created once; a header that no longer matches the questionnaire makes writes fail loudly instead of corrupting the file.
- `data/calls/<CallSid>.json`: full transcript, tool calls, per-turn latency (`firstTokenMs`), and raw ConversationRelay events.

Outcomes: `completed`, `partial`, `declined`, `callback_requested`, `wrong_person`, `voicemail`, `no_response`, `hung_up`, `no_answer`, `busy`, `failed`. Eligibility: `yes`, `no`, `undetermined`.

## Admin panel & call analytics

Open `http://localhost:3000/admin` while the server runs. It lists every saved call (`data/calls/*.json`, or the database when `DATABASE_URL` is set) and shows:

- **Overview**: outcomes, completion and eligibility, how far calls get through the questions (drop-off), the most common ways conversations leave the plan, sentiment mix, calls that need attention, answers the analyst doubts, and recommendations collected across calls.
- **Per call**: the transcript with tool calls, interruptions and system notes in place; a sentiment line over the call with off-plan moments marked; the AI analysis (summary, sentiment, each deviation from the plan with how well the bot handled it and a suggested fix, plan adherence, bot quality ratings, key moments, recommendations); planned vs actual question order with recorded values next to the person's own words; and measured mechanics (reply latency, talk-time share, interruptions, silence nudges, tool errors).

Each finished call is analyzed automatically in the background. The analyst model receives the bot's actual system prompt as "the plan", so deviations are judged against exactly what the bot was told. Results are cached (in `data/analysis/<call>.json`, or the database) and marked out of date if the transcript changes. Use **Analyze all pending** for calls saved before the panel existed. `ANALYSIS_MODEL` picks a different model for analysis. Latency does not matter there, so a stronger model is a cheap upgrade.

**Access:** by default (`OPEN_ACCESS=true`) `/admin` and `/local` are open to anyone who has the address, which is fine while there is only test data. Set `OPEN_ACCESS=false` before real participants' answers are stored; the rules below then apply. Transcripts contain health answers: without `ADMIN_TOKEN` the panel refuses anything that is not a direct localhost request (including requests through your ngrok tunnel). The laptop page `/local` follows the same rule, since every call on it spends Deepgram, Cartesia and OpenRouter credits. With a token, open `/admin?token=<ADMIN_TOKEN>` (or `/local?token=...`) once; a cookie then keeps you signed in to both. **Download results** in the panel header exports the results CSV for laptop or phone calls.

## Deploy free on Render + Neon

Render's free web service runs the laptop page and the admin panel online. Its disk is wiped on every restart, so the data goes to a free Neon Postgres database instead (`DATABASE_URL`). Render's own free Postgres is deleted after 30 days; Neon's is not. The phone path stays off there: the free service sleeps after 15 idle minutes, the next request waits about a minute, and Twilio webhooks cannot wait that long.

1. **Neon** ([neon.com](https://neon.com)): sign up (no card), create a project, and copy the **pooled** connection string (`postgresql://...-pooler...?sslmode=require`).
2. **Render** ([render.com](https://render.com)): sign up and connect GitHub with access to this repository.
3. Render → **New → Blueprint** → pick the repository and branch. It reads [`render.yaml`](render.yaml) and asks for the secrets: `DATABASE_URL` (from step 1), `OPENROUTER_API_KEY`, `DEEPGRAM_API_KEY`, `CARTESIA_API_KEY`, and optionally `CARTESIA_VOICE_ID` (leave empty for Katie).
4. When the deploy is live, open `https://<your-app>.onrender.com/admin`; the laptop page is at `/local`. Both are open while `OPEN_ACCESS=true`. With it set to `false`, copy `ADMIN_TOKEN` from the service's **Environment** tab (Render generated it) and open `/admin?token=<ADMIN_TOKEN>` once.

The tables are created on first start. To bring your existing local calls along, run `DATABASE_URL=<neon string> npm run db:import` on your machine: it copies `data/calls`, `data/analysis` and both results CSVs, and it is safe to re-run.

## Making it feel human (tuning knobs)

| Knob | Where | Notes |
|---|---|---|
| End-of-turn sensitivity | `EOT_THRESHOLD` (0.5–0.9) | 0.7 default. Lower = replies faster but may cut people off; raise if it interrupts. |
| False barge-ins | `INTERRUPT_SENSITIVITY` | `medium` + `ignoreBackchannel` keeps "uh-huh" from stopping the assistant. |
| Voice (laptop) | `CARTESIA_VOICE_ID`, `CARTESIA_MODEL_ID` | Katie on `sonic-3.6` by default. `TTS_PROVIDER=elevenlabs` switches back to ElevenLabs. |
| Voice (phone) | `ELEVENLABS_VOICE` | `<VoiceID>-<model>-<speed>_<stability>_<similarity>`; try `turbo_v2_5` for richer delivery, `flash_v2_5` for speed. |
| Reply latency | `OPENROUTER_REASONING_EFFORT=low`, `OPENROUTER_PROVIDER_SORT=latency`, model choice (`npm run bench`), short system prompt, 400-token cap | Read `firstTokenMs` in the transcript JSON; target well under a second. |
| Pacing | `src/conversation/session.ts` `DEFAULT_TIMERS` | 2.5 s wait for "hello", 7 s silence before a nudge, goodbye allowed to finish before hang-up. |
| Silent gap after an answer | `BRIDGE_ACKS` in `src/conversation/engine.ts` | Models answer a recording with a bare tool call and speak one round later; the engine says "Got it." / "Okay." itself the moment the recording succeeds and tells the model not to repeat it. |
| Invented answers | premature-recording guard in `src/conversation/tools.ts` | A reply may only record the question that was pending when the person spoke; recording the question it just asked is refused and the question stands. |
| Wording | `src/conversation/prompt.ts` | Style rules and call flow. Run `npm run sim` after each change. |

## Compliance (read before real calls)

Only call people who consented to be phoned about the study. With `caller.ai_disclosure: true` the assistant says it is automated at the start; with `false` (the sample config) it introduces itself as the persona from the study team and only says it is automated if someone asks, which it always answers truthfully. Proactive disclosure is legally required for calls into Texas and California and an FCC rule is pending, so check your jurisdiction and ethics board before turning it off. A human callback is offered and "stop / remove me" is honored immediately. Recording is off by default (`RECORD_CALLS`); if on, the assistant announces it. Keep calls within `CALL_WINDOW_LOCAL`. Screening answers are sensitive: protect `data/`, and check whether HIPAA obligations apply to your sponsor. This is not legal advice.
