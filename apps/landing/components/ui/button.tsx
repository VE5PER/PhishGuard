import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-semibold transition-all duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-shield/50 disabled:pointer-events-none disabled:opacity-40 select-none",
  {
    variants: {
      variant: {
        default:
          "bg-shield text-ink-950 font-bold hover:brightness-105 active:brightness-95",
        destructive:
          "bg-quarantine text-white shadow-md shadow-quarantine/20 hover:brightness-105 active:brightness-95",
        outline:
          "border border-white/10 bg-ink-900/80 text-white hover:border-white/20 hover:bg-ink-800",
        secondary:
          "bg-white/10 text-white hover:bg-white/15 active:bg-white/20",
        ghost:
          "text-white/70 hover:bg-white/5 hover:text-white",
        link: "text-shield underline-offset-4 hover:underline",
        cyber:
          "bg-white text-ink-950 font-bold shadow-lg shadow-white/10 hover:bg-white/90 active:brightness-90",
        tactical:
          "border border-shield/40 bg-shield/10 text-shield hover:bg-shield/20 shadow-sm",
      },
      size: {
        default: "h-11 px-5 py-2.5",
        sm: "h-9 rounded-lg px-3 text-xs",
        lg: "h-13 rounded-2xl px-7 text-base font-bold",
        icon: "h-10 w-10 rounded-xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
