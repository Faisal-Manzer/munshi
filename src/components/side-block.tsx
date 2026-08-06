"use client";

/** Sidebar tile shared by Book and Plan: uppercase title, optional action
 * beside it, total on the right, divided rows below. */
export function SideBlock({
  title, total, action, children,
}: {
  title: string;
  total?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-rule bg-paper-raised">
      <div className="flex items-center justify-between gap-2 px-3 pt-2 pb-1">
        <span className="flex items-center gap-1.5">
          <p className="text-[10px] uppercase tracking-[0.15em] text-ink-faint">{title}</p>
          {action}
        </span>
        {total}
      </div>
      <div className="divide-y divide-rule/60 pb-1">{children}</div>
    </div>
  );
}
