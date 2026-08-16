import { cn } from '@/lib/utils';
import { Loader2Icon } from 'lucide-react';

// 'ref' is omitted from the prop type because Spinner does not forward refs,
// and spreading React 19's ref type onto Loader2Icon (typed for React 18)
// causes a TS2322 cross-version incompatibility.
function Spinner({ className, ...props }: Omit<React.ComponentProps<'svg'>, 'ref'>) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn('size-4 animate-spin', className)}
      {...props}
    />
  );
}

export { Spinner };
