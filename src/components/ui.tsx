import type { ComponentPropsWithRef } from "react";

type ButtonProps = ComponentPropsWithRef<"button"> & {
  iconOnly?: boolean;
  size?: "default" | "small";
  variant?: "primary" | "secondary" | "ghost" | "danger";
};

type DialogProps = Omit<
  ComponentPropsWithRef<"div">,
  "aria-labelledby" | "aria-modal" | "role"
> & {
  labelledBy: string;
  scrimClassName?: string;
};

function classNames(...names: Array<string | false | undefined>): string {
  return names.filter(Boolean).join(" ");
}

export function Button({
  className,
  iconOnly = false,
  size = "default",
  type = "button",
  variant = "primary",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={classNames(
        "btn",
        `btn-${variant}`,
        size === "small" && "btn-sm",
        iconOnly && "btn-icon",
        className,
      )}
      {...props}
    />
  );
}

export function Panel({ className, ...props }: ComponentPropsWithRef<"section">) {
  return <section className={classNames("panel", className)} {...props} />;
}

export function PanelHeader({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div className={classNames("panel-head", className)} {...props} />;
}

export function PanelBody({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div className={classNames("panel-body", className)} {...props} />;
}

export function Dialog({
  children,
  className,
  hidden,
  labelledBy,
  scrimClassName,
  tabIndex = -1,
  ...props
}: DialogProps) {
  return (
    <div className={classNames("scrim", scrimClassName)} hidden={hidden}>
      <div
        className={classNames("dialog", className)}
        {...props}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={tabIndex}
      >
        {children}
      </div>
    </div>
  );
}

export function DialogHeader({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div className={classNames("dialog-head", className)} {...props} />;
}

export function DialogBody({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div className={classNames("dialog-body", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div className={classNames("dialog-foot", className)} {...props} />;
}
