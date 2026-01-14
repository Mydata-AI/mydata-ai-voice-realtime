import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";

dotenv.config();

// ==================================================
// ENV
// ==================================================
const { OPENAI_API_KEY } = process.env;

if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}

// ==================================================
// FASTIFY
// ==================================================
const fastify = Fastify({ logger: true });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 8080;

// ==================================================
// SYSTEM PROMPT (DANSK)
// ==================================================
const SYSTEM_MESSAGE = `
Du er MyData Support.

Du tager imod telefonopkald fra kunder.
Tal dansk.
Tal roligt og professionelt.
Stil ét spørgsmål ad gangen.

Du hjælper med:
- printerproblemer
- computeropsætning
- åbningstider
- opsigelse af abonnement

Hvis du ikke kan løse problemet,
så sig at du stiller videre til en medarbejder.
`;

const VOICE = "alloy";
const TEMPERATURE = 0.6;

// ==================================================
// ROUTES
// ==================================================
fastify.get("/", async () => {
  return { status: "MyData AI Voice running" };
});

fastify.get("/healthz", async () => "ok");

// ==================================================
// TWILIO VOICE WEBHOOK
// ==================================================
fastify.all("/voice", async (request, reply) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Du bliver nu forbundet til MyData support.</Say>
  <Connect>
    <Stream url="wss://${request.headers.host}/media-stream" />
  </Connect>
</Response>`;
  reply.type("text/xml").send(twiml);
});

// ==================================================
// MEDIA STREAM (TWILIO ↔ OPENAI)
// ==================================================
fastify.register(async (fastify) => {
  fastify.get("/media-stream", { websocket: true }, (connection) => {
    fastify.log.info("📞 Twilio Media Stream connected");

    let streamSid = null;
    let latestMediaTimestamp = 0;
    let responseStartTimestampTwilio = null;
    let lastAssistantItem = null;
    let markQueue = [];

    let openAiReady = false;
    let twilioReady = false;

    const openAiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview&temperature=${TEMPERATURE}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    // ==================================================
    // OPENAI CONNECTED
    // ==================================================
    openAiWs.on("open", () => {
      fastify.log.info("🤖 OpenAI Realtime connected");
      openAiReady = true;

      // Session init (KRITISK)
      openAiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcmu" },
              turn_detection: { type: "server_vad" }
            },
            output: {
              format: { type: "audio/pcmu" },
              voice: VOICE
            }
          },
          instructions: SYSTEM_MESSAGE,
        }
      }));
    });

    // ==================================================
    // OPENAI → TWILIO (AUDIO UD)
    // ==================================================
    openAiWs.on("message", (data) => {
      const msg = JSON.parse(data.toString());

      if (msg.type === "response.output_audio.delta" && msg.delta && streamSid) {
        connection.send(JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: msg.delta }
        }));

        if (!responseStartTimestampTwilio) {
          responseStartTimestampTwilio = latestMediaTimestamp;
        }

        if (msg.item_id) {
          lastAssistantItem = msg.item_id;
        }

        connection.send(JSON.stringify({
          event: "mark",
          streamSid,
          mark: { name: "ai-response" }
        }));

        markQueue.push("ai-response");
      }

      // Afbryd AI hvis kunden begynder at tale
      if (msg.type === "input_audio_buffer.speech_started") {
        if (lastAssistantItem && responseStartTimestampTwilio !== null) {
          const elapsed = latestMediaTimestamp - responseStartTimestampTwilio;

          openAiWs.send(JSON.stringify({
            type: "conversation.item.truncate",
            item_id: lastAssistantItem,
            content_index: 0,
            audio_end_ms: elapsed
          }));

          connection.send(JSON.stringify({ event: "clear", streamSid }));

          markQueue = [];
          lastAssistantItem = null;
          responseStartTimestampTwilio = null;
        }
      }
    });

    // ==================================================
    // TWILIO → OPENAI (AUDIO IND)
    // ==================================================
    connection.on("message", (message) => {
      const data = JSON.parse(message.toString());

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          twilioReady = true;
          latestMediaTimestamp = 0;
          responseStartTimestampTwilio = null;

          // 🔥 NU må AI tale (VIGTIG FIX)
          if (openAiReady) {
            openAiWs.send(JSON.stringify({
              type: "response.create",
              response: {
                instructions: "Hej, du taler med MyData Support. Hvordan kan jeg hjælpe?"
              }
            }));
          }
          break;

        case "media":
          latestMediaTimestamp = data.media.timestamp;
          if (openAiWs.readyState === WebSocket.OPEN) {
            openAiWs.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload
            }));
          }
          break;

        case "mark":
          if (markQueue.length > 0) markQueue.shift();
          break;
      }
    });

    // ==================================================
    // CLEANUP
    // ==================================================
    connection.on("close", () => {
      fastify.log.info("📞 Twilio disconnected");
      if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
    });

    openAiWs.on("close", () => {
      fastify.log.info("🤖 OpenAI disconnected");
    });

    openAiWs.on("error", (err) => {
      fastify.log.error(err, "OpenAI WS error");
    });
  });
});

// ==================================================
// START SERVER
// ==================================================
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  console.log(`🚀 MyData AI Voice running on port ${PORT}`);
});
