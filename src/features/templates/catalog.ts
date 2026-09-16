import previews from "../../../content/template-previews.json";

/**
 * 画廊与选择器里分类的展示顺序，也是**唯一**一份合法分类清单。
 *
 * `content/templates.json` 的 `category` 是手写字符串，拼错一个字母不会有任何报错——
 * 模板只是会安静地掉进一个没人点的新分组里。所以这张表是显式的，并由
 * `tests/unit/templates-content.test.ts` 断言每个模板的 category 都在其中；
 * 加新分类必须同时加这里的一项和两份词条里的一条，少一样测试就红。
 */
export const CATEGORY_ORDER = [
  "Modern",
  "Minimal",
  "Bold",
  "Playful",
  "Education",
  "Launch",
  "Story",
] as const;

export type TemplateCategory = (typeof CATEGORY_ORDER)[number];

/**
 * 画廊与选择器真正渲染的那几个字段。
 *
 * 刻意只有这几个：整份 templates.json 带着 14 套完整的 `CarouselDocument`，把它直接
 * 传过客户端边界就是把几十 KB 从不显示的正文塞进首屏 payload。要完整文档的地方
 * （`/templates/[slug]`）自己去读 JSON。
 */
export interface TemplateCard {
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly platform: string;
  readonly templateId: string;
  readonly slideCount: number;
  readonly hasImages?: boolean;
  readonly thumbnail?: string;
  readonly previews?: readonly string[];
  readonly previewVersion?: string;
}

export const templateCards: readonly TemplateCard[] = previews;

/** 按 `CATEGORY_ORDER` 分组，空分类不出现（分类导航不显示点不动的按钮）。 */
export function groupByCategory(
  cards: readonly TemplateCard[],
): readonly { readonly category: TemplateCategory; readonly items: readonly TemplateCard[] }[] {
  return CATEGORY_ORDER.map((category) => ({
    category,
    items: cards.filter((card) => card.category === category),
  })).filter((group) => group.items.length > 0);
}
