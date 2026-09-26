import { Loader2Icon, type LucideProps } from "lucide-react"

import { cn } from "@/lib/utils"

type SpinnerProps = LucideProps & { className?: string }

function Spinner({ className, ...props }: SpinnerProps) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  )
}

export { Spinner }
