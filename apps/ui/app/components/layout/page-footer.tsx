import { useState } from 'react';
import { Link } from 'react-router';
import { Tau } from '#components/icons/tau.js';
import { metaConfig } from '#constants/meta.constants.js';
import { CookiePreferencesDialog } from '#components/cookie-consent.js';
import { cn } from '#utils/ui.utils.js';

const navigationLinks = [
  { label: 'Home', href: '/' },
  { label: 'Docs', href: '/docs' },
];

type PageFooterProps = {
  /** When true, applies sidebar margin for floating sidebar routes */
  readonly enableFloatingSidebar?: boolean;
};

export function PageFooter({ enableFloatingSidebar = false }: PageFooterProps): React.JSX.Element {
  const [isCookieDialogOpen, setIsCookieDialogOpen] = useState(false);

  return (
    <footer
      className={cn(
        'shrink-0 border-t border-neutral/20 bg-background transition-[margin] duration-200 ease-linear',
        enableFloatingSidebar && 'md:ml-[calc(var(--sidebar-width-current)-var(--spacing)*2)]',
      )}
    >
      <div className="container mx-auto flex h-10 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-6">
          <Link to="/" className="text-foreground transition-colors hover:text-foreground/80">
            <Tau className="size-6 text-primary" />
          </Link>
          <nav className="flex items-center gap-4">
            {navigationLinks.map((link) => (
              <Link
                key={link.href}
                to={link.href}
                className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                {link.label}
              </Link>
            ))}
            <button
              type="button"
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                setIsCookieDialogOpen(true);
              }}
            >
              Cookies
            </button>
            <a
              href={`mailto:${metaConfig.salesEmail}`}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              Contact
            </a>
          </nav>
        </div>
      </div>

      <CookiePreferencesDialog isOpen={isCookieDialogOpen} onOpenChange={setIsCookieDialogOpen} />
    </footer>
  );
}
