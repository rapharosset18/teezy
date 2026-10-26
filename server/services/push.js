// Push delivery. Every notification is stored first (the in-app record), then sent.
//   dev:  over the realtime stream to the open web demo, shown as the push banner.
//   expo: Expo's push API, which delivers to both APNs (iOS) and FCM (Android) tokens.
import { config } from '../config.js';
import { query, notify } from '../db.js';

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';

const transports = {
  async dev(notification) {
    await notify({ query }, { type: 'notification', userId: notification.userId, notification });
  },
  async expo(notification) {
    const { rows } = await query('SELECT token FROM push_tokens WHERE user_id = $1', [notification.userId]);
    if (!rows.length) return;
    const messages = rows.map((r) => ({
      to: r.token,
      title: notification.title,
      body: notification.body,
      data: { deepLink: notification.deepLink, ...notification.data },
    }));
    const res = await fetch(EXPO_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!res.ok) throw new Error(`expo push failed: ${res.status}`);
  },
};

export async function sendPush(notification) {
  const transport = transports[config.pushProvider];
  if (!transport) throw new Error(`unknown PUSH_PROVIDER ${config.pushProvider}`);
  await transport(notification);
}

export async function registerPushToken(userId, { token, platform }) {
  await query(
    `INSERT INTO push_tokens (user_id, token, platform) VALUES ($1, $2, $3)
     ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, last_seen_at = now()`,
    [userId, token, platform],
  );
}

export async function listNotifications(userId) {
  const { rows } = await query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
    [userId],
  );
  return rows.map(notificationDto);
}

export function notificationDto(r) {
  return {
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    title: r.title,
    body: r.body,
    deepLink: r.deep_link,
    data: r.data,
    createdAt: r.created_at,
    readAt: r.read_at,
  };
}
