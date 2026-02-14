import type { StateFrom } from 'xstate';
import { ChatInterfaceGraphicsMeasure } from '#routes/builds_.$id/chat-interface-graphics-measure.js';
import { ChatInterfaceGraphicsSectionView } from '#routes/builds_.$id/chat-interface-graphics-section-view.js';
import { GraphicsPanel } from '#routes/builds_.$id/chat-interface-graphics-panel.js';
import type { graphicsMachine } from '#machines/graphics.machine.js';
import { cn } from '#utils/ui.utils.js';
import { useGraphicsSelector } from '#hooks/use-graphics.js';

type ChatInterfaceGraphicsProps = {
  readonly className?: string;
};

const titleFromState = (state: StateFrom<typeof graphicsMachine>): string => {
  switch (true) {
    case state.matches({ operational: 'section-view' }): {
      return 'Section View';
    }
  }

  if (state.matches({ operational: 'measure' })) {
    return 'Measure';
  }

  return 'Unknown';
};

export function ChatInterfaceGraphics({ className }: ChatInterfaceGraphicsProps): React.ReactNode {
  const graphicsState = useGraphicsSelector((state) => state);
  if (graphicsState.matches({ operational: 'ready' })) {
    return null;
  }

  const title = titleFromState(graphicsState);

  return (
    <GraphicsPanel title={title} className={cn('w-80', className)}>
      <ChatInterfaceGraphicsInner />
    </GraphicsPanel>
  );
}

function ChatInterfaceGraphicsInner(): React.JSX.Element {
  const graphicsState = useGraphicsSelector((state) => state);

  switch (true) {
    case graphicsState.matches({ operational: 'section-view' }): {
      return <ChatInterfaceGraphicsSectionView />;
    }

    case graphicsState.matches({ operational: 'measure' }): {
      return <ChatInterfaceGraphicsMeasure />;
    }

    default: {
      return <div>Unknown graphics state</div>;
    }
  }
}
