import OpenAI from "openai";

export const DEEPSEEK_API_BASE_URL = "https://api.deepseek.com" as const;
export const AI_TEXT_MODEL = "deepseek-v4-pro" as const;

/** 供应商回报的实测用量。只放数字，不放正文。 */
export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  /**
   * 命中上下文缓存的输入 token 数。DeepSeek 对命中与未命中的输入按两档计价（相差约 30 倍），
   * 所以这一项直接决定成本。供应商没有拆分回报时为 null——此时按全部未命中计价，
   * 得到的是成本上界而不是精确值，宁可高估也不低估预算。
   */
  readonly cachedInputTokens: number | null;
}

/** 一次供应商调用的对账凭据，交给调用方去结算 private.cost_attempts。 */
export interface ProviderMeasurement {
  readonly providerOperationId: string;
  readonly model: string;
  readonly usage: ProviderUsage;
}

export interface StructuredOutputRequest {
  readonly instructions: string;
  readonly input: string;
  readonly schemaName: string;
  readonly schema: Record<string, unknown>;
  /**
   * 供应商回报实测用量时逐次回调。修复重试会各回调一次，调用方据此递增 attempt 序号。
   * 供应商没回报 usage 时不调用——不估算、不补零。
   * 回调抛错会向上冒泡：结算失败该不该让生成失败，由调用方在自己的处理里决定。
   */
  readonly onMeasurement?: (measurement: ProviderMeasurement) => Promise<void>;
}

export interface StructuredAI {
  generateStructured(request: StructuredOutputRequest): Promise<unknown>;
}

interface ResponsesClient {
  readonly responses: {
    create(input: Record<string, unknown>): PromiseLike<{
      readonly id?: string;
      readonly output_text?: string;
      readonly usage?: {
        readonly input_tokens?: number;
        readonly output_tokens?: number;
        readonly total_tokens?: number;
        readonly input_tokens_details?: { readonly cached_tokens?: number };
      };
    }>;
  };
}

/** 三个字段都拿到真实非负数字才算数；缺任何一个就当作没有实测用量。 */
function readUsage(usage: ResponsesUsage | undefined): ProviderUsage | null {
  if (!usage) return null;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const totalTokens = usage.total_tokens;
  if (
    typeof inputTokens !== "number" || !Number.isFinite(inputTokens) || inputTokens < 0 ||
    typeof outputTokens !== "number" || !Number.isFinite(outputTokens) || outputTokens < 0 ||
    typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens < 0
  ) {
    return null;
  }
  const cached = usage.input_tokens_details?.cached_tokens;
  const cachedInputTokens =
    typeof cached === "number" && Number.isFinite(cached) && cached >= 0 && cached <= inputTokens
      ? cached
      : null;
  return { inputTokens, outputTokens, totalTokens, cachedInputTokens };
}

type ResponsesUsage = NonNullable<
  Awaited<ReturnType<ResponsesClient["responses"]["create"]>>["usage"]
>;

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

export function createDeepSeekResponsesClient(apiKey: string): ResponsesClient {
  if (!apiKey.trim()) {
    throw new Error("A DeepSeek API key is required.");
  }
  return new OpenAI({ apiKey, baseURL: DEEPSEEK_API_BASE_URL }) as unknown as ResponsesClient;
}

export function createDeepSeekResponsesAdapter(
  client: ResponsesClient,
): StructuredAI {
  return {
    async generateStructured(request) {
      let response: Awaited<ReturnType<ResponsesClient["responses"]["create"]>>;
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

      // 先结算再校验产物：token 是照烧的，输出无效不等于这次调用没花钱。
      const usage = readUsage(response.usage);
      if (usage && request.onMeasurement) {
        await request.onMeasurement({
          providerOperationId: response.id ?? "",
          model: AI_TEXT_MODEL,
          usage,
        });
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
