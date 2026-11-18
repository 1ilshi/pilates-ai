import * as React from "react"
import { cn } from "cn"

const Card = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function Card({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="card"
        className={cn(
          "flex flex-col gap-6 rounded-card border border-border/70 bg-card py-6 text-card-foreground shadow-card",
          className
        )}
        {...props}
      />
    )
  }
)

const CardHeader = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function CardHeader({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="card-header"
        className={cn(
          "@container/card-header grid auto-rows-min grid-rows-[auto_auto] items-start gap-2 px-6 has-data-[slot=card-action]:grid-cols-[1fr_auto] [.border-b]:pb-6",
          className
        )}
        {...props}
      />
    )
  }
)

// v2.0.12 rendered a heading here; keep that semantic for screen readers.
const CardTitle = React.forwardRef<HTMLHeadingElement, React.ComponentProps<"h3">>(
  function CardTitle({ className, ...props }, ref) {
    return (
      <h3
        ref={ref}
        data-slot="card-title"
        className={cn(
          "font-display text-base leading-snug font-semibold tracking-tight",
          className
        )}
        {...props}
      />
    )
  }
)

const CardDescription = React.forwardRef<
  HTMLParagraphElement,
  React.ComponentProps<"p">
>(function CardDescription({ className, ...props }, ref) {
  return (
    <p
      ref={ref}
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
})

const CardAction = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function CardAction({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="card-action"
        className={cn(
          "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
          className
        )}
        {...props}
      />
    )
  }
)

const CardContent = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function CardContent({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="card-content"
        className={cn("px-6", className)}
        {...props}
      />
    )
  }
)

const CardFooter = React.forwardRef<HTMLDivElement, React.ComponentProps<"div">>(
  function CardFooter({ className, ...props }, ref) {
    return (
      <div
        ref={ref}
        data-slot="card-footer"
        className={cn("flex items-center px-6 [.border-t]:pt-6", className)}
        {...props}
      />
    )
  }
)

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
