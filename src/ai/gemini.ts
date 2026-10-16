import { ApiError, GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { config } from '../config/env.js';

const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
const maxRetries = 3;

function supportedJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(supportedJsonSchema);
  if (typeof value !== 'object' || value === null) return value;

  const input = value as Record<string, unknown>;
  const supported = new Set([
    '$id',
    '$defs',
    '$ref',
    '$anchor',
    'type',
    'format',
    'title',
    'description',
    'enum',
    'items',
    'prefixItems',
    'minItems',
    'maxItems',
    'minimum',
    'maximum',
    'anyOf',
    'oneOf',
    'properties',
    'additionalProperties',
    'required',
  ]);
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(input)) {
    if (!supported.has(key)) continue;
    if (key === 'properties' || key === '$defs') {
      output[key] = Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([name, field]) => [
          name,
          supportedJsonSchema(field),
        ]),
      );
    } else {
      output[key] = supportedJsonSchema(item);
    }
  }
  if (input.const !== undefined) output.enum = [input.const];
  if (input.type === 'integer' && typeof input.exclusiveMinimum === 'number') {
    output.minimum = input.exclusiveMinimum + 1;
  }
  return output;
}

async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        (error.status !== 429 && (error.status < 500 || error.status > 599)) ||
        attempt >= maxRetries
      ) {
        throw error;
      }
      const delayMs = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function generateJson<T extends z.ZodType>(
  prompt: string,
  schema: T,
): Promise<z.output<T>> {
  const responseJsonSchema = supportedJsonSchema(z.toJSONSchema(schema));
  const response = await withRetry(() =>
    ai.models.generateContent({
      model: config.GEMINI_MODEL,
      contents: prompt,
      config: { responseMimeType: 'application/json', responseJsonSchema },
    }),
  );
  if (!response.text) throw new Error('Gemini returned no JSON text');
  return schema.parse(JSON.parse(response.text));
}

export async function generateText(prompt: string): Promise<string> {
  const response = await withRetry(() =>
    ai.models.generateContent({ model: config.GEMINI_MODEL, contents: prompt }),
  );
  const text = response.text?.trim();
  if (!text) throw new Error('Gemini returned no text');
  return text;
}
