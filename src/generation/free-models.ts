import type { GenerationPlane } from "./catalog/types";

export { isFreeModel } from "./catalog/free";
import type { GenerationStatus } from "./platform";

/* Free models run on public Hugging Face Spaces (ZeroGPU). Anonymous callers
   share one small quota, so each request carries the visitor's own free
   Hugging Face token, which gives them a daily allowance of their own.

   A Space answers through Gradio's queue: join with a session hash, then read
   that session's event stream until the run completes. The stream carries the
   Space's own error text (an exhausted quota, a bad token), which the simpler
   /call endpoint drops. */

type SpaceCall = { space: string; api: string; data: unknown[] };

const RESULT_PREFIX = "hf:";
const RUN_DEADLINE_MS = 280_000;

export function isFreeResult(requestId: string): boolean {
  return requestId.startsWith(RESULT_PREFIX);
}

/** Runs the generation to completion and returns a request id that already
    holds the result, so the studio's status poll answers it without a call. */
export async function runFreeModel(plane: GenerationPlane, token: string): Promise<string> {
  const call = toSpaceCall(plane);
  await requireValidToken(token);
  const output = await callSpace(call, token);
  const status = toStatus(plane.model, output);
  return RESULT_PREFIX + Buffer.from(JSON.stringify(status)).toString("base64url");
}

export function readFreeResult(requestId: string): GenerationStatus {
  try {
    const status = JSON.parse(
      Buffer.from(requestId.slice(RESULT_PREFIX.length), "base64url").toString("utf8"),
    ) as GenerationStatus;
    return { ...status, requestId };
  } catch {
    return { status: "failed", requestId, error: "The saved result could not be read" };
  }
}

/** A Space treats an unknown token as no token and answers with the shared
    anonymous quota, so a typo would read as "allowance used up". */
async function requireValidToken(token: string): Promise<void> {
  const response = await fetch("https://huggingface.co/api/whoami-v2", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401 || response.status === 403) {
    throw new Error("Hugging Face did not accept the token — copy it again from huggingface.co → Settings → Access Tokens");
  }
}

function toSpaceCall(plane: GenerationPlane): SpaceCall {
  const prompt = plane.prompt.text.trim();
  if (!prompt) throw new Error("Describe what to make first");
  const aspect = String(plane.settings.aspectRatio ?? "");

  if (plane.model === "free-flux-schnell") {
    const [width, height] = FLUX_SIZES[aspect] ?? FLUX_SIZES["1:1"]!;
    return {
      space: "black-forest-labs-flux-1-schnell",
      api: "infer",
      data: [prompt, 0, true, width, height, 4],
    };
  }

  if (plane.model === "free-ltx-video") {
    const [width, height] = LTX_SIZES[aspect] ?? LTX_SIZES["16:9"]!;
    const duration = Number(plane.settings.duration) || 4;
    return {
      space: "lightricks-ltx-video-distilled",
      api: "text_to_video",
      data: [
        prompt,
        "worst quality, inconsistent motion, blurry, jittery, distorted",
        null,
        null,
        height,
        width,
        "text-to-video",
        duration,
        9,
        42,
        true,
        1,
        true,
      ],
    };
  }

  throw new Error(`Unknown free model: ${plane.model}`);
}

const FLUX_SIZES: Record<string, [number, number]> = {
  "1:1": [1024, 1024],
  "16:9": [1024, 576],
  "9:16": [576, 1024],
  "4:3": [1024, 768],
  "3:4": [768, 1024],
};

const LTX_SIZES: Record<string, [number, number]> = {
  "16:9": [704, 384],
  "9:16": [384, 704],
  "1:1": [512, 512],
};

async function callSpace(call: SpaceCall, token: string): Promise<unknown[]> {
  const origin = `https://${call.space}.hf.space`;
  const auth = { Authorization: `Bearer ${token}` };

  const config = (await fetchJson(`${origin}/config`, { headers: auth })) as {
    dependencies?: Array<{ api_name?: string | null }>;
  };
  const fnIndex = (config.dependencies ?? []).findIndex((dep) => dep.api_name === call.api);
  if (fnIndex < 0) throw new Error("The free model has changed how it is called — try again later");

  const sessionHash = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  await fetchJson(`${origin}/gradio_api/queue/join`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: call.data,
      fn_index: fnIndex,
      event_data: null,
      session_hash: sessionHash,
      trigger_id: null,
    }),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RUN_DEADLINE_MS);
  try {
    const response = await fetch(`${origin}/gradio_api/queue/data?session_hash=${sessionHash}`, {
      headers: { ...auth, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`The free model did not answer (${response.status})`);
    return await readUntilComplete(response.body);
  } catch (caught) {
    if (controller.signal.aborted) throw new Error("The free model took too long — try a shorter clip");
    throw caught;
  } finally {
    clearTimeout(timer);
  }
}

async function readUntilComplete(body: ReadableStream<Uint8Array>): Promise<unknown[]> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      const message = JSON.parse(line.slice(5)) as {
        msg?: string;
        success?: boolean;
        output?: { data?: unknown[]; error?: string | null };
      };
      if (message.msg !== "process_completed") continue;
      void reader.cancel();
      if (message.success && Array.isArray(message.output?.data)) return message.output.data;
      throw new Error(friendlySpaceError(message.output?.error));
    }
  }
  throw new Error("The free model stopped before finishing — try again");
}

function friendlySpaceError(error: string | null | undefined): string {
  if (!error) return "The free model could not make this one — try again";
  if (/quota|runs limit/i.test(error)) {
    return "Today's free allowance on your Hugging Face token is used up — it refills daily";
  }
  if (/token|unauthori[sz]ed|401/i.test(error)) {
    return "Hugging Face did not accept the token — check it starts with hf_ and has Read access";
  }
  return error;
}

function toStatus(modelId: string, output: unknown[]): GenerationStatus {
  const first = output[0] as { url?: unknown; video?: { url?: unknown } } | null | undefined;
  if (modelId === "free-ltx-video") {
    const url = first?.video?.url;
    if (typeof url !== "string") throw new Error("The free model returned no video");
    return { status: "completed", requestId: "", video: { url } };
  }
  const url = first?.url;
  if (typeof url !== "string") throw new Error("The free model returned no image");
  return { status: "completed", requestId: "", images: [{ url }] };
}

async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(url, init);
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new Error("Hugging Face did not accept the token — check it starts with hf_ and has Read access");
  }
  if (!response.ok) throw new Error(`The free model is unavailable right now (${response.status})`);
  return text ? (JSON.parse(text) as unknown) : null;
}
