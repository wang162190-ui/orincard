import type { ToolId, ToolResultType } from "../../domain/tools";

export interface ToolDefinition {
  readonly id: ToolId;
  // label 是稳定的英文标识（e2e 与日志按它断言），界面渲染走 messageKey。
  readonly label: string;
  readonly messageKey: string;
  readonly resultType: ToolResultType;
  readonly acceptsStandaloneInput: boolean;
}

export const TOOL_REGISTRY: readonly ToolDefinition[] = [
  { id: "caption", label: "Caption", messageKey: "toolCaption", resultType: "text", acceptsStandaloneInput: true },
  { id: "linkedin-post", label: "LinkedIn Post", messageKey: "toolLinkedinPost", resultType: "text", acceptsStandaloneInput: true },
  { id: "post-ideas", label: "Post Ideas", messageKey: "toolPostIdeas", resultType: "text", acceptsStandaloneInput: true },
  { id: "quote-card", label: "Quote Card", messageKey: "toolQuoteCard", resultType: "image", acceptsStandaloneInput: true },
  { id: "infographic", label: "Infographic", messageKey: "toolInfographic", resultType: "image", acceptsStandaloneInput: true },
  { id: "portrait", label: "Portrait", messageKey: "toolPortrait", resultType: "image", acceptsStandaloneInput: true },
  { id: "carousel-to-video", label: "Carousel to Video", messageKey: "toolCarouselToVideo", resultType: "video", acceptsStandaloneInput: true },
] as const;

export function getToolDefinition(id: ToolId): ToolDefinition {
  const definition = TOOL_REGISTRY.find((item) => item.id === id);
  if (!definition) throw new Error("Unknown tool.");
  return definition;
}
