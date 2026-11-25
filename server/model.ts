import OpenAI from "openai";

export const model = process.env.DEEPSEEK_MODEL || "deepseek-flash";

export class MissingModelKeyError extends Error {}

export function getModelClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey?.trim()) throw new MissingModelKeyError();
  return new OpenAI({
    apiKey,
    baseURL: "https://api.deepseek.com",
    timeout: 20_000,
    maxRetries: 0,
  });
}
