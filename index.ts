import { Bot } from "grammy";

console.log("=================================");
console.log("Starting Telegram AI bot...");
console.log("=================================");

// Check environment variables
if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("❌ TELEGRAM_BOT_TOKEN is missing");
  process.exit(1);
}

if (!process.env.OPENCODE_API_KEY) {
  console.error("❌ OPENCODE_API_KEY is missing");
  process.exit(1);
}

console.log("✅ TELEGRAM_BOT_TOKEN found");
console.log("✅ OPENCODE_API_KEY found");

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

const OPENCODE_API_URL =
  "https://opencode.ai/inference/go/openai/v1/chat/completions";

const MODEL = "deepseek-v4.1-flash";

type Message = {
  role: "user" | "assistant";
  content: string;
};

const conversations = new Map<number, Message[]>();

async function askAI(chatId: number, message: string) {
  console.log("");
  console.log("========== AI REQUEST ==========");
  console.log(`Chat ID: ${chatId}`);
  console.log(`Message: ${message}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Endpoint: ${OPENCODE_API_URL}`);

  const history = conversations.get(chatId) ?? [];

  history.push({
    role: "user",
    content: message,
  });

  console.log(`Conversation messages: ${history.length}`);

  console.log("→ Sending request to OpenCode...");

  let response: Response;

  try {
    response = await fetch(OPENCODE_API_URL, {
      method: "POST",

      headers: {
        Authorization: `Bearer ${process.env.OPENCODE_API_KEY}`,
        "Content-Type": "application/json",

        "User-Agent": "my-telegram-agent/1.0",

        "x-opencode-session": `telegram-${chatId}`,
      },

      body: JSON.stringify({
        model: MODEL,
        messages: history,
        temperature: 0.7,
        max_tokens: 4096,
      }),
    });
  } catch (error) {
    console.error("❌ Network error while calling OpenCode:");

    if (error instanceof Error) {
      console.error(error.message);
      console.error(error.stack);
    } else {
      console.error(error);
    }

    throw error;
  }

  console.log(`← OpenCode response: ${response.status} ${response.statusText}`);

  const rawResponse = await response.text();

  console.log("OpenCode raw response:");
  console.log(rawResponse);

  if (!response.ok) {
    throw new Error(
      `OpenCode API error ${response.status}: ${rawResponse}`
    );
  }

  let data: any;

  try {
    data = JSON.parse(rawResponse);
  } catch {
    throw new Error("OpenCode returned invalid JSON");
  }

  const answer = data.choices?.[0]?.message?.content;

  if (!answer) {
    console.error("❌ Could not find AI response in API response");
    console.error("Parsed response:", JSON.stringify(data, null, 2));

    throw new Error("No response returned by OpenCode");
  }

  console.log("✅ AI response received");
  console.log(`Response length: ${answer.length} characters`);
  console.log("================================");

  history.push({
    role: "assistant",
    content: answer,
  });

  conversations.set(chatId, history.slice(-20));

  return answer;
}


// /start
bot.command("start", async (ctx) => {
  console.log("");
  console.log("📩 /start received");
  console.log(`Chat ID: ${ctx.chat.id}`);
  console.log(`Username: ${ctx.from?.username ?? "unknown"}`);

  try {
    await ctx.reply(
      "OpenCode Go + DeepSeek V4.1 Flash bot is running.\n\nSend me a message."
    );

    console.log("✅ /start response sent");
  } catch (error) {
    console.error("❌ Failed to send /start response:", error);
  }
});


// /clear
bot.command("clear", async (ctx) => {
  console.log(`📩 /clear received from ${ctx.chat.id}`);

  conversations.delete(ctx.chat.id);

  await ctx.reply("Conversation cleared.");

  console.log("✅ Conversation cleared");
});


// Text messages
bot.on("message:text", async (ctx) => {
  const chatId = ctx.chat.id;
  const message = ctx.message.text;

  console.log("");
  console.log("=================================");
  console.log("📩 NEW TELEGRAM MESSAGE");
  console.log(`Chat ID: ${chatId}`);
  console.log(`Username: ${ctx.from?.username ?? "unknown"}`);
  console.log(`Message: ${message}`);
  console.log("=================================");

  try {
    console.log("→ Sending typing indicator...");

    await ctx.replyWithChatAction("typing");

    console.log("→ Calling OpenCode API...");

    const answer = await askAI(chatId, message);

    console.log("→ Sending AI response to Telegram...");

    const chunks = answer.match(/[\s\S]{1,4000}/g) ?? [];

    console.log(`Response split into ${chunks.length} Telegram message(s)`);

    for (const chunk of chunks) {
      await ctx.reply(chunk);
      console.log("✅ Telegram message sent");
    }

    console.log("✅ Request completed successfully");

  } catch (error) {
    console.error("");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
    console.error("❌ REQUEST FAILED");
    console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");

    if (error instanceof Error) {
      console.error("Error:", error.message);
      console.error("Stack:", error.stack);
    } else {
      console.error(error);
    }

    try {
      await ctx.reply(
        `❌ Error:\n\n${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );

      console.log("✅ Error message sent to Telegram");
    } catch (telegramError) {
      console.error("❌ Could not send error to Telegram:");
      console.error(telegramError);
    }
  }
});


// Global Telegram errors
bot.catch((error) => {
  console.error("");
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
  console.error("❌ GRAMMY / TELEGRAM ERROR");
  console.error("!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");

  console.error(error);

  if (error instanceof Error) {
    console.error(error.stack);
  }
});


// Start bot
console.log("");
console.log("→ Starting Telegram polling...");

bot.start({
  onStart: (botInfo) => {
    console.log("");
    console.log("=================================");
    console.log("✅ TELEGRAM BOT IS RUNNING");
    console.log(`Bot: @${botInfo.username}`);
    console.log(`Bot ID: ${botInfo.id}`);
    console.log("Waiting for messages...");
    console.log("=================================");
  },
});