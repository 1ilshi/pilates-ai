import * as React from "react";
import {
  Card as ShadcnCard,
  CardHeader,
  CardFooter,
  CardDescription,
  CardContent,
} from "./ui/card";
import { cn } from "../lib/utils";

export const Card = ShadcnCard;
export { CardHeader, CardFooter, CardDescription, CardContent };

/** Vega-style title: Geist Mono, tight tracking. */
export const CardTitle = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardTitle({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="card-title"
      className={cn("font-mono text-base leading-none font-semibold", className)}
      {...props}
    />
  );
});
