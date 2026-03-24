require("dotenv").config();

const { REST, Routes } = require("discord.js");

const token = process.env.DISCORD_TOKEN;
const channelIds = [process.env.MAIN_CHANNEL_ID, process.env.TEST_CHANNEL_ID].filter(Boolean);
const messageId = process.argv[2];

if (!token || !messageId || channelIds.length === 0) {
  console.error("Usage: node scripts/inspect-message.js <messageId>");
  process.exit(1);
}

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  for (const channelId of channelIds) {
    try {
      const msg = await rest.get(Routes.channelMessage(channelId, messageId));
      console.log("Found in channel:", channelId);
      console.log("Message content:");
      console.log(msg.content || "<empty>");

      if (Array.isArray(msg.embeds) && msg.embeds.length > 0) {
        msg.embeds.forEach((embed, i) => {
          console.log(`Embed #${i + 1} title:`, embed.title || "<none>");
          console.log(`Embed #${i + 1} description:\n${embed.description || "<none>"}`);
        });
      }
      process.exit(0);
    } catch (error) {
      if (error && (error.status === 404 || error.code === 10008)) {
        console.log(`Message not found in channel ${channelId}`);
        continue;
      }

      console.error("Error:", error.message || error);
      process.exit(1);
    }
  }

  console.error("Message not found in configured channels.");
  process.exit(2);
})();
