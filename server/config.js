const env = process.env;

function num(name, fallback) {
  const v = env[name];
  return v == null || v === '' ? fallback : Number(v);
}

export const config = {
  port: num('PORT', 3000),
  databaseUrl: env.DATABASE_URL || 'postgres://teezy:teezy@localhost:54329/teezy',
  isProduction: env.NODE_ENV === 'production',

  buyerFeeRate: 0.05,                          // 5% buyer fee on top of the ticket price
  paymentWindowMs: num('PAYMENT_WINDOW_MS', 5 * 60 * 1000), // matched seats are reserved this long while the buyer pays
  matchDeadlineMs: num('MATCH_DEADLINE_MS', 5000), // max time a buyer waits on other checkouts before "try again"

  goodDealThreshold: num('GOOD_DEAL_THRESHOLD', 0.15), // "good deal" = at least 15% below market average
  salesWindowDays: num('SALES_WINDOW_DAYS', 30),       // "recent" sales for the market average
  minSalesForAverage: num('MIN_SALES_FOR_AVERAGE', 5), // below this, fall back to active listings

  alertCooldownMs: num('ALERT_COOLDOWN_MS', 30 * 60 * 1000), // min gap between two alerts for one desired-ticket entry
  pushProvider: env.PUSH_PROVIDER || 'dev',    // 'dev' (in-app banner over SSE) or 'expo'

  // Email sign-in
  emailProvider: env.EMAIL_PROVIDER || 'dev',  // 'dev' (code printed to the server log) or 'resend'
  emailFrom: env.EMAIL_FROM || 'Teezy <login@example.com>',
  resendApiKey: env.RESEND_API_KEY,
  loginCodeTtlMs: num('LOGIN_CODE_TTL_MS', 10 * 60 * 1000),  // a code works for 10 minutes
  loginCodeMaxAttempts: 5,                                   // wrong guesses before a code dies
  loginCodesPerHour: 5,                                      // codes sent per email per hour
  sessionTtlDays: num('SESSION_TTL_DAYS', 30),
};
