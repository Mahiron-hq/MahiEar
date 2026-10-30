import type { ComponentChildren } from 'preact';
import { pathFor, type Route } from '../lib/routes';
import { openRoute } from '../router';

interface LinkProps {
  to: Route;
  disabled?: boolean;
  class?: string;
  onClick?: (e: MouseEvent) => void;
  children: ComponentChildren;
}

export function Link({ to, disabled, children, class: cls, onClick }: LinkProps) {
  return (
    <a
      href={pathFor(to)}
      class={`${cls ?? ''}${disabled ? ' is-disabled' : ''}`}
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        onClick?.(e);
        if (disabled) {
          e.preventDefault();
          return;
        }
        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        openRoute(to);
      }}
    >
      {children}
    </a>
  );
}

export const SOURCE_URL = 'https://github.com/Mahiron-hq/MahiEar';

export function Footer() {
  return (
    <footer class="site-footer">
      <span>Copyright 2026 Lev Burmistrov (Mahiron-hq)</span>
      <Link to={{ name: 'data' }} class="footer-link">
        О данных
      </Link>
      <a class="footer-link" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
        Открытый код
      </a>
    </footer>
  );
}
