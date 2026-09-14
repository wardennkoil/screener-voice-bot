import twilio from "twilio";
import { requireTwilio } from "../config.js";

/**
 * Trial Twilio accounts can only call numbers listed under Verified Caller IDs.
 * This starts Twilio's verification: it prints a 6-digit code, then Twilio calls
 * the number and asks for that code on the keypad. Usage: npm run verify-number -- +16475550123
 */
async function main(): Promise<void> {
  const phone = process.argv[2];
  if (!phone || !/^\+\d{8,15}$/.test(phone)) {
    console.error("Usage: npm run verify-number -- +16475550123   (E.164 format)");
    process.exit(2);
  }
  const t = requireTwilio();
  const client = twilio(t.accountSid, t.authToken);
  const existing = await client.outgoingCallerIds.list({ phoneNumber: phone, limit: 1 });
  if (existing.length > 0) {
    console.log(`${phone} is already a verified caller ID (${existing[0]!.friendlyName}). You can dial it.`);
    return;
  }
  const req = await client.validationRequests.create({ phoneNumber: phone, friendlyName: `screener test ${phone}`, callDelay: 5 });
  console.log(`Twilio will call ${phone} in a few seconds.`);
  console.log(`When it asks, enter this code on your keypad:  ${req.validationCode}`);
  console.log("After that, run the dial command again.");
}

main().catch((err) => {
  const message = (err as Error).message;
  console.error(message);
  if (/trial account/i.test(message)) {
    console.error(`
Trial accounts can only verify numbers by text message, and only from the Console:
  1. https://console.twilio.com/ -> Phone Numbers -> Manage -> Verified Caller IDs
  2. Add a new Caller ID -> enter ${process.argv[2]} -> verification method: Text message
  3. Enter the code from the SMS. Then run the dial command again.
Upgrading the account (adding a payment method) removes this limit, the trial announcement,
and the parameter restrictions on answering-machine detection and recording.`);
  }
  process.exit(1);
});
