import type { ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import type { ButtonProps } from 'yahha-ui';

// Yahha Button is a native button. Keep links as anchors so routing, new tabs
// and the existing unsaved-change guard work, sharing Yahha's control tokens.
export function ActionLink({ variant = 'secondary', size = 'md', startIcon, className, children, ...props }: LinkProps & {
  variant?: ButtonProps['variant'];
  size?: ButtonProps['size'];
  startIcon?: ReactNode;
}) {
  return <Link {...props} className={['action-link', 'kimi-link-button', 'button', 'button-'+variant, 'button-'+size, className].filter(Boolean).join(' ')} data-variant={variant} data-appearance={variant==='primary'?'soft':undefined} data-size={size}>
    {startIcon && <span className="action-link-icon" aria-hidden="true">{startIcon}</span>}{children}
  </Link>;
}
