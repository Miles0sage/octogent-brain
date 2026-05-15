import { GoogleGenAI } from "@google/genai";
import { l2Normalize } from "./normalize.js";

// Support both GOOGLE_API_KEY and GEMINI_API_KEY for compat
function getKey() {
  return process.env["GOOGLE_API_KEY"] ?? process.env["GEMINI_API_KEY"] ?? "";
}

export type Purpose = "document" | "query";

export async function embed(text: string, purpose: Purpose): Promise<number[]> {
  const client = new GoogleGenAI({ apiKey: getKey() });
  const taskType = purpose === "document" ? "RETRIEVAL_DOCUMENT" : "RETRIEVAL_QUERY";
  const resp = await client.models.embedContent({
    model: "gemini-embedding-001",
    contents: text,
    config: { outputDimensionality: 768, taskType },
  });
  const raw = resp.embeddings?.[0]?.values;
  if (!raw) throw new Error("embedding failed: no vector returned");
  return l2Normalize(raw);
}
