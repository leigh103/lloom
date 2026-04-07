import pkg from '@slack/bolt';
const { App } = pkg;
import { askMildred } from '../agent.js';
import 'dotenv/config';

export function startSlack() {
  if (!process.env.SLACK_BOT_TOKEN) {
  //  console.log('ℹ️  Slack not configured (no SLACK_BOT_TOKEN) — skipping');
    return;
  }

  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    socketMode: true,
    appToken: process.env.SLACK_APP_TOKEN,
  });

  // Respond to direct messages
  app.message(async ({ message, say }) => {
    if (message.bot_id) return; // ignore other bots

    try {
      await say({ text: '_Thinking..._' });
      const reply = await askMildred(message.text || '');
      await say({ text: reply });
    } catch (err) {
      await say({ text: `Sorry, something went wrong: ${err.message}` });
    }
  });

  // Respond to @mentions in channels
  app.event('app_mention', async ({ event, say }) => {
    // Strip the mention from the message
    const text = event.text.replace(/<@[^>]+>/g, '').trim();
    if (!text) return;

    try {
      await say({ text: '_Thinking..._', thread_ts: event.ts });
      const reply = await askMildred(text);
      await say({ text: reply, thread_ts: event.ts });
    } catch (err) {
      await say({ text: `Sorry, something went wrong: ${err.message}`, thread_ts: event.ts });
    }
  });

  app.start().then(() => {
    console.log('✅ Slack bot connected (socket mode)');
  }).catch(err => {
    console.error('❌ Slack failed to start:', err.message);
  });
}
