import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool } from "../../core/types.js";
import type { OmniVoiceClient } from "../../connectors/voice/OmniVoiceClient.js";
import type { SttClient } from "../../connectors/voice/SttClient.js";

const formats = ["wav", "mp3", "opus", "aac", "flac", "pcm"] as const;

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string argument: ${key}`);
  return value.trim();
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function createVoiceTools(voice: OmniVoiceClient, stt: SttClient, workspaceRoot: string): AgentTool[] {
  return [
    {
      name: "voice_stt_health",
      description: "Check whether the speech-to-text service on the GPU server is reachable.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => ({
        configured: stt.isConfigured(),
        ready: stt.isConfigured(),
      }),
    },
    {
      name: "voice_health",
      description: "Check whether the OmniVoice TTS service on the GPU server is healthy and ready.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => {
        if (!voice.isConfigured()) {
          return { configured: false, ready: false, detail: "CHERRY_TTS_BASE_URL is not set" };
        }
        const health = await voice.health();
        return {
          configured: true,
          ready: health.ready,
          status: health.status,
          modelLoaded: health.modelLoaded ?? false,
          modelId: health.modelId ?? null,
        };
      },
    },
    {
      name: "voice_speak",
      description: "Synthesize speech from text using OmniVoice TTS and save the audio file in the workspace voice folder.",
      risk: "write",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text to speak aloud" },
          language: { type: "string", description: "Language code such as th, en, zh" },
          voice: { type: "string", description: "Voice profile id or auto" },
          speed: { type: "number", description: "Playback speed from 0.25 to 4.0" },
          format: { type: "string", enum: [...formats], description: "Audio format" },
          filename: { type: "string", description: "Optional output filename without extension" },
        },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async (args) => {
        if (!voice.isConfigured()) throw new Error("OmniVoice is not configured. Set CHERRY_TTS_BASE_URL.");

        const text = requiredString(args, "text");
        const formatValue = optionalString(args, "format");
        if (formatValue && !formats.includes(formatValue as typeof formats[number])) {
          throw new Error(`format must be one of: ${formats.join(", ")}`);
        }

        const speedValue = args.speed;
        const speed = speedValue === undefined
          ? undefined
          : typeof speedValue === "number"
            ? speedValue
            : Number(speedValue);
        if (speed !== undefined && (!Number.isFinite(speed) || speed < 0.25 || speed > 4)) {
          throw new Error("speed must be between 0.25 and 4.0");
        }

        const language = optionalString(args, "language");
        const voiceName = optionalString(args, "voice");
        const result = await voice.synthesize(text, {
          ...(language ? { language } : {}),
          ...(voiceName ? { voice: voiceName } : {}),
          ...(speed !== undefined ? { speed } : {}),
          ...(formatValue ? { format: formatValue as typeof formats[number] } : {}),
        });

        const voiceDir = join(workspaceRoot, "voice");
        await mkdir(voiceDir, { recursive: true });
        const stem = optionalString(args, "filename")?.replace(/[^\w.-]+/g, "_") || `speech-${Date.now()}`;
        const file = join(voiceDir, `${stem}.${result.format}`);
        await writeFile(file, result.audio);

        return {
          text,
          file,
          format: result.format,
          bytes: result.bytes,
        };
      },
    },
    {
      name: "voice_listen",
      description: "Transcribe a local audio file in the workspace using the GPU speech-to-text service.",
      risk: "safe",
      parameters: {
        type: "object",
        properties: {
          file: { type: "string", description: "Path to a wav/audio file inside the workspace" },
        },
        required: ["file"],
        additionalProperties: false,
      },
      execute: async (args) => {
        if (!stt.isConfigured()) throw new Error("STT is not configured. Set CHERRY_STT_BASE_URL.");
        const file = requiredString(args, "file");
        const absolute = join(workspaceRoot, file.replace(/^\.?\//, ""));
        if (!absolute.startsWith(workspaceRoot)) throw new Error("file must stay inside the workspace");
        const audio = await readFile(absolute);
        const transcript = await stt.transcribe(audio, file.split("/").pop() ?? "audio.wav");
        return transcript;
      },
    },
  ];
}
