import OpenAI from "openai";

export const AI_TEXT_MODEL = "gpt-5.6-luna" as const;

export interface StructuredOutputRequest {
  readonly instructions: string;
  readonly input: string;
  readonly schemaName: string;
  readonly schema: Record<string, unknown>;
}

export interface StructuredAI {
  generateStructured(request: StructuredOutputRequest): Promise<unknown>;
}

interface ResponsesClient {
  readonly responses: {
    create(input: Record<string, unknown>): PromiseLike<{
      readonly output_text?: string;
    }>;
  };
}

export class AIServiceError extends Error {
  constructor(
    readonly code: "PROVIDER_FAILED",
    message: string,
    readonly retryable: boolean,
    readonly schemaRepairable = false,
  ) {
    super(message);
    this.name = "AIServiceError";
  }
}

export function createOpenAIResponsesClient(apiKey: string): ResponsesClient {
  if (!apiKey.trim()) {
    throw new Error("An OpenAI API key is required.");
  }
  return new OpenAI({ apiKey }) as unknown as ResponsesClient;
}

export function createOpenAIResponsesAdapter(
  client: ResponsesClient,
): StructuredAI {
  return {
    async generateStructured(request) {
      let response: { readonly output_text?: string };
      try {
        response = await client.responses.create({
          model: AI_TEXT_MODEL,
          store: false,
          instructions: request.instructions,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: request.input }],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: request.schemaName,
              strict: true,
              schema: request.schema,
            },
          },
        });
      } catch {
        throw new AIServiceError(
          "PROVIDER_FAILED",
          "AI generation is temporarily unavailable.",
          true,
        );
      }

      if (!response.output_text) {
        throw new AIServiceError(
          "PROVIDER_FAILED",
          "AI returned no structured output.",
          true,
          true,
        );
      }
      try {
        return JSON.parse(response.output_text) as unknown;
      } catch {
        throw new AIServiceError(
          "PROVIDER_FAILED",
          "AI returned malformed structured output.",
          true,
          true,
        );
      }
    },
  };
}
