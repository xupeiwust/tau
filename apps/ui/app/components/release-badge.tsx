import { Badge } from '#components/ui/badge.js';
import { Tooltip, TooltipContent, TooltipTrigger } from '#components/ui/tooltip.js';

export function ReleaseBadge(): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge className='h-6 cursor-help border-yellow/30 bg-yellow/10 text-xs font-normal text-yellow dark:text-yellow/70'>
          BETA
        </Badge>
      </TooltipTrigger>
      <TooltipContent className='max-w-42 text-balance'>
        <p className='font-semibold'>Tau is in Beta</p>
        <p className='mt-1 text-white/80'>Some features may be unstable and change without notice.</p>
      </TooltipContent>
    </Tooltip>
  );
}
