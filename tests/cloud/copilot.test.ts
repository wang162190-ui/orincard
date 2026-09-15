import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import { COPILOT_MESSAGE_MAX_LENGTH, runCopilotTurn, type CopilotStore } from "../../src/server/copilot";
import { RewriteError, type RewriteStore } from "../../src/server/rewrite";

/**
 * T097 助手对话轮的账目形状。
 *
 * 这里用一个**记账的假 store** 顶替数据库：它不是为了假装功能能用，而是为了断言
 * `runCopilotTurn` 对 store 的**调用顺序**——预留必须发生在模型调用之前，额度或预算
 * 不足时一个 token 都不能烧。真实的 reserved/spent 归还由
 * `server_begin_copilot_turn` / `server_finalize_copilot_turn` 两个 RPC 承担
 * （20260916000200_copilot_turn.sql），那一层的实测证据记在 docs/acceptance/assistant.md。
 */

const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const OWNER_ID = "owner-1";

async function fixture(): Promise<CarouselDocument> {
  return JSON.parse(
    await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8"),
  ) as CarouselDocument;
}

interface Ledger {
  readonly limit: number;
  reserved: number;
  spent: number;
  readonly replays: Map<string, { jobId: string; reply: string }>;
}

function ledger(limit: number): Ledger {
  return { limit, reserved: 0, spent: 0, replays: new Map() };
}

/** 形状与迁移里的两个 RPC 同构：begin 预留一个单位，finalize 把它结进 spent。 */
function ledgerStore(book: Ledger, turns: { reply: string }[] = []): CopilotStore {
  let nextJob = 0;
  return {
    begin: vi.fn(async (input) => {
      const replayed = book.replays.get(input.idempotencyKey);
      if (replayed) {
        return { outcome: "replay" as const, jobId: replayed.jobId, result: { reply: replayed.reply } };
      }
      if (book.reserved + book.spent >= book.limit) {
        return { outcome: "budget_exceeded" as const };
      }
      book.reserved += 1;
      const jobId = `job-${(nextJob += 1)}`;
      book.replays.set(input.idempotencyKey, { jobId, reply: "" });
      return { outcome: "accepted" as const, jobId };
    }),
    finalize: vi.fn(async (input) => {
      book.reserved -= 1;
      book.spent += 1;
      if (input.reply) {
        turns.push({ reply: input.reply });
        for (const [key, value] of book.replays) {
          if (value.jobId === input.jobId) book.replays.set(key, { ...value, reply: input.reply });
        }
      }
    }),
    history: vi.fn(async () => []),
  };
}

function rewriteStore(overrides: Partial<RewriteStore> = {}): RewriteStore {
  return {
    begin: vi.fn().mockResolvedValue({
      outcome: "accepted",
      proposalJobId: "00000000-0000-4000-8000-000000000032",
    }),
    complete: vi.fn().mockResolvedValue(undefined),
    apply: vi.fn(),
    ...overrides,
  };
}

function turnInput(document: CarouselDocument, overrides: Record<string, unknown> = {}) {
  return {
    ownerId: OWNER_ID,
    projectId: PROJECT_ID,
    projectRevision: 3,
    document,
    message: "Make the second slide punchier.",
    focusSlideId: null,
    idempotencyKey: "copilot-operation-0001",
    hashSecret: "test-only-copilot-hmac-secret",
    rewriteStore: rewriteStore(),
    ...overrides,
  } as Parameters<typeof runCopilotTurn>[0];
}

describe("T097 copilot turn billing", () => {
  it("keeps reserved + spent within the limit across several turns", async () => {
    const document = await fixture();
    const book = ledger(5);
    const store = ledgerStore(book);
    const generateStructured = vi.fn(async () => {
      // 模型调用发生时，这一轮的预留必须已经在账上。
      expect(book.reserved).toBe(1);
      expect(book.reserved + book.spent).toBeLessThanOrEqual(book.limit);
      return { reply: "Try a sharper verb." };
    });
    const ai = { generateStructured };

    for (let turn = 1; turn <= 3; turn += 1) {
      const result = await runCopilotTurn(
        turnInput(document, { ai, store, idempotencyKey: `copilot-operation-000${turn}` }),
      );
      expect(result.reply).toBe("Try a sharper verb.");
      expect(result.proposal).toBeNull();
      expect(book.reserved + book.spent).toBeLessThanOrEqual(book.limit);
    }

    expect(generateStructured).toHaveBeenCalledTimes(3);
    // 三轮跑完预留全部归还，只剩已结算的三个单位。
    expect(book).toMatchObject({ reserved: 0, spent: 3 });
  });

  it("rejects a turn once the budget is gone without calling the model", async () => {
    const document = await fixture();
    const book = ledger(1);
    const store = ledgerStore(book);
    const generateStructured = vi.fn().mockResolvedValue({ reply: "ok" });
    const ai = { generateStructured };

    await runCopilotTurn(turnInput(document, { ai, store, idempotencyKey: "copilot-operation-0001" }));
    expect(generateStructured).toHaveBeenCalledTimes(1);

    const rejected = await runCopilotTurn(
      turnInput(document, { ai, store, idempotencyKey: "copilot-operation-0002" }),
    ).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(RewriteError);
    expect(rejected).toMatchObject({ code: "BUDGET_EXCEEDED", status: 429 });
    // 被拒绝那一轮**一个 token 都没烧**，也没有留下悬空预留。
    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(book).toMatchObject({ reserved: 0, spent: 1 });
  });

  it("replays a duplicate idempotency key without charging or calling the model twice", async () => {
    const document = await fixture();
    const book = ledger(5);
    const store = ledgerStore(book);
    const generateStructured = vi.fn().mockResolvedValue({ reply: "Lead with the outcome." });
    const ai = { generateStructured };

    const first = await runCopilotTurn(turnInput(document, { ai, store }));
    const replay = await runCopilotTurn(turnInput(document, { ai, store }));

    expect(replay.jobId).toBe(first.jobId);
    expect(replay.reply).toBe("Lead with the outcome.");
    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(book).toMatchObject({ reserved: 0, spent: 1 });
  });

  it("builds the proposal from the reply text instead of asking the model twice", async () => {
    const document = await fixture();
    const slide = document.slides[1];
    const book = ledger(5);
    const store = ledgerStore(book);
    const generateStructured = vi.fn().mockResolvedValue({
      reply: "Here is a tighter title.",
      edit: { slideId: slide.id, field: "title", after: "Ship faster, argue less" },
    });
    const proposals = rewriteStore();

    const result = await runCopilotTurn(
      turnInput(document, { ai: { generateStructured }, store, rewriteStore: proposals }),
    );

    expect(result.proposal).toMatchObject({
      proposalJobId: "00000000-0000-4000-8000-000000000032",
      slideId: slide.id,
      field: "title",
      before: slide.title,
      after: "Ship faster, argue less",
    });
    // 一轮带改动的对话是 1 次模型调用 + 2 个任务（对话 + 候选），不是 2 次模型调用。
    expect(generateStructured).toHaveBeenCalledTimes(1);
    expect(proposals.begin).toHaveBeenCalledTimes(1);
    expect(store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ proposalJobId: "00000000-0000-4000-8000-000000000032", errorCode: null }),
    );
  });

  it("names slide fields exactly as the rewrite vocabulary does", async () => {
    // 模型只会照抄上下文里的键名。这里曾经是 `slideTitle`，于是模型回 `slideTitle`，
    // createRewriteProposal 认不出来、抛错、被 catch 成「这一轮没有提议」——
    // 界面上就是答了话却没有可应用的改动。守住键名，就守住了整条提议链路。
    const document = await fixture();
    const book = ledger(5);
    const store = ledgerStore(book);
    let seenSlide: Record<string, unknown> | undefined;
    const generateStructured = vi.fn(async (request: { input: string }) => {
      const context = JSON.parse(request.input) as {
        project: { slides: Record<string, unknown>[] };
      };
      seenSlide = context.project.slides[0];
      return { reply: "ok" };
    });

    await runCopilotTurn(
      turnInput(document, { ai: { generateStructured }, store }),
    );

    expect(Object.keys(seenSlide ?? {})).toContain("title");
    expect(Object.keys(seenSlide ?? {})).not.toContain("slideTitle");
    // body 块自带 `body:N`，与 RewriteField 的模板字面量同形。
    const body = (seenSlide?.body ?? []) as { field: string }[];
    for (const block of body) expect(block.field).toMatch(/^body:\d+$/);
  });

  it("settles the measured cost before finalizing, on both the success and the failure path", async () => {
    // 顺序是有代价的：server_finalize_copilot_turn 先试精确核销，而精确核销只在尝试行
    // 已结算时成立。反过来先 finalize 再结算，账面上看不出任何异常——任务 succeeded、
    // 额度也归还了——但那 25,000 µUSD 的保守预留永远不释放。T099 实测撞到过，见
    // docs/acceptance/assistant.md。这条用例守的就是这个先后。
    const document = await fixture();
    const order: string[] = [];
    const settleUsage = vi.fn(async () => {
      order.push("settle");
    });

    const book = ledger(5);
    const store = ledgerStore(book);
    const originalFinalize = store.finalize;
    const tracked: CopilotStore = {
      ...store,
      finalize: vi.fn(async (finalizeInput) => {
        order.push("finalize");
        await originalFinalize(finalizeInput);
      }),
    };

    await runCopilotTurn(
      turnInput(document, {
        ai: { generateStructured: vi.fn().mockResolvedValue({ reply: "ok" }) },
        store: tracked,
        settleUsage,
      }),
    );
    expect(order).toEqual(["settle", "finalize"]);

    const failed = await runCopilotTurn(
      turnInput(document, {
        ai: { generateStructured: vi.fn().mockRejectedValue(new Error("upstream reset")) },
        store: tracked,
        settleUsage,
        idempotencyKey: "copilot-operation-0002",
      }),
    ).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(RewriteError);
    expect(order).toEqual(["settle", "finalize", "settle", "finalize"]);
  });

  it("finalizes even when settling the cost throws", async () => {
    // 记账失败不能把预留卡死：收尾照跑，退回 unknown 的保守口径。
    const document = await fixture();
    const book = ledger(5);
    const store = ledgerStore(book);

    const result = await runCopilotTurn(
      turnInput(document, {
        ai: { generateStructured: vi.fn().mockResolvedValue({ reply: "ok" }) },
        store,
        settleUsage: vi.fn().mockRejectedValue(new Error("settlement rpc down")),
      }),
    );

    expect(result.reply).toBe("ok");
    expect(store.finalize).toHaveBeenCalledTimes(1);
    expect(book).toMatchObject({ reserved: 0, spent: 1 });
  });

  it("keeps the answer when the proposal cannot be built", async () => {
    const document = await fixture();
    const slide = document.slides[1];
    const book = ledger(5);
    const store = ledgerStore(book);
    const generateStructured = vi.fn().mockResolvedValue({
      reply: "Here is a tighter title.",
      edit: { slideId: slide.id, field: "title", after: "Ship faster, argue less" },
    });
    const proposals = rewriteStore({
      begin: vi.fn().mockResolvedValue({ outcome: "quota_exceeded" }),
    });

    const result = await runCopilotTurn(
      turnInput(document, { ai: { generateStructured }, store, rewriteStore: proposals }),
    );

    expect(result.reply).toBe("Here is a tighter title.");
    expect(result.proposal).toBeNull();
    expect(book).toMatchObject({ reserved: 0, spent: 1 });
  });

  it("settles a failed provider call and refuses an over-long question before reserving", async () => {
    const document = await fixture();
    const book = ledger(5);
    const store = ledgerStore(book);
    const failing = {
      generateStructured: vi.fn().mockRejectedValue(new Error("upstream reset")),
    };

    const failed = await runCopilotTurn(
      turnInput(document, { ai: failing, store }),
    ).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(RewriteError);
    expect(store.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "PROVIDER_FAILED", reply: null }),
    );
    expect(book.reserved).toBe(0);

    const tooLong = await runCopilotTurn(
      turnInput(document, {
        ai: failing,
        store,
        message: "x".repeat(COPILOT_MESSAGE_MAX_LENGTH + 1),
        idempotencyKey: "copilot-operation-0002",
      }),
    ).catch((error: unknown) => error);
    expect(tooLong).toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    // 超长问题在预留之前就被挡下，账上不留痕迹。
    expect(store.begin).toHaveBeenCalledTimes(1);
  });
});
