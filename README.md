# Pixel Discord Bot

Pixel is a Discord bot for IEEE CS BAU.

Current MVP:
- Slash command to post a styled Top 10 leaderboard.
- Target either main or test channel.
- Post now or schedule for a specific datetime.
- Old-style IEEE CS look with richer markdown text and optional bottom logo image.
- Autonomous meme drop: randomly posts one local meme every 24-48 hours.

## 1) Setup

1. Install dependencies:

```bash
npm install
```

2. Copy env template and fill values:

```bash
copy .env.example .env
```

3. In Discord Developer Portal:
- Enable `MESSAGE CONTENT INTENT` is not required for this MVP.
- Invite the bot to your server with `applications.commands` and `bot` scopes.

## 2) Run

Development:

```bash
npm run dev
```

Production:

```bash
npm start
```

When bot starts, it auto-registers slash commands for the guild in `GUILD_ID`.

## 3) Command Usage

Use slash command:

`/post-leaderboard`

Parameters:
- `members` (required): comma/newline-separated names, up to 10.
- `target` (required): `main` or `test`.
- `post_mode` (required): `now` or `schedule`.
- `schedule_at` (optional): required when `post_mode = schedule`, format `YYYY-MM-DDTHH:mm:ss`.
- `title` (optional): custom leaderboard title.
- `period` (required): `week` or `month`.
- `role_to_ping` (optional): choose a role to ping.
- `ping_role` (optional): ping selected role (or `DEFAULT_MEMBER_ROLE_ID`).
- `ping_members` (optional): ping users if `members` contains mentions like `<@123...>` or raw user IDs.

Examples for `members`:
- `Ahmad, Sara, Omar, Lina`
- `Ahmad\nSara\nOmar\nLina`
- `<@123456789012345678>, <@987654321098765432>, Lina`

## Notes

- Scheduled jobs are in-memory for now. If bot restarts, pending scheduled posts are lost.
- Maximum scheduling delay is about 24 days due to JavaScript timer limits.
- Set `CS_LOGO_URL` in `.env` to show the IEEE CS logo at the bottom of the embed.
- `period=month` uses the premium style (gold accent, richer markdown, logo image if set).
- `period=week` uses a simpler and less flashy style, with logo as a small thumbnail if set.
- Each posted leaderboard gets default reactions: `🔥` and Pixel emoji `1465668039256047671`.
- Hype button reply is randomized from multiple hype messages.
- Hype button is limited to one press per user per leaderboard message.
- Hype presses are persisted in SQLite (`HYPE_DB_PATH`) so restart does not reset limits.
- Meme drop runs automatically after bot startup with no user command.
- Meme drop picks one random image from `MEME_DROP_FOLDER` and posts it to `MEME_DROP_CHANNEL_ID` (or `MAIN_CHANNEL_ID` if meme channel is unset).
- Meme drop delay is randomized between 24 and 48 hours for each cycle.
- Supported meme file types: `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp`.
- If meme folder is missing/empty, Pixel logs an internal error and skips that cycle.
