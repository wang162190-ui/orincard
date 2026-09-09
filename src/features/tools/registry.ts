import type { ToolId, ToolResultType } from "../../domain/tools";

export interface ToolDefinition {
  readonly id: ToolId;
  readonly label: string;
  readonly resultType: ToolResultType;
  readonly acceptsStandaloneInput: boolean;
}

export const TOOL_REGISTRY: readonly ToolDefinition[] = [
  { id: "caption", label: "Caption", resultType: "text", acceptsStandaloneInput: true },
  { id: "linkedin-post", label: "LinkedIn Post", resultType: "text", acceptsStandaloneInput: true },
  { id: "post-ideas", label: "Post Ideas", resultType: "text", acceptsStandaloneInput: true },
  { id: "quote-card", label: "Quote Card", resultType: "image", acceptsStandaloneInput: true },
  { id: "infographic", label: "Infographic", resultType: "image", acceptsStandaloneInput: true },
  { id: "portrait", label: "Portrait", resultType: "image", acceptsStandaloneInput: true },
  { id: "carousel-to-video", label: "Carousel to Video", resultType: "video", acceptsStandaloneInput: true },
] as const;

export function getToolDefinition(id: ToolId): ToolDefinition {
  const definition = TOOL_REGISTRY.find((item) => item.id === id);
  if (!definition) throw new Error("Unknown tool.");
  return definition;
}
