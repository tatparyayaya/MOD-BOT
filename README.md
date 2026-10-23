# Discord Auto-Delete Bot

Deletes messages in individually configured Discord text channels after a delay, using one persisted deadline per message. Settings and pending deletions survive restarts via SQLite.

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite` and `process.loadEnvFile`; the start/test scripts pass `--experimental-sqlite` for older 22.x releases)
- A Discord application and bot token

## Setup

1. Create a bot at https://discord.com/developers/applications and copy its token.
2. Invite it with the **View Channels**, **Send Messages**, **Embed Links**, **Read Message History**, and **Manage Messages** permissions. Permission integer: `93184`.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` and `CLIENT_ID`.
5. Register the slash commands:

   ```bash
   npm run deploy
   ```

   Set `GUILD_ID` in `.env` for instant guild-only registration while testing. Global commands can take up to an hour to appear. The running bot also registers guild commands automatically when it joins a server and on startup, so commands are available immediately in joined servers.

6. Start the bot:

   ```bash
   npm start
   ```

## Commands

All commands require the Manage Server permission, the guild owner, or a user/role listed in `AUTHORIZED_USER_IDS` / `AUTHORIZED_ROLE_IDS`.

- `/autodelete setup` — select a text channel and delay (preset or custom seconds), review, and confirm.
- `/autodelete on [channel]` — resume saved settings for one channel, or all configured channels.
- `/autodelete off [channel]` — pause one or all channels. Queued deletions are cancelled; no message is deleted by the command.
- `/autodelete status` — show each configured channel, state, delay, and pending job count.
- `/autodelete remove channel:<channel>` — delete that channel's configuration and queued jobs.

## Behavior

- Every eligible message gets its own persisted deletion deadline. One internal scheduler processes due jobs in batches, so no per-message timers are left unmanaged.
- Bot messages are excluded by default. Only configured text channels are ever touched.
- Deletion is permanent and only applies to messages sent while auto-delete is enabled (plus recent messages missed during downtime).
- `OFF` clears pending jobs for the affected channel without deleting messages. `ON` schedules only new messages from that point on.
- Pending jobs with overdue deadlines are retried after restart. The bot also scans up to 500 recent messages per enabled channel for messages received during downtime, limited by its last-known checkpoint.
- Missing permissions, rate limits, and API errors are retried with backoff; unknown messages/channels are dropped from the queue.

## Data

The SQLite database defaults to `data/autodelete.sqlite` (override with `DB_PATH`). It is git-ignored.

## Tests

```bash
npm test
```

The tests cover database persistence, OFF clearing jobs, scheduler deletion/error handling, downtime recovery, and slash-command structure.
