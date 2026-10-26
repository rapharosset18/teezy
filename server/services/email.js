// Email delivery.
//   dev:    prints the message to the server log (and nothing leaves the machine).
//   resend: Resend's API (RESEND_API_KEY, EMAIL_FROM on a domain you've verified there).
import { config } from '../config.js';

const transports = {
  async dev(message) {
    console.log(`[email] to ${message.to}: ${message.subject}\n${message.text}`);
  },
  async resend(message) {
    if (!config.resendApiKey) throw new Error('RESEND_API_KEY is not set');
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${config.resendApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.emailFrom, to: message.to, subject: message.subject, text: message.text }),
    });
    if (!res.ok) throw new Error(`resend failed: ${res.status}`);
  },
};

export async function sendEmail(message) {
  const transport = transports[config.emailProvider];
  if (!transport) throw new Error(`unknown EMAIL_PROVIDER ${config.emailProvider}`);
  await transport(message);
}
