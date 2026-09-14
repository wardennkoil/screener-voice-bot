import twilio from "twilio";
import type { TwilioEnv } from "../config.js";
import type { Logger } from "../logger.js";
import { makeSessionToken } from "./signature.js";

export interface DialContact {
  contactId: string;
  phone: string;
  firstName: string;
  attempt: number;
}

export interface DialerOptions {
  record: boolean;
  /** Seconds to let the phone ring before giving up. */
  ringTimeoutSeconds?: number;
}

/** The slice of the Twilio client the dialer uses; tests stub it. */
export interface CallsClient {
  calls: {
    create(params: Record<string, unknown>): Promise<{ sid: string }>;
    (sid: string): { update(params: Record<string, unknown>): Promise<unknown> };
  };
}

export interface DialResult {
  callSid: string;
  /**
   * Which parameter tier Twilio accepted. Probing a trial account (Sept 2026) showed it
   * rejects Method, Timeout, MachineDetection/AsyncAmd, Record and inline Twiml, but
   * allows Url (with a query string), StatusCallback and StatusCallbackEvent.
   */
  tier: "full" | "trial_safe" | "bare";
}

const TRIAL_RESTRICTION = /trial accounts have limited parameter access|disallowed parameters/i;

export class Dialer {
  private readonly client: CallsClient;
  private readonly base: string;
  /** Remembered after the first fallback so later calls skip the rejected tier. */
  private tier: DialResult["tier"] = "full";

  constructor(
    private readonly env: TwilioEnv,
    private readonly opts: DialerOptions,
    private readonly log: Logger,
    client?: CallsClient,
  ) {
    this.client = client ?? (twilio(env.accountSid, env.authToken) as unknown as CallsClient);
    this.base = `https://${env.publicHost}`;
  }

  private paramsFor(tier: DialResult["tier"], contact: DialContact, token: string): Record<string, unknown> {
    const q = `?token=${encodeURIComponent(token)}`;
    // Twilio's defaults are POST for the TwiML fetch and 60 s of ringing.
    const bare: Record<string, unknown> = {
      to: contact.phone,
      from: this.env.fromNumber,
      url: `${this.base}/twiml/screener${q}`,
    };
    if (tier === "bare") return bare;
    const trialSafe: Record<string, unknown> = {
      ...bare,
      statusCallback: `${this.base}/twilio/status${q}`,
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    };
    if (tier === "trial_safe") return trialSafe;
    return {
      ...trialSafe,
      method: "POST",
      statusCallbackMethod: "POST",
      timeout: this.opts.ringTimeoutSeconds ?? 25,
      machineDetection: "DetectMessageEnd",
      asyncAmd: "true",
      asyncAmdStatusCallback: `${this.base}/twilio/amd${q}`,
      asyncAmdStatusCallbackMethod: "POST",
      ...(this.opts.record
        ? {
            record: true,
            recordingChannels: "dual",
            recordingStatusCallback: `${this.base}/twilio/recording${q}`,
            recordingStatusCallbackMethod: "POST",
            recordingStatusCallbackEvent: ["in-progress", "completed"],
          }
        : {}),
    };
  }

  /**
   * Places the outbound call. Twilio fetches TwiML from our server once the
   * person answers. Trial accounts reject some parameters (answering-machine
   * detection, recording); on that specific error the call is retried with a
   * smaller parameter set so a test call still goes through.
   */
  async dial(contact: DialContact): Promise<DialResult> {
    const token = makeSessionToken(this.env.sessionTokenSecret, contact);
    const tiers: DialResult["tier"][] = ["full", "trial_safe", "bare"];
    for (const tier of tiers.slice(tiers.indexOf(this.tier))) {
      try {
        const call = await this.client.calls.create(this.paramsFor(tier, contact, token));
        if (tier !== "full") {
          this.log.warn({ tier }, "Twilio accepted the call only without answering-machine detection, recording and ring timeout" + (tier === "bare" ? ", and without status callbacks" : "") + " (trial account limits)");
        }
        this.tier = tier;
        this.log.info({ callSid: call.sid, to: contact.phone, contactId: contact.contactId, tier }, "call placed");
        return { callSid: call.sid, tier };
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        const next = tiers[tiers.indexOf(tier) + 1];
        if (next && TRIAL_RESTRICTION.test(message)) {
          this.log.warn({ tier, next, message }, "Twilio rejected call parameters; retrying with fewer");
          continue;
        }
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  /** Replaces the live call's TwiML (ends the ConversationRelay session) with a voicemail message, then hangs up. */
  async leaveVoicemail(callSid: string, twiml: string): Promise<void> {
    await this.client.calls(callSid).update({ twiml });
  }

  async hangup(callSid: string): Promise<void> {
    await this.client.calls(callSid).update({ status: "completed" });
  }
}
