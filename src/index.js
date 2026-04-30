require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");

const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const requiredEnv = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);

if (missingEnv.length > 0) {
  console.error(`Missing required env vars: ${missingEnv.join(", ")}`);
  process.exit(1);
}

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const MAIN_CHANNEL_ID = process.env.MAIN_CHANNEL_ID || "";
const TEST_CHANNEL_ID = process.env.TEST_CHANNEL_ID || "";
const TIMEZONE = process.env.TIMEZONE || "Asia/Amman";
const LEADERBOARD_LINK = process.env.LEADERBOARD_LINK || "";
const HYPE_DB_PATH = process.env.HYPE_DB_PATH || "data/pixel.sqlite";
const MEME_DROP_CHANNEL_ID = process.env.MEME_DROP_CHANNEL_ID || MAIN_CHANNEL_ID;
const MEME_DROP_FOLDER = process.env.MEME_DROP_FOLDER || "data/memes";
const PIXEL_SUPABASE_BUCKET_ACCESS_KEY =
  process.env.PIXEL_SUPABASE_BUCKET_ACCESS_KEY || "";
const PIXEL_SUPABASE_BUCKET_SECRET_KEY =
  process.env.PIXEL_SUPABASE_BUCKET_SECRET_KEY ||
  process.env.PIXEL_SUPABASE_BUCKET_SECERT_KEY ||
  "";
const PIXEL_SUPABASE_BUCKET_NAME = process.env.PIXEL_SUPABASE_BUCKET_NAME || "";
const PIXEL_SUPABASE_PROJECT_REF = process.env.PIXEL_SUPABASE_PROJECT_REF || "";
const PIXEL_SUPABASE_S3_REGION =
  process.env.PIXEL_SUPABASE_S3_REGION || "us-east-1";
const PIXEL_SUPABASE_S3_ENDPOINT =
  process.env.PIXEL_SUPABASE_S3_ENDPOINT ||
  (PIXEL_SUPABASE_PROJECT_REF
    ? `https://${PIXEL_SUPABASE_PROJECT_REF}.supabase.co/storage/v1/s3`
    : "");
const PIXEL_SUPABASE_MEME_PREFIX =
  process.env.PIXEL_SUPABASE_MEME_PREFIX || "";
const CS_LOGO_URL = (process.env.CS_LOGO_URL || "")
  .trim()
  .replace(/^"(.*)"$/, "$1")
  .replace(/^'(.*)'$/, "$1");
const PIXEL_EMOJI_ID = "1465668039256047671";
const DEFAULT_MEMBER_ROLE_ID =
  process.env.DEFAULT_MEMBER_ROLE_ID || "1465118775715168473";


const MAX_TIMEOUT_MS = 2147483647;
const MIN_MEME_DROP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_MEME_DROP_INTERVAL_MS = 48 * 60 * 60 * 1000;
const MEME_DROP_COUNT = 3;
const scheduledJobs = new Map();
const HYPE_MESSAGES = [
  "Top of the leaderboard let’s go! 🔥",
  "Champions again! Keep it up 💪",
  "You crushed it well deserved 👏",
  "Leading the way! 🚀",
  "On fire this week 🔥",
  "Big win keep pushing 🎯",
  "Staying on top like pros 💯",
  "Let’s go team! Amazing job 🚀",
];
const SUPPORTED_MEME_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
]);
let memeDropLoopEnabled = true;
let memeDropTimeout = null;
let nextMemeDropAt = null;

const absoluteDbPath = path.isAbsolute(HYPE_DB_PATH)
  ? HYPE_DB_PATH
  : path.join(process.cwd(), HYPE_DB_PATH);

fs.mkdirSync(path.dirname(absoluteDbPath), { recursive: true });

const db = new Database(absoluteDbPath);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS hype_presses (
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    pressed_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (message_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS meme_drop_history (
    source_scope TEXT NOT NULL,
    meme_key TEXT NOT NULL,
    posted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (source_scope, meme_key)
  );
`);

const insertHypePressStmt = db.prepare(`
  INSERT OR IGNORE INTO hype_presses (message_id, user_id)
  VALUES (?, ?)
`);

const countHypePressesStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM hype_presses
  WHERE message_id = ?
`);

const getPostedMemeKeysStmt = db.prepare(`
  SELECT meme_key FROM meme_drop_history
  WHERE source_scope = ?
`);

const insertPostedMemeStmt = db.prepare(`
  INSERT OR IGNORE INTO meme_drop_history (source_scope, meme_key)
  VALUES (?, ?)
`);

const resetPostedMemesStmt = db.prepare(`
  DELETE FROM meme_drop_history
  WHERE source_scope = ?
`);

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const leaderboardCommand = new SlashCommandBuilder()
  .setName("post-leaderboard")
  .setDescription("Post Pixel's styled top-members leaderboard")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption((option) =>
    option
      .setName("members")
      .setDescription("Top members list (comma or newline separated, max 10)")
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName("target")
      .setDescription("Where to post")
      .setRequired(true)
      .addChoices(
        { name: "Main channel", value: "main" },
        { name: "Test channel", value: "test" }
      )
  )
  .addStringOption((option) =>
    option
      .setName("post_mode")
      .setDescription("Post now or schedule")
      .setRequired(true)
      .addChoices(
        { name: "Post now", value: "now" },
        { name: "Schedule", value: "schedule" }
      )
  )
  .addStringOption((option) =>
    option
      .setName("period")
      .setDescription("Leaderboard period style")
      .setRequired(true)
      .addChoices(
        { name: "Week", value: "week" },
        { name: "Month", value: "month" }
      )
  )
  .addStringOption((option) =>
    option
      .setName("schedule_at")
      .setDescription("Required if post_mode=schedule, format: 2026-03-19T18:30:00")
      .setRequired(false)
  )
  .addStringOption((option) =>
    option
      .setName("title")
      .setDescription("Optional leaderboard title")
      .setMaxLength(100)
      .setRequired(false)
  )
  .addRoleOption((option) =>
    option
      .setName("role_to_ping")
      .setDescription("Optional role to ping (defaults to CS Member role)")
      .setRequired(false)
  )
  .addBooleanOption((option) =>
    option
      .setName("ping_role")
      .setDescription("Ping the selected role (or default CS Member role)")
      .setRequired(false)
  )
  .addBooleanOption((option) =>
    option
      .setName("ping_members")
      .setDescription("Ping users if members list includes mentions or user IDs")
      .setRequired(false)
  );

const reactMessageCommand = new SlashCommandBuilder()
  .setName("react-message")
  .setDescription("Make Pixel react to any message with a chosen emoji (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addStringOption((option) =>
    option
      .setName("channel_id")
      .setDescription("ID of the channel that contains the message")
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName("message_id")
      .setDescription("ID of the message to react to")
      .setRequired(true)
  )
  .addStringOption((option) =>
    option
      .setName("emoji")
      .setDescription("Emoji to react with (e.g. 👍, ❤️, or a custom server emoji like <:name:id>)")
      .setRequired(true)
  );

const memeDropCommand = new SlashCommandBuilder()
  .setName("meme-drop")
  .setDescription("Control Pixel's automatic meme drop")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("start")
      .setDescription("Enable automatic meme drops")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("stop")
      .setDescription("Disable automatic meme drops")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("status")
      .setDescription("Show meme drop loop status")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("now")
      .setDescription("Post memes immediately")
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("schedule-next")
      .setDescription("Override the next drop time")
      .addStringOption((option) =>
        option
          .setName("day")
          .setDescription("Choose whether the override is for today or tomorrow")
          .setRequired(true)
          .addChoices(
            { name: "Today", value: "today" },
            { name: "Tomorrow", value: "tomorrow" }
          )
      )
      .addStringOption((option) =>
        option
          .setName("time")
          .setDescription(`Time in HH:mm format (uses ${TIMEZONE} timezone, e.g. 18:30)`)
          .setRequired(true)
      )
  );

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [
      leaderboardCommand.toJSON(),
      memeDropCommand.toJSON(),
      reactMessageCommand.toJSON(),
    ],
  });

  console.log("Slash commands registered for the guild.");
}

function parseMembers(rawMembers) {
  const members = rawMembers
    .split(/\n|,/) 
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 10);

  return members;
}

function medalFor(index) {
  if (index === 0) return "🥇";
  if (index === 1) return "🥈";
  if (index === 2) return "🥉";
  return "⭐";
}

function buildRankedMemberLines(members) {
  return members
    .map((name, index) => {
      if (index < 3) {
        return `${medalFor(index)} **${name}**`;
      }

      return `${index + 1}) ${name}`;
    })
    .join("\n");
}

function getRandomHypeMessage() {
  return HYPE_MESSAGES[Math.floor(Math.random() * HYPE_MESSAGES.length)];
}

function registerHypePress(messageId, userId) {
  const result = insertHypePressStmt.run(messageId, userId);
  return result.changes === 1;
}

function getHypeCount(messageId) {
  const row = countHypePressesStmt.get(messageId);
  return row?.count || 0;
}

async function addDefaultReactions(message) {
  try {
    await message.react("🔥");
  } catch (error) {
    console.warn("Could not add fire reaction:", error.message);
  }

  try {
    await message.react(PIXEL_EMOJI_ID);
  } catch (error) {
    console.warn("Could not add Pixel emoji reaction:", error.message);
  }
}

function extractUserIdFromToken(token) {
  const mentionMatch = token.match(/^<@!?(\d+)>$/);
  if (mentionMatch) {
    return mentionMatch[1];
  }

  const idMatch = token.match(/^(\d{17,20})$/);
  if (idMatch) {
    return idMatch[1];
  }

  return null;
}

function buildMentionPayload({ members, pingMembers, pingRoleId }) {
  const userIds = pingMembers
    ? [...new Set(members.map(extractUserIdFromToken).filter(Boolean))]
    : [];
  const roleIds = pingRoleId ? [pingRoleId] : [];

  if (userIds.length === 0 && roleIds.length === 0) {
    return {};
  }

  const contentParts = [];
  if (roleIds.length > 0) {
    contentParts.push(`<@&${roleIds[0]}>`);
  }

  if (userIds.length > 0) {
    contentParts.push(userIds.map((id) => `<@${id}>`).join(" "));
  }

  return {
    content: contentParts.join("\n"),
    allowedMentions: {
      parse: [],
      roles: roleIds,
      users: userIds,
      repliedUser: false,
    },
  };
}

function buildLeaderboardMessage({
  title,
  members,
  period,
  scheduledAt,
  pingRoleId,
  pingMembers,
}) {
  const isMonthly = period === "month";
  const titleText =
    title ||
    (isMonthly
      ? "🏆 CS TOP 10 BEST MEMBERS 🏆"
      : "✨ CS TOP MEMBERS OF THE WEEK ✨");
  const rankedLines = buildRankedMemberLines(members);
  const leadHeading = isMonthly
    ? "## **MONTHLY LEADERBOARD**"
    : "## **WEEKLY LEADERBOARD**";

  const descriptionParts = isMonthly
    ? [
        leadHeading,
        "",
        rankedLines,
        "",
        "🌟 **Member Of The Month - IEEE Computer Society** 🌟",
        "",
        "Proudly announcing this month\'s top member! 🏆",
        "Thank you for your outstanding dedication and impact on our community.",
        "Congratulations to our top members for your hard work and amazing impact. 👏",
        "Together, we continue to grow and succeed 🧡",
      ]
    : [
        leadHeading,
        "",
        rankedLines,
        "",
        "**Weekly leaderboard update by IEEE CS BAU**",
        "Congratulations to our top members for your hard work this week. 👏",
      ];

  const embed = new EmbedBuilder()
    .setColor(isMonthly ? 0xffb020 : 0x00b894)
    .setTitle(titleText)
    .setDescription(descriptionParts.join("\n"))
    .setFooter({ text: "Powered by Pixel" })
    .setTimestamp(new Date());

  if (CS_LOGO_URL) {
    if (isMonthly) {
      embed.setImage(CS_LOGO_URL);
    } else {
      embed.setThumbnail(CS_LOGO_URL);
    }
  }

  if (scheduledAt) {
    embed.addFields({
      name: "Scheduled",
      value: `<t:${Math.floor(scheduledAt.getTime() / 1000)}:F>`,
      inline: false,
    });
  }

  const buttons = [
    new ButtonBuilder()
      .setCustomId("pixel_leaderboard_hype")
      .setLabel("Hype Top Members")
      .setStyle(ButtonStyle.Success),
  ];

  if (LEADERBOARD_LINK) {
    buttons.push(
      new ButtonBuilder()
        .setLabel("Open Full Board")
        .setStyle(ButtonStyle.Link)
        .setURL(LEADERBOARD_LINK)
    );
  }

  const row = new ActionRowBuilder().addComponents(buttons);
  const mentionPayload = buildMentionPayload({
    members,
    pingMembers,
    pingRoleId,
  });

  return {
    ...mentionPayload,
    embeds: [embed],
    components: [row],
  };
}

async function getTargetChannel(target) {
  const channelId = target === "test" ? TEST_CHANNEL_ID : MAIN_CHANNEL_ID;
  if (!channelId) {
    throw new Error(
      `Missing channel id env var for ${target} target. ` +
        `Set ${target === "test" ? "TEST_CHANNEL_ID" : "MAIN_CHANNEL_ID"}.`
    );
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    throw new Error(`Configured ${target} channel is not a text channel.`);
  }

  return channel;
}

function parseScheduleDate(raw) {
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

function toAbsolutePath(targetPath) {
  return path.isAbsolute(targetPath)
    ? targetPath
    : path.join(process.cwd(), targetPath);
}

function pickRandom(items) {
  if (items.length === 0) {
    return null;
  }

  return items[Math.floor(Math.random() * items.length)];
}

function getPostedMemeKeySet(sourceScope) {
  const rows = getPostedMemeKeysStmt.all(sourceScope);
  return new Set(rows.map((row) => row.meme_key));
}

function markMemeAsPosted(sourceScope, memeKey) {
  insertPostedMemeStmt.run(sourceScope, memeKey);
}

function resetMemeCycle(sourceScope) {
  resetPostedMemesStmt.run(sourceScope);
}

function pickNextUniqueMeme(availableMemeKeys, sourceScope) {
  if (availableMemeKeys.length === 0) {
    return null;
  }

  const postedMemeKeys = getPostedMemeKeySet(sourceScope);
  let remainingMemeKeys = availableMemeKeys.filter(
    (memeKey) => !postedMemeKeys.has(memeKey)
  );

  if (remainingMemeKeys.length === 0) {
    resetMemeCycle(sourceScope);
    remainingMemeKeys = [...availableMemeKeys];
    console.log(`[MemeDrop] Meme cycle reset for source: ${sourceScope}`);
  }

  return pickRandom(remainingMemeKeys);
}

function getRandomMemeDropDelayMs() {
  const range = MAX_MEME_DROP_INTERVAL_MS - MIN_MEME_DROP_INTERVAL_MS;
  return MIN_MEME_DROP_INTERVAL_MS + Math.floor(Math.random() * (range + 1));
}

function getMemeFilesFromFolder(folderPath) {
  let entries;
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch (error) {
    console.error(
      `[MemeDrop] Could not read meme folder at ${folderPath}: ${error.message}`
    );
    return [];
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => SUPPORTED_MEME_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map((name) => path.join(folderPath, name));
}

function hasSupabaseMemeConfig() {
  return Boolean(
    PIXEL_SUPABASE_BUCKET_ACCESS_KEY &&
      PIXEL_SUPABASE_BUCKET_SECRET_KEY &&
      PIXEL_SUPABASE_BUCKET_NAME &&
      PIXEL_SUPABASE_S3_ENDPOINT
  );
}

function normalizePrefix(prefix) {
  return prefix.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function getSupabaseMemeSourceScope() {
  const prefix = normalizePrefix(PIXEL_SUPABASE_MEME_PREFIX) || "_root";
  return `supabase:${PIXEL_SUPABASE_BUCKET_NAME}:${prefix}`;
}

function getLocalMemeSourceScope(folderPath) {
  return `local:${folderPath}`;
}

function createSupabaseS3Client() {
  return new S3Client({
    region: PIXEL_SUPABASE_S3_REGION,
    endpoint: PIXEL_SUPABASE_S3_ENDPOINT,
    forcePathStyle: true,
    credentials: {
      accessKeyId: PIXEL_SUPABASE_BUCKET_ACCESS_KEY,
      secretAccessKey: PIXEL_SUPABASE_BUCKET_SECRET_KEY,
    },
  });
}

async function getMemeKeysFromSupabaseBucket(s3Client) {
  const prefix = normalizePrefix(PIXEL_SUPABASE_MEME_PREFIX);
  const listCommand = new ListObjectsV2Command({
    Bucket: PIXEL_SUPABASE_BUCKET_NAME,
    Prefix: prefix ? `${prefix}/` : undefined,
  });

  const response = await s3Client.send(listCommand);
  const contents = response.Contents || [];

  return contents
    .map((item) => item.Key)
    .filter(Boolean)
    .filter((key) => !key.endsWith("/"))
    .filter((key) =>
      SUPPORTED_MEME_EXTENSIONS.has(path.extname(key).toLowerCase())
    );
}

async function downloadMemeFromSupabase(s3Client, objectKey) {
  const command = new GetObjectCommand({
    Bucket: PIXEL_SUPABASE_BUCKET_NAME,
    Key: objectKey,
  });

  const response = await s3Client.send(command);
  if (!response.Body || typeof response.Body.transformToByteArray !== "function") {
    throw new Error("Could not read object body from Supabase S3 response.");
  }

  const bytes = await response.Body.transformToByteArray();
  return Buffer.from(bytes);
}

async function postRandomMemeDropFromSupabase(channel) {
  const s3Client = createSupabaseS3Client();
  const memeKeys = await getMemeKeysFromSupabaseBucket(s3Client);

  if (memeKeys.length === 0) {
    const prefix = normalizePrefix(PIXEL_SUPABASE_MEME_PREFIX);
    const prefixMessage = prefix ? ` with prefix "${prefix}/"` : "";
    console.error(
      `[MemeDrop] Supabase bucket has no supported images${prefixMessage}. Bucket: ${PIXEL_SUPABASE_BUCKET_NAME}`
    );
    return;
  }

  const sourceScope = getSupabaseMemeSourceScope();

  for (let i = 0; i < MEME_DROP_COUNT; i++) {
    const memeKey = pickNextUniqueMeme(memeKeys, sourceScope);
    if (!memeKey) break;

    const memeBuffer = await downloadMemeFromSupabase(s3Client, memeKey);
    const attachment = new AttachmentBuilder(memeBuffer, {
      name: path.basename(memeKey),
    });

    await channel.send({ files: [attachment] });
    markMemeAsPosted(sourceScope, memeKey);
    console.log(`[MemeDrop] Posted meme from Supabase: ${memeKey}`);
  }
}

async function handleReactMessage(interaction) {
  const channelId = interaction.options.getString("channel_id", true).trim();
  const messageId = interaction.options.getString("message_id", true).trim();
  const emoji = interaction.options.getString("emoji", true).trim();

  if (!/^\d{17,20}$/.test(channelId)) {
    await interaction.reply({
      content: "Invalid channel ID. It should be a numeric Discord snowflake.",
      ephemeral: true,
    });
    return;
  }

  if (!/^\d{17,20}$/.test(messageId)) {
    await interaction.reply({
      content: "Invalid message ID. It should be a numeric Discord snowflake.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply({
        content: "Could not find a text channel with that ID.",
      });
      return;
    }

    const message = await channel.messages.fetch(messageId);
    await message.react(emoji);

    await interaction.editReply({
      content: `Reacted with ${emoji} on the message!`,
    });
  } catch (error) {
    console.error("[ReactMessage] Failed to react:", error.message);
    await interaction.editReply({
      content:
        "Failed to react. Check that the channel ID, message ID, and emoji are all correct and that Pixel has permission to react in that channel.",
    });
  }
}

async function postRandomMemeDrop() {
  if (!MEME_DROP_CHANNEL_ID) {
    console.error(
      "[MemeDrop] MEME_DROP_CHANNEL_ID is not configured. Set it in .env."
    );
    return;
  }

  const channel = await client.channels.fetch(MEME_DROP_CHANNEL_ID);
  if (!channel || channel.type !== ChannelType.GuildText) {
    console.error("[MemeDrop] Configured meme drop channel is not a text channel.");
    return;
  }

  if (hasSupabaseMemeConfig()) {
    await postRandomMemeDropFromSupabase(channel);
    return;
  }

  const memeFolderPath = toAbsolutePath(MEME_DROP_FOLDER);
  const memeFiles = getMemeFilesFromFolder(memeFolderPath);

  if (memeFiles.length === 0) {
    console.error(
      `[MemeDrop] Meme folder is empty (or has no supported images): ${memeFolderPath}`
    );
    return;
  }

  const sourceScope = getLocalMemeSourceScope(memeFolderPath);

  for (let i = 0; i < MEME_DROP_COUNT; i++) {
    const memeFilePath = pickNextUniqueMeme(memeFiles, sourceScope);
    if (!memeFilePath) break;

    const attachment = new AttachmentBuilder(memeFilePath, {
      name: path.basename(memeFilePath),
    });

    await channel.send({ files: [attachment] });
    markMemeAsPosted(sourceScope, memeFilePath);
    console.log(`[MemeDrop] Posted meme: ${path.basename(memeFilePath)}`);
  }
}

function scheduleNextMemeDrop() {
  if (!memeDropLoopEnabled) {
    return;
  }

  if (memeDropTimeout) {
    clearTimeout(memeDropTimeout);
    memeDropTimeout = null;
  }

  const delayMs = getRandomMemeDropDelayMs();
  const hours = (delayMs / (60 * 60 * 1000)).toFixed(2);
  nextMemeDropAt = new Date(Date.now() + delayMs);

  console.log(`[MemeDrop] Next meme drop scheduled in ${hours} hours.`);

  memeDropTimeout = setTimeout(async () => {
    try {
      await postRandomMemeDrop();
    } catch (error) {
      console.error("[MemeDrop] Failed to post meme:", error);
    } finally {
      memeDropTimeout = null;
      nextMemeDropAt = null;
      scheduleNextMemeDrop();
    }
  }, delayMs);
}

function startMemeDropLoop() {
  memeDropLoopEnabled = true;

  console.log(
    `[MemeDrop] Autonomous meme drop loop started. Folder: ${toAbsolutePath(
      MEME_DROP_FOLDER
    )}`
  );
  scheduleNextMemeDrop();
}

function stopMemeDropLoop() {
  memeDropLoopEnabled = false;

  if (memeDropTimeout) {
    clearTimeout(memeDropTimeout);
    memeDropTimeout = null;
  }

  nextMemeDropAt = null;
  console.log("[MemeDrop] Autonomous meme drop loop stopped.");
}

function getTimezoneOffsetMs(timezone, date) {
  const utcDate = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  const tzDate = new Date(date.toLocaleString("en-US", { timeZone: timezone }));
  return tzDate - utcDate;
}

function overrideMemeDropTime(timeStr, day = "today") {
  // timeStr format: "HH:mm"
  if (!/^\d{2}:\d{2}$/.test(timeStr)) {
    return null;
  }

  const [hours, minutes] = timeStr.split(":").map(Number);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  if (day !== "today" && day !== "tomorrow") {
    return null;
  }

  const now = new Date();
  const offsetMs = getTimezoneOffsetMs(TIMEZONE, now);

  // Build today's date at HH:mm in the target timezone (as fake-UTC arithmetic)
  const localNow = new Date(now.getTime() + offsetMs);
  const target = new Date(localNow);
  target.setUTCHours(hours, minutes, 0, 0);

  if (day === "tomorrow") {
    target.setUTCDate(target.getUTCDate() + 1);
  } else if (target <= localNow) {
    // If the time has already passed today, use tomorrow
    target.setUTCDate(target.getUTCDate() + 1);
  }

  // Convert back to real UTC
  const targetUtc = new Date(target.getTime() - offsetMs);
  const delay = targetUtc.getTime() - now.getTime();

  if (memeDropTimeout) {
    clearTimeout(memeDropTimeout);
    memeDropTimeout = null;
  }

  nextMemeDropAt = targetUtc;

  memeDropTimeout = setTimeout(async () => {
    try {
      await postRandomMemeDrop();
    } catch (error) {
      console.error("[MemeDrop] Failed to post meme:", error);
    } finally {
      memeDropTimeout = null;
      nextMemeDropAt = null;
      scheduleNextMemeDrop();
    }
  }, delay);

  console.log(
    `[MemeDrop] Next drop overridden to ${day} at ${timeStr} (${TIMEZONE}).`
  );
  return targetUtc;
}

function formatMemeDropStatus() {
  const channelInfo = MEME_DROP_CHANNEL_ID
    ? `<#${MEME_DROP_CHANNEL_ID}>`
    : "Not configured";
  const usingSupabase = hasSupabaseMemeConfig();
  const sourceInfo = usingSupabase
    ? `Supabase bucket: ${PIXEL_SUPABASE_BUCKET_NAME}${
        PIXEL_SUPABASE_MEME_PREFIX
          ? ` (prefix: ${normalizePrefix(PIXEL_SUPABASE_MEME_PREFIX)}/)`
          : ""
      }`
    : `Local folder: ${toAbsolutePath(MEME_DROP_FOLDER)}`;
  const nextRun = nextMemeDropAt
    ? `<t:${Math.floor(nextMemeDropAt.getTime() / 1000)}:F>`
    : "Not scheduled";

  return [
    `Enabled: **${memeDropLoopEnabled ? "Yes" : "No"}**`,
    `Channel: ${channelInfo}`,
    `Source: ${sourceInfo}`,
    `Next drop: ${nextRun}`,
  ].join("\n");
}

async function handleMemeDropControl(interaction) {
  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === "status") {
    await interaction.reply({
      content: `Meme drop status:\n${formatMemeDropStatus()}`,
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "start") {
    if (memeDropLoopEnabled && memeDropTimeout) {
      await interaction.reply({
        content: `Meme drop loop is already running.\n${formatMemeDropStatus()}`,
        ephemeral: true,
      });
      return;
    }

    startMemeDropLoop();
    await interaction.reply({
      content: `Started automatic meme drops.\n${formatMemeDropStatus()}`,
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "stop") {
    if (!memeDropLoopEnabled) {
      await interaction.reply({
        content: "Meme drop loop is already stopped.",
        ephemeral: true,
      });
      return;
    }

    stopMemeDropLoop();
    await interaction.reply({
      content: "Stopped automatic meme drops.",
      ephemeral: true,
    });
    return;
  }

  if (subcommand === "now") {
    await interaction.deferReply({ ephemeral: true });
    await postRandomMemeDrop();
    await interaction.editReply({
      content: `Posted ${MEME_DROP_COUNT} memes now (if enough valid meme files were available).`,
    });
    return;
  }

  if (subcommand === "schedule-next") {
    const day = interaction.options.getString("day", true);
    const timeStr = interaction.options.getString("time", true).trim();
    const targetUtc = overrideMemeDropTime(timeStr, day);

    if (!targetUtc) {
      await interaction.reply({
        content: "Invalid schedule options. Use day = today/tomorrow and time in HH:mm format, e.g. 18:30.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content:
        `Next meme drop overridden to **${day}** at **${timeStr}** (${TIMEZONE}).\n` +
        `Scheduled for <t:${Math.floor(targetUtc.getTime() / 1000)}:F>.`,
      ephemeral: true,
    });
    return;
  }
}

async function postLeaderboard({
  target,
  title,
  members,
  period,
  scheduledAt,
  pingRoleId,
  pingMembers,
}) {
  const channel = await getTargetChannel(target);
  const payload = buildLeaderboardMessage({
    title,
    members,
    period,
    scheduledAt,
    pingRoleId,
    pingMembers,
  });
  const postedMessage = await channel.send(payload);
  await addDefaultReactions(postedMessage);
}

async function handlePostLeaderboard(interaction) {
  const rawMembers = interaction.options.getString("members", true);
  const postMode = interaction.options.getString("post_mode", true);
  const target = interaction.options.getString("target", true);
  const title = interaction.options.getString("title") || undefined;
  const period = interaction.options.getString("period", true);
  const scheduleAtRaw = interaction.options.getString("schedule_at");
  const selectedRole = interaction.options.getRole("role_to_ping");
  const pingRole = interaction.options.getBoolean("ping_role") ?? false;
  const pingMembers = interaction.options.getBoolean("ping_members") ?? false;
  const pingRoleId = pingRole
    ? selectedRole?.id || DEFAULT_MEMBER_ROLE_ID || null
    : null;

  const members = parseMembers(rawMembers);

  if (members.length === 0) {
    await interaction.reply({
      content: "Please provide at least 1 member name.",
      ephemeral: true,
    });
    return;
  }

  if (pingRole && !pingRoleId) {
    await interaction.reply({
      content:
        "Cannot ping role because no role was provided and DEFAULT_MEMBER_ROLE_ID is missing.",
      ephemeral: true,
    });
    return;
  }

  if (postMode === "now") {
    await postLeaderboard({
      target,
      title,
      members,
      period,
      pingRoleId,
      pingMembers,
    });
    await interaction.reply({
      content: `Posted leaderboard to **${target}** channel.`,
      ephemeral: true,
    });
    return;
  }

  if (!scheduleAtRaw) {
    await interaction.reply({
      content:
        "Please provide `schedule_at` when using schedule mode (e.g. 2026-03-19T18:30:00).",
      ephemeral: true,
    });
    return;
  }

  const scheduledAt = parseScheduleDate(scheduleAtRaw);
  if (!scheduledAt) {
    await interaction.reply({
      content: "Invalid `schedule_at` format. Use YYYY-MM-DDTHH:mm:ss.",
      ephemeral: true,
    });
    return;
  }

  const delay = scheduledAt.getTime() - Date.now();

  if (delay <= 0) {
    await interaction.reply({
      content: "Scheduled time must be in the future.",
      ephemeral: true,
    });
    return;
  }

  if (delay > MAX_TIMEOUT_MS) {
    await interaction.reply({
      content:
        "Scheduled time is too far away for in-memory scheduling (max ~24 days).",
      ephemeral: true,
    });
    return;
  }

  const jobId = `${interaction.id}-${Date.now()}`;
  const timeout = setTimeout(async () => {
    try {
      await postLeaderboard({
        target,
        title,
        members,
        period,
        scheduledAt,
        pingRoleId,
        pingMembers,
      });
      console.log(`Posted scheduled leaderboard job ${jobId}.`);
    } catch (error) {
      console.error(`Failed scheduled leaderboard job ${jobId}:`, error);
    } finally {
      scheduledJobs.delete(jobId);
    }
  }, delay);

  scheduledJobs.set(jobId, timeout);

  await interaction.reply({
    content:
      `Scheduled leaderboard for **${target}** channel at ` +
      `<t:${Math.floor(scheduledAt.getTime() / 1000)}:F> (${TIMEZONE}).`,
    ephemeral: true,
  });
}

client.once("ready", () => {
  console.log(`Pixel is online as ${client.user.tag}`);
  startMemeDropLoop();
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "post-leaderboard") {
        await handlePostLeaderboard(interaction);
      } else if (interaction.commandName === "meme-drop") {
        await handleMemeDropControl(interaction);
      } else if (interaction.commandName === "react-message") {
        await handleReactMessage(interaction);
      }
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === "pixel_leaderboard_hype") {
        const messageId = interaction.message?.id;

        if (!messageId) {
          await interaction.reply({
            content: "Could not resolve leaderboard message for hype tracking.",
            ephemeral: true,
          });
          return;
        }

        const accepted = registerHypePress(messageId, interaction.user.id);
        if (!accepted) {
          await interaction.reply({
            content: "You already hyped this leaderboard. One hype per member.",
            ephemeral: true,
          });
          return;
        }

        const totalHypes = getHypeCount(messageId);
        await interaction.reply({
          content: `${getRandomHypeMessage()}\nUnique hypes on this board: **${totalHypes}**`,
          ephemeral: true,
        });
      }
    }
  } catch (error) {
    console.error("Interaction error:", error);

    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content: "Something went wrong while handling that action.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: "Something went wrong while handling that action.",
      ephemeral: true,
    });
  }
});

async function start() {
  await registerCommands();
  await client.login(TOKEN);
}

start().catch((error) => {
  console.error("Failed to start Pixel:", error);
  process.exit(1);
});
