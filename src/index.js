require("dotenv").config();
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

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
const CS_LOGO_URL = (process.env.CS_LOGO_URL || "")
  .trim()
  .replace(/^"(.*)"$/, "$1")
  .replace(/^'(.*)'$/, "$1");
const PIXEL_EMOJI_ID = "1465668039256047671";
const DEFAULT_MEMBER_ROLE_ID =
  process.env.DEFAULT_MEMBER_ROLE_ID || "1465118775715168473";
const REACT_MESSAGE_ID = process.env.REACT_MESSAGE_ID || "1499069808174698516";
const REACT_MESSAGE_CHANNEL_ID = process.env.REACT_MESSAGE_CHANNEL_ID || "";

const MAX_TIMEOUT_MS = 2147483647;
const MIN_MEME_DROP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_MEME_DROP_INTERVAL_MS = 48 * 60 * 60 * 1000;
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
const MEME_CAPTIONS = [
  "Surprise meme drop! Hope this helps you debug today. 🚀",
  "Time for a quick brain break. Enjoy! 👾",
  "Pixel found this one in the cache. Fresh meme incoming. ⚡",
  "Deploying smiles to production... done. 😎",
  "Stack trace looks scary. Meme medicine delivered. 🛠️",
  "Quick meme checkpoint before the next sprint. 🧠",
  "Random drop from Pixel. No ticket required. 📦",
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
`);

const insertHypePressStmt = db.prepare(`
  INSERT OR IGNORE INTO hype_presses (message_id, user_id)
  VALUES (?, ?)
`);

const countHypePressesStmt = db.prepare(`
  SELECT COUNT(*) AS count FROM hype_presses
  WHERE message_id = ?
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
  .setDescription("React to the pinned message with an emoji of your choice")
  .addStringOption((option) =>
    option
      .setName("emoji")
      .setDescription("Emoji to react with (e.g. 👍, ❤️, or a custom server emoji)")
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
      .setDescription("Post one meme immediately")
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

async function handleReactMessage(interaction) {
  const emoji = interaction.options.getString("emoji", true);

  if (!REACT_MESSAGE_CHANNEL_ID) {
    await interaction.reply({
      content:
        "REACT_MESSAGE_CHANNEL_ID is not configured. Set it in .env so Pixel knows where to find the message.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const channel = await client.channels.fetch(REACT_MESSAGE_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText) {
      await interaction.editReply({
        content: "Could not find the configured channel.",
      });
      return;
    }

    const message = await channel.messages.fetch(REACT_MESSAGE_ID);
    await message.react(emoji);

    await interaction.editReply({
      content: `Reacted with ${emoji} on the message!`,
    });
  } catch (error) {
    console.error("[ReactMessage] Failed to react:", error.message);
    await interaction.editReply({
      content:
        "Failed to react to the message. Make sure the emoji is valid and Pixel has permission to react.",
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

  const memeFolderPath = toAbsolutePath(MEME_DROP_FOLDER);
  const memeFiles = getMemeFilesFromFolder(memeFolderPath);

  if (memeFiles.length === 0) {
    console.error(
      `[MemeDrop] Meme folder is empty (or has no supported images): ${memeFolderPath}`
    );
    return;
  }

  const memeFilePath = pickRandom(memeFiles);
  const caption = pickRandom(MEME_CAPTIONS);

  const attachment = new AttachmentBuilder(memeFilePath, {
    name: path.basename(memeFilePath),
  });

  await channel.send({
    content: caption,
    files: [attachment],
  });

  console.log(`[MemeDrop] Posted meme: ${path.basename(memeFilePath)}`);
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

function formatMemeDropStatus() {
  const channelInfo = MEME_DROP_CHANNEL_ID
    ? `<#${MEME_DROP_CHANNEL_ID}>`
    : "Not configured";
  const folderInfo = toAbsolutePath(MEME_DROP_FOLDER);
  const nextRun = nextMemeDropAt
    ? `<t:${Math.floor(nextMemeDropAt.getTime() / 1000)}:F>`
    : "Not scheduled";

  return [
    `Enabled: **${memeDropLoopEnabled ? "Yes" : "No"}**`,
    `Channel: ${channelInfo}`,
    `Folder: ${folderInfo}`,
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
    await postRandomMemeDrop();
    await interaction.reply({
      content: "Posted one meme drop now (if a valid meme file was available).",
      ephemeral: true,
    });
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
