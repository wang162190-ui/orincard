"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";
import type { CarouselDocument } from "../../domain/document";
import { Button } from "../../components/ui";

type Slide = CarouselDocument["slides"][number];

export interface SlidePanelProps {
  readonly slide: Slide;
  readonly index: number;
  readonly selected: boolean;
  readonly canDelete: boolean;
  readonly canDuplicate: boolean;
  readonly canMoveDown: boolean;
  readonly canMoveUp: boolean;
  readonly onDelete: () => void;
  readonly onDuplicate: () => void;
  readonly onMoveDown: () => void;
  readonly onMoveUp: () => void;
  readonly onSelect: () => void;
}

export function SlidePanel({
  slide,
  index,
  selected,
  canDelete,
  canDuplicate,
  canMoveDown,
  canMoveUp,
  onDelete,
  onDuplicate,
  onMoveDown,
  onMoveUp,
  onSelect,
}: SlidePanelProps) {
  const sortable = useSortable({
    id: slide.id,
    disabled: slide.role !== "content",
  });
  const slideNumber = index + 1;
  const title = slide.title?.trim() || "Untitled slide";
  const style: CSSProperties = {
    alignItems: "center",
    background: selected ? "var(--sig-yellow)" : "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    display: "grid",
    flex: "0 0 248px",
    gap: 8,
    gridTemplateColumns: "auto minmax(0, 1fr) auto",
    opacity: sortable.isDragging ? 0.55 : 1,
    padding: 8,
    transform: CSS.Transform.toString(sortable.transform),
    transition: sortable.transition,
  };

  return (
    <li
      ref={sortable.setNodeRef}
      data-editor-slide-id={slide.id}
      style={style}
    >
      <Button
        {...sortable.attributes}
        {...sortable.listeners}
        aria-label={`Drag slide ${slideNumber}`}
        disabled={slide.role !== "content"}
        iconOnly
        size="small"
        variant="ghost"
      >
        ↕
      </Button>

      <button
        aria-label={`Slide ${slideNumber}: ${title}`}
        aria-pressed={selected}
        onClick={onSelect}
        style={{
          background: "transparent",
          border: 0,
          color: "inherit",
          minWidth: 0,
          padding: "4px 2px",
          textAlign: "left",
        }}
        type="button"
      >
        <span className="label">Slide {slideNumber} · {slide.role}</span>
        <span
          style={{
            display: "block",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
      </button>

      <div className="row" style={{ gap: 2 }}>
        <Button
          aria-label={`Move slide ${slideNumber} up`}
          disabled={!canMoveUp}
          iconOnly
          onClick={onMoveUp}
          size="small"
          variant="ghost"
        >
          ↑
        </Button>
        <Button
          aria-label={`Move slide ${slideNumber} down`}
          disabled={!canMoveDown}
          iconOnly
          onClick={onMoveDown}
          size="small"
          variant="ghost"
        >
          ↓
        </Button>
        <Button
          aria-label={`Duplicate slide ${slideNumber}`}
          disabled={!canDuplicate}
          iconOnly
          onClick={onDuplicate}
          size="small"
          variant="ghost"
        >
          ⧉
        </Button>
        <Button
          aria-label={`Delete slide ${slideNumber}`}
          disabled={!canDelete}
          iconOnly
          onClick={onDelete}
          size="small"
          variant="danger"
        >
          ×
        </Button>
      </div>
    </li>
  );
}
