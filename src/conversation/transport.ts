/**
 * The channel through which the assistant's words reach the person.
 * Twilio ConversationRelay is the production transport; the console and
 * simulated transports drive the identical engine for prompt iteration and tests.
 */
export interface Transport {
  /** Stream a piece of assistant speech. `last` closes the assistant turn. */
  sendText(token: string, last: boolean): void;
  /** Ask the transport to end the session (hang up / return control to Twilio). */
  end(handoffData?: Record<string, unknown>): void;
  /** Optional: play a pre-recorded clip (URL) instead of synthesizing. */
  play?(url: string): void;
}

/** Events the session receives from the person's side. */
export interface InboundEvents {
  onPrompt(text: string, last: boolean): void;
  onInterrupt(utteranceUntilInterrupt: string, durationMs?: number): void;
  onDtmf(digit: string): void;
  onTokensPlayed?(data: unknown): void;
  onError(description: string): void;
  onClose(): void;
}
