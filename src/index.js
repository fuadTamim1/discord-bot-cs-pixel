require("dotenv").config();

const {
  ActionRowBuilder,
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
const CS_LOGO_URL = (process.env.CS_LOGO_URL || "")
  .trim()
  .replace(/^"(.*)"$/, "$1")
  .replace(/^'(.*)'$/, "$1");
const PIXEL_EMOJI_ID = "1465668039256047671";
const DEFAULT_MEMBER_ROLE_ID =
  process.env.DEFAULT_MEMBER_ROLE_ID || "1465118775715168473";

const MAX_TIMEOUT_MS = 2147483647;
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

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(TOKEN);

  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: [leaderboardCommand.toJSON()],
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
});

client.on("interactionCreate", async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "post-leaderboard") {
        await handlePostLeaderboard(interaction);
      }
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === "pixel_leaderboard_hype") {
        await interaction.reply({
          content: getRandomHypeMessage(),
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
