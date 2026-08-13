import type { ReactNode } from "react";

export const PageHeader = ({ eyebrow, title, description, action }: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) => <header className="mb-8 flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-end sm:justify-between">
  <div>
    {eyebrow === undefined ? null : <p className="mb-2 font-mono text-xs font-bold tracking-[0.16em] text-muted-foreground">{eyebrow}</p>}
    <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
    {description === undefined ? null : <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>}
  </div>
  {action}
</header>;
