import type { ModelEntry } from "./types";

export function isFreeModel(modelId: string): boolean {
  return modelId.startsWith("free-");
}

/* Run on public Hugging Face Spaces with the visitor's free token — see
   generation/free-models.ts. No start frame: uploads need the Blob store, and
   these stay usable on a deployment without one. */

export const freeLtxVideo: ModelEntry = {
  id: "free-ltx-video",
  surface: "video",
  label: "LTX Video · Free",
  roles: {},
  settings: {
    aspectRatio: { type: "enum", values: ["16:9", "9:16", "1:1"], default: "16:9" },
    duration: { type: "range", min: 2, max: 8, default: 4 },
  },
};

export const freeFluxSchnell: ModelEntry = {
  id: "free-flux-schnell",
  surface: "image",
  label: "FLUX Schnell · Free",
  roles: {},
  settings: {
    aspectRatio: { type: "enum", values: ["1:1", "16:9", "9:16", "4:3", "3:4"], default: "16:9" },
  },
};
