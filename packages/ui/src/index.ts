/* shadcn/ui primitives (owned copies in ./components/ui), themed by the
   preset token layer in styles.css. */

// Form controls and primitives — unique names, safe to star-export.
export * from "./components/ui/alert-dialog";
export * from "./components/ui/input";
export * from "./components/ui/label";
export * from "./components/ui/textarea";
export * from "./components/ui/select";
export * from "./components/ui/checkbox";
export * from "./components/ui/switch";
export * from "./components/ui/dropdown-menu";
export * from "./components/ui/tabs";
export * from "./components/ui/tooltip";
export * from "./components/ui/separator";
export * from "./components/ui/skeleton";
export * from "./components/ui/scroll-area";
export * from "./components/ui/popover";
export * from "./components/ui/progress";
export * from "./components/ui/avatar";
export * from "./components/ui/sheet";
export * from "./components/ui/sonner";

// Façades keep the historical @pilates/ui APIs (variant names, loading, dot,
// sizeClassName) on top of the shadcn implementations.
export { buttonVariants } from "./components/ui/button";
export { badgeVariants } from "./components/ui/badge";
export {
  Card,
  CardHeader,
  CardFooter,
  CardAction,
  CardDescription,
  CardContent,
} from "./components/ui/card";
export {
  DialogClose,
  DialogTrigger,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "./components/ui/dialog";
export * from "./components/Table";

export * from "./lib/utils";
export * from "./components/Button";
export * from "./components/Card";
export * from "./components/Badge";
export * from "./components/Dialog";
export * from "./components/Logo";
