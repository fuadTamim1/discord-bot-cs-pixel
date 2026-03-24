require("dotenv").config();

const { REST, Routes } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const channelIds = [process.env.MAIN_CHANNEL_ID, process.env.TEST_CHANNEL_ID].filter(Boolean);
const messageId = process.argv[2];
const wrongName = process.argv[3] || "Razan Saleh";
const correctName = process.argv[4] || "Razan Salah";

if (!token) {
  console.error("Missing DISCORD_TOKEN");
  process.exit(1);
}

if (!messageId) {
  console.error("Usage: node scripts/fix-message-name.js <messageId> [wrongName] [correctName]");
  process.exit(1);
}

if (channelIds.length === 0) {
  console.error("No MAIN_CHANNEL_ID/TEST_CHANNEL_ID configured.");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

function replaceInString(value) {
  if (typeof value !== "string") return value;
  return value.split(wrongName).join(correctName);
}

async function tryUpdateInChannel(channelId) {
  const message = await rest.get(Routes.channelMessage(channelId, messageId));

  let changed = false;
  const payload = {};

  if (typeof message.content === "string") {
    const nextContent = replaceInString(message.content);
    if (nextContent !== message.content) {
      payload.content = nextContent;
      changed = true;
    }
  }

  if (Array.isArray(message.embeds) && message.embeds.length > 0) {
    const nextEmbeds = message.embeds.map((embed) => {
      const copy = JSON.parse(JSON.stringify(embed));
      copy.title = replaceInString(copy.title);
      copy.description = replaceInString(copy.description);

      if (copy.footer && typeof copy.footer.text === "string") {
        copy.footer.text = replaceInString(copy.footer.text);
      }

      if (Array.isArray(copy.fields)) {
        copy.fields = copy.fields.map((field) => ({
          ...field,
          name: replaceInString(field.name),
          value: replaceInString(field.value),
        }));
      }

      return copy;
    });

    if (JSON.stringify(nextEmbeds) !== JSON.stringify(message.embeds)) {
      payload.embeds = nextEmbeds;
      changed = true;
    }
  }

  if (!changed) {
    return { found: true, changed: false };
  }

  await rest.patch(Routes.channelMessage(channelId, messageId), { body: payload });
  return { found: true, changed: true };
}

(async () => {
  for (const channelId of channelIds) {
    try {
      const result = await tryUpdateInChannel(channelId);
      if (result.changed) {
        console.log(`Updated message ${messageId} in channel ${channelId}`);
      } else {
        console.log(`Message ${messageId} found in channel ${channelId}, but no matching text to replace.`);
      }
      process.exit(0);
    } catch (error) {
      if (error && (error.status === 404 || error.code === 10008)) {
        console.log(`Message ${messageId} not found in channel ${channelId}`);
        continue;
      }

      console.error(`Error in channel ${channelId}:`, error.message || error);
      process.exit(1);
    }
  }

  console.error("Could not find that message in MAIN_CHANNEL_ID or TEST_CHANNEL_ID.");
  process.exit(2);
})();
