import { SlideRenderer, type SlideRenderInput } from "@/render/slide";

/** Uses the export renderer: previews never maintain a second layout implementation. */
export function SlidePreview({ input, className = "" }: { readonly input: SlideRenderInput; readonly className?: string }) {
  return <div className={`slide-preview ${className}`}><SlideRenderer input={input} /></div>;
}
