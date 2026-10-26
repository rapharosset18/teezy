// Passwordless sign-in: we email a 6-digit code, the person types it in, they get a
// session cookie. Any email address is accepted; the code only proves inbox ownership.
import crypto from 'node:crypto';
import { config } from '../config.js';
import { query, withTransaction } from '../db.js';
import { AppError, badRequest } from '../errors.js';
import { sendEmail } from './email.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function normalizeEmail(email) {
  const e = String(email ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 254) throw badRequest('enter a valid email address');
  return e;
}

function codeHash(email, code) {
  return sha256(`${email}:${code}`);
}

// Returns the code only when the caller may show it (dev, so the demo works without email).
export async function startEmailLogin(rawEmail) {
  const email = normalizeEmail(rawEmail);
  const { rows: [recent] } = await query(
    `SELECT count(*)::int AS n FROM email_login_codes WHERE email = $1 AND created_at > now() - interval '1 hour'`,
    [email],
  );
  if (recent.n >= config.loginCodesPerHour) {
    throw new AppError(429, 'too_many_codes', 'Too many codes sent to this email. Try again in an hour.');
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await query(
    `INSERT INTO email_login_codes (email, code_hash, expires_at)
     VALUES ($1, $2, clock_timestamp() + $3 * interval '1 millisecond')`,
    [email, codeHash(email, code), config.loginCodeTtlMs],
  );
  await sendEmail({
    to: email,
    subject: `Your Teezy code: ${code}`,
    text: `Your Teezy sign-in code is ${code}. It expires in ${Math.round(config.loginCodeTtlMs / 60000)} minutes.\n\nIf you didn't ask for it, you can ignore this email.`,
  });
  return { email, devCode: config.emailProvider === 'dev' && !config.isProduction ? code : undefined };
}

function newUserId() {
  return 'u_' + crypto.randomBytes(9).toString('base64url');
}

function displayNameFrom(email) {
  const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : 'New member';
}

const invalidCode = () => new AppError(400, 'invalid_code', 'That code is wrong or has expired. Request a new one.');

export async function verifyEmailLogin(rawEmail, rawCode) {
  const email = normalizeEmail(rawEmail);
  const code = String(rawCode ?? '').trim();
  if (!/^\d{6}$/.test(code)) throw invalidCode();

  const result = await withTransaction(async (client) => {
    const { rows: [row] } = await client.query(
      `SELECT * FROM email_login_codes
       WHERE email = $1 AND consumed_at IS NULL AND expires_at > clock_timestamp()
       ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [email],
    );
    if (!row || row.attempts >= config.loginCodeMaxAttempts) return null;

    const ok = crypto.timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(codeHash(email, code), 'hex'));
    if (!ok) {
      // Commit the miss (no throw inside the transaction), so guesses are really counted.
      await client.query('UPDATE email_login_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return null;
    }

    await client.query(
      'UPDATE email_login_codes SET consumed_at = clock_timestamp() WHERE email = $1 AND consumed_at IS NULL',
      [email],
    );
    const { rows: [user] } = await client.query(
      `INSERT INTO users (id, display_name, email, email_verified_at)
       VALUES ($1, $2, $3, clock_timestamp())
       ON CONFLICT (email) DO UPDATE SET email_verified_at = coalesce(users.email_verified_at, clock_timestamp())
       RETURNING *`,
      [newUserId(), displayNameFrom(email), email],
    );
    const token = crypto.randomBytes(32).toString('base64url');
    await client.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, clock_timestamp() + $3 * interval '1 day')`,
      [sha256(token), user.id, config.sessionTtlDays],
    );
    return { token, user: { id: user.id, displayName: user.display_name, email: user.email } };
  });
  if (!result) throw invalidCode();
  return result;
}

export async function userIdForSession(token) {
  if (!token) return null;
  const { rows: [s] } = await query(
    'SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()',
    [sha256(token)],
  );
  return s ? s.user_id : null;
}

export async function endSession(token) {
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}
