import type { ReactNode } from "react"

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
      <div className="max-w-2xl space-y-3">
        {eyebrow && (
          <p className="text-eyebrow font-medium tracking-(--text-eyebrow--letter-spacing) text-muted-foreground uppercase">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-title text-foreground">{title}</h1>
        {description && <p className="text-body text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </header>
  )
}

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="space-y-5">
      <div className="flex items-end justify-between gap-6">
        <div className="space-y-1">
          <h2 className="font-display text-heading">{title}</h2>
          {description && <p className="text-body text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}
