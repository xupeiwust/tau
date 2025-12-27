import { Link } from 'react-router';
import subprocessors from '#routes/legal.subprocessors/subprocessors.txt?raw';
import { Button } from '#components/ui/button.js';
import { markdownHeaderAnchorLinkComponents } from '#components/markdown/header-anchor-link.js';
import { MarkdownViewer } from '#components/markdown/markdown-viewer.js';
import type { Handle } from '#types/matches.types.js';

export const handle: Handle = {
  breadcrumb() {
    return (
      <Button asChild variant="ghost">
        <Link to="/legal/subprocessors">Sub-processors</Link>
      </Button>
    );
  },
};

export default function Subprocessors(): React.JSX.Element {
  return (
    <MarkdownViewer isStreaming={false} components={markdownHeaderAnchorLinkComponents}>
      {subprocessors}
    </MarkdownViewer>
  );
}
