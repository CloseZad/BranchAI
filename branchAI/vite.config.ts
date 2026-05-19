import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, type Content } from "@google/genai";
import { defineConfig, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

type ChatRole = "user" | "model";

type ChatMessage = {
  role: ChatRole;
  text: string;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readEnvValue(key: string) {
  if (process.env[key]) {
    return process.env[key];
  }

  for (const envPath of [
    path.resolve(__dirname, ".env"),
    path.resolve(__dirname, "..", ".env"),
  ]) {
    if (!fs.existsSync(envPath)) {
      continue;
    }

    const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match?.[1] === key) {
        return match[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function readRequestBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function toGeminiHistory(history: ChatMessage[]): Content[] {
  return history.map((message) => ({
    role: message.role,
    parts: [{ text: message.text }],
  }));
}

function geminiChatPlugin() {
  return {
    name: "branchai-gemini-chat",
    configureServer(server: ViteDevServer) {
      server.middlewares.use("/api/chat", async (req, res) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "Method not allowed" });
          return;
        }

        try {
          const apiKey =
            readEnvValue("GEMINI_API_KEY") ??
            readEnvValue("VITE_GEMINI_API_KEY");

          if (!apiKey) {
            sendJson(res, 500, {
              error:
                "Missing GEMINI_API_KEY. Add it to .env in the project root.",
            });
            return;
          }

          const body = (await readRequestBody(req)) as {
            message?: string;
            history?: ChatMessage[];
          };
          const message = body.message?.trim();

          if (!message) {
            sendJson(res, 400, { error: "Message is required." });
            return;
          }

          const ai = new GoogleGenAI({ apiKey });
          const chat = ai.chats.create({
            model: "gemini-2.5-flash",
            history: toGeminiHistory(body.history ?? []),
          });
          const response = await chat.sendMessage({ message });

          sendJson(res, 200, { text: response.text ?? "" });
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown Gemini error.";
          sendJson(res, 500, { error: message });
        }
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  base: "/BranchAI/",
  plugins: [react(), geminiChatPlugin()],
});
