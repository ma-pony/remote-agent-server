import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

const pageWidths = {
  wide: "max-w-[96rem]",
  default: "max-w-6xl",
  form: "max-w-4xl"
} as const;

export const PageContainer = ({ children, className, width = "default" }: {
  children: ReactNode;
  className?: string;
  width?: keyof typeof pageWidths;
}) => <div className={cn("mx-auto w-full px-4 py-5 sm:px-6 sm:py-7 lg:px-8 lg:py-9", pageWidths[width], className)}>{children}</div>;

export const PageHeader = ({ eyebrow, title, description, action }: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) => <header className="mb-6 flex flex-col gap-5 border-b pb-5 sm:mb-7 sm:flex-row sm:items-end sm:justify-between sm:pb-6">
  <div className="min-w-0">
    {eyebrow === undefined ? null : <p className="mb-2 font-mono text-[11px] font-semibold tracking-[0.14em] text-muted-foreground uppercase">{eyebrow}</p>}
    <h1 className="min-w-0 text-balance text-2xl font-semibold tracking-[-0.025em] [overflow-wrap:anywhere] sm:text-3xl lg:text-[2rem]">{title}</h1>
    {description === undefined ? null : <p className="mt-2 max-w-3xl text-pretty text-sm leading-6 text-muted-foreground">{description}</p>}
  </div>
  {action === undefined ? null : <div className="flex shrink-0 flex-wrap items-center gap-2 [&_[data-slot=button]]:max-sm:w-full">{action}</div>}
</header>;

export const SectionHeader = ({ title, description, action, className }: {
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) => <header className={cn("flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
  <div className="min-w-0">
    <h2 className="min-w-0 text-lg font-semibold tracking-tight [overflow-wrap:anywhere]">{title}</h2>
    {description === undefined ? null : <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">{description}</p>}
  </div>
  {action === undefined ? null : <div className="flex shrink-0 flex-wrap gap-2">{action}</div>}
</header>;

export const EmptyState = ({ icon: Icon, title, description, action, className }: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) => <section className={cn("flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed bg-card/70 px-6 py-12 text-center", className)}>
  <span className="grid size-11 place-items-center rounded-xl border bg-background text-muted-foreground"><Icon className="size-5" aria-hidden="true" /></span>
  <h2 className="mt-4 text-base font-semibold">{title}</h2>
  <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">{description}</p>
  {action === undefined ? null : <div className="mt-5">{action}</div>}
</section>;
