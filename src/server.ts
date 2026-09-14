import { buildApp } from "./app.js";
import { env, requireTwilio, type TwilioEnv } from "./config.js";
import { createLlm, describeLlm } from "./conversation/llm-factory.js";
import { checkElevenLabsVoice } from "./local/elevenlabs-voices.js";
import { parseElevenLabsVoiceSpec } from "./local/voice-spec.js";
import { logger } from "./logger.js";
import { loadQuestionnaire } from "./screening/loader.js";
import { Dialer } from "./telephony/dialer.js";
import twilioSdk from "twilio";

async function fetchAccountType(accountSid: string, authToken: string): Promise<string | undefined> {
  try {
    const account = await twilioSdk(accountSid, authToken).api.v2010.accounts(accountSid).fetch();
    return account.type;
  } catch (err) {
    logger.warn({ err }, "could not read the Twilio account type");
    return undefined;
  }
}

async function main(): Promise<void> {
  const e = env();
  const questionnaire = await loadQuestionnaire(e.QUESTIONNAIRE_PATH);
  const llm = createLlm(e, logger);
  const llmChoice = describeLlm(e);

  let twilio: TwilioEnv | undefined;
  try {
    twilio = requireTwilio();
  } catch (err) {
    logger.warn({ reason: (err as Error).message }, "phone path disabled");
  }
  const dialer = twilio ? new Dialer(twilio, { record: e.RECORD_CALLS }, logger) : undefined;
  const twilioAccountType = twilio ? await fetchAccountType(twilio.accountSid, twilio.authToken) : undefined;
  if (twilioAccountType === "Trial") {
    logger.warn(
      "Twilio account is a TRIAL account: Twilio blocks ConversationRelay (and answering-machine detection, recording, verification calls) on trials. " +
        "Calls will be refused until the account is upgraded; set ALLOW_TRIAL_CALLS=true to try anyway.",
    );
  }

  let local: Parameters<typeof buildApp>[0]["local"];
  if (e.DEEPGRAM_API_KEY && e.ELEVENLABS_API_KEY) {
    const voice = parseElevenLabsVoiceSpec(e.ELEVENLABS_VOICE, { modelId: e.ELEVENLABS_MODEL_ID });
    if (e.ELEVENLABS_VOICE_ID) voice.voiceId = e.ELEVENLABS_VOICE_ID;
    if (e.ELEVENLABS_MODEL_ID) voice.modelId = e.ELEVENLABS_MODEL_ID;
    local = {
      deepgramApiKey: e.DEEPGRAM_API_KEY,
      elevenLabsApiKey: e.ELEVENLABS_API_KEY,
      voice,
      sampleRate: e.LOCAL_SAMPLE_RATE,
      eotThreshold: e.EOT_THRESHOLD,
      eagerEotThreshold: e.LOCAL_EAGER_EOT_THRESHOLD,
      csvPath: e.LOCAL_OUTPUT_CSV,
      transcriptsDir: e.TRANSCRIPTS_DIR,
    };
    void checkElevenLabsVoice(e.ELEVENLABS_API_KEY, voice.voiceId, logger);
  } else {
    logger.warn("laptop voice mode disabled (set DEEPGRAM_API_KEY and ELEVENLABS_API_KEY to enable /local)");
  }

  const app = await buildApp({
    questionnaire,
    llm,
    twilio,
    dialer,
    local,
    voice: { elevenLabsVoice: e.ELEVENLABS_VOICE, eotThreshold: e.EOT_THRESHOLD, interruptSensitivity: e.INTERRUPT_SENSITIVITY },
    recordingEnabled: e.RECORD_CALLS,
    csvPath: e.OUTPUT_CSV,
    transcriptsDir: e.TRANSCRIPTS_DIR,
    log: logger,
    skipSignatureCheck: process.env.SKIP_TWILIO_SIGNATURE_CHECK === "true",
    twilioAccountType,
    allowTrialCalls: e.ALLOW_TRIAL_CALLS,
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    const active = app.callRegistry.list().filter((c) => c.session && !c.finalized);
    logger.info({ signal, activeCalls: active.length }, "shutting down; saving partial results for active calls");
    // Persist what we have before the sockets drop, so a hard stop never loses answers.
    await Promise.allSettled(active.map((c) => c.session!.finalize()));
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ port: e.PORT, host: "0.0.0.0" });
  logger.info(
    {
      port: e.PORT,
      llm: `${llmChoice.provider}:${llmChoice.model}`,
      phone: twilio ? `enabled via ${twilio.publicHost} (account ${twilioAccountType ?? "unknown"})` : "disabled",
      local: local ? `http://localhost:${e.PORT}/local` : "disabled",
      voice: `${local?.voice.voiceId ?? e.ELEVENLABS_VOICE} ${local?.voice.modelId ?? ""}`.trim(),
      eotThreshold: e.EOT_THRESHOLD,
      csv: e.OUTPUT_CSV,
    },
    "screener server ready",
  );
}

main().catch((err) => {
  logger.error({ err }, "fatal");
  process.exit(1);
});
