import {
  Children, isValidElement,
  type ButtonHTMLAttributes, type CSSProperties, type ReactElement, type ReactNode,
} from 'react';
import { AlertCircle, Check } from 'lucide-react';
import {
  Avatar as YAvatar,
  Badge as YBadge,
  Button as YButton,
  Dialog as YDialog,
  EmptyState as YEmptyState,
  Heading as YHeading,
  IconButton as YIconButton,
  Input as YInput,
  Select as YSelect,
  Tabs as YTabs,
  Text as YText,
  Textarea as YTextarea,
  CloseIcon,
  CopyIcon,
  SearchIcon,
  type SelectOption,
  type ButtonProps as YahhaButtonProps,
} from 'yahha-ui';
import { useState } from 'react';
type User = { name: string; avatar: string; color: string; avatarUrl?:string };


export const cn = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

/**
 * 共用元件轉接層：對外保留原型既有的 props，對內改用 Yahha UI 對應元件。
 * 元件庫內建簡體文案（「請選擇」「关闭弹窗」「关闭提示」）在此統一改為繁體或隱藏。
 */

export function Button({ variant = 'primary', size = 'md', loading, children, className, disabled, ...props }: Omit<YahhaButtonProps, 'variant'> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'text';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}) {
  const yahhaVariant = variant === 'danger' ? 'primary' : variant === 'text' ? 'ghost' : variant;
  return <YButton
    variant={yahhaVariant}
    appearance={variant === 'primary' || variant === 'danger' ? 'soft' : 'default'}
    destructive={variant === 'danger'}
    size={size}
    loading={loading}
    disabled={disabled || loading}
    className={cn('button', `button-${variant}`, `button-${size}`, className)}
    {...props}
  >{children}</YButton>;
}

export function IconButton({ label, children, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return <YIconButton
    aria-label={label}
    title={label}
    variant="ghost"
    size="sm"
    className={cn('icon-button', className)}
    {...props}
  >{children}</YIconButton>;
}

export function Badge({ children, tone = 'neutral', dot = false }: {
  children: ReactNode;
  tone?: 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'outline';
  dot?: boolean;
}) {
  const yahhaTone = tone === 'green' ? 'success' : ['amber', 'red', 'blue'].includes(tone) ? 'accent' : 'neutral';
  return <YBadge
    tone={yahhaTone}
    appearance={tone === 'outline' ? 'stamp' : 'default'}
    className={cn('badge', `badge-${tone}`)}
  >{dot && <span className="badge-dot" />}{children}</YBadge>;
}

export function Avatar({ user, size = 'md' }: {
  user: User;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const yahhaSize: 'sm' | 'md' | 'lg' = size === 'xl' ? 'lg' : size;
  return <YAvatar
    name={user.name}
    src={user.avatarUrl||undefined}
    size={yahhaSize}
    fallback={user.avatar}
    className={cn('avatar', `avatar-${size}`)}
    style={{ '--avatar-color': user.color } as CSSProperties}
  />;
}

/**
 * 只保留可安全對應到 YSelect（以 button 為觸發器）的原生屬性。
 * 不沿用 SelectHTMLAttributes 的事件處理器，避免 HTMLSelectElement 與 HTMLButtonElement 型別衝突。
 */
type OwnSelectProps = {
  children?: ReactNode;
  value?: string | number | readonly string[] | null;
  defaultValue?: string | number | readonly string[] | null;
  onChange?: (event: { target: { value: string } }) => void;
  label?: string;
  hint?: string;
  error?: string;
  className?: string;
  id?: string;
  name?: string;
  title?: string;
  'aria-label'?: string;
  form?: string;
  autoComplete?: string;
  required?: boolean;
  disabled?: boolean;
};

/**
 * 固定選項的單選：由 <option> 轉成 SelectOption，透過 onValueChange 轉回既有 onChange。
 * 單獨使用（篩選列）時標籤以 sr-only 隱藏；包在 Field 內則顯示欄位標籤。
 */
export function Select({
  children, value, defaultValue, onChange, label, hint, error, className,
  required, disabled, name, id, title, form, autoComplete, 'aria-label': ariaLabel,
}: OwnSelectProps) {
  const options: SelectOption[] = Children.toArray(children)
    .filter(isValidElement)
    .map((option) => {
      const p = option.props as { value?: unknown; children?: ReactNode; disabled?: boolean };
      const text = p.children;
      const fallbackValue = typeof text === 'string' || typeof text === 'number' ? String(text) : '';
      return {
        value: p.value !== undefined ? String(p.value) === '' ? '__kimi_all__' : String(p.value) : fallbackValue,
        label: text ?? (p.value !== undefined ? String(p.value) : ''),
        disabled: p.disabled,
        textValue: typeof text === 'string' ? text : undefined,
      };
    });
  const hiddenLabel = !label;
  return <YSelect
    label={label ?? ariaLabel ?? '選項'}
    options={options}
    value={value === undefined || value === null ? undefined : String(value) === '' ? '__kimi_all__' : String(value)}
    defaultValue={defaultValue === undefined || defaultValue === null ? undefined : String(defaultValue)}
    onValueChange={(next) => onChange?.({ target: { value: next === '__kimi_all__' ? '' : next ?? '' } })}
    placeholder="請選擇"
    hint={hint}
    error={error}
    required={required}
    disabled={disabled}
    name={name}
    id={id}
    title={title}
    aria-label={ariaLabel}
    form={form}
    autoComplete={autoComplete}
    className={cn('select-wrap', className, hiddenLabel && 'select-no-label')}
    classNames={{
      label: hiddenLabel ? 'sr-only' : 'yj-label',
      trigger: 'yj-trigger',
      value: 'yj-value',
      option: 'yj-option',
    }}
  />;
}

/** 欄位容器：單一原生 input / textarea / Select 直接交給對應的 Yahha 欄位元件。 */
export function Field({ label, hint, error, required, children, className }: {
  label: string; hint?: string; error?: string; required?: boolean; children: ReactNode; className?: string;
}) {
  const child = isValidElement(children) ? (children as ReactElement<any>) : null;
  const shared = { label, hint, error, required };
  if (child && child.type === 'input') {
    return <YInput {...shared} {...child.props} className={cn('yj-field', className)} />;
  }
  if (child && child.type === 'textarea') {
    return <YTextarea {...shared} {...child.props} className={cn('yj-field', className)} />;
  }
  if (child && child.type === Select) {
    return <Select
      {...(child.props as OwnSelectProps)}
      {...shared}
      className={cn(child.props.className as string | undefined, className)}
    />;
  }
  return <div className={cn('field', className)}>
    <span className="field-label">{label}{required && <span className="required">必填</span>}</span>
    {children}
    {(error || hint) && <span className={cn('field-hint', error && 'field-error')}>{error && <AlertCircle size={13} />}{error || hint}</span>}
  </div>;
}

/** 同一區域切換內容面板；原型頁面自行渲染面板，這裡只使用元件庫的標籤列與選中狀態。 */
export function Tabs({ items, value, onChange, label = '切換內容' }: {
  items: { value: string; label: string; count?: number }[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
}) {
  return <YTabs
    label={label}
    value={value}
    onValueChange={(next) => { if (next) onChange(next); }}
    appearance="ink"
    items={items.map((item) => ({
      value: item.value,
      label: <>{item.label}{item.count !== undefined && <span className="tab-count">{item.count}</span>}</>,
      content: null,
    }))}
    className="tabs"
    classNames={{ list: 'yj-tabs-list', tab: 'tab', panel: 'yj-tabs-panel' }}
  />;
}

export function PageHeader({ title, description, actions, back }: {
  title: string; description?: string; actions?: ReactNode; back?: ReactNode;
}) {
  return <header className="page-header">
    <div className="page-heading">{back}<div><YHeading level={1}>{title}</YHeading>{description && <YText size="sm" tone="muted">{description}</YText>}</div></div>
    {actions && <div className="page-actions">{actions}</div>}
  </header>;
}

/** 受控對話框；手機全螢幕、返回原活動與安全區由 styles.css 處理。 */
export function Modal({ title, description, children, onClose, footer, wide = false }: {
  title: string; description?: string; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean;
}) {
  return <YDialog
    open
    onOpenChange={(open) => { if (!open) onClose(); }}
    title={title}
    description={description}
    footer={footer}
    closeLabel="關閉對話框"
    className={cn('kimi', 'yj-dialog', wide && 'yj-dialog-wide')}
    disablePointerDismissal
  >{children}</YDialog>;
}

export function EmptyState({ title, description, action }: {
  title: string; description: string; action?: ReactNode;
}) {
  return <YEmptyState title={title} description={description} action={action} motif="paper" className="empty-state" />;
}

export function SearchInput({ value, onChange, placeholder, autoFocus, label }: {
  value: string; onChange: (value: string) => void; placeholder: string; autoFocus?: boolean; label?: string;
}) {
  return <YInput
    label={label ?? placeholder}
    type="search"
    value={value}
    onChange={(event) => onChange(event.target.value)}
    onKeyDown={(event) => { if (event.key === 'Escape' && !event.nativeEvent.isComposing && value) { event.preventDefault(); onChange(''); } }}
    placeholder={placeholder}
    autoFocus={autoFocus}
    leading={<SearchIcon size="sm" />}
    trailing={value ? <YIconButton
      aria-label="清除搜尋"
      variant="ghost"
      size="sm"
      className="icon-button"
      onClick={() => onChange('')}
    ><CloseIcon size="sm" /></YIconButton> : undefined}
    className="search-input"
    classNames={{
      label: 'sr-only',
      input: 'yj-search-input',
      inputWrapper: 'yj-search-wrap',
      leading: 'yj-search-leading',
      trailing: 'yj-search-trailing',
    }}
  />;
}

export function CopyButton({ value, label = '複製' }: { value: string; label?: string }) {
  const [message, setMessage] = useState('');
  return <><YIconButton aria-label={label} variant="ghost" size="sm" className="icon-button" onClick={async () => {
    try { await navigator.clipboard.writeText(value); setMessage('已複製。'); }
    catch { setMessage('無法自動複製，請手動複製：' + value); }
  }}><CopyIcon size="sm" /></YIconButton>{message && <span role="status">{message}</span>}</>;
}

export function CheckLine({ checked, children }: { checked: boolean; children: ReactNode }) {
  return <span className={cn('check-line', checked && 'checked')}>{checked && <Check size={13} />}{children}</span>;
}

export function formatDateTime(value: string) {
  const date = new Date(value);
  return new Intl.DateTimeFormat('zh-TW', { month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
}

export function statusTone(status: string): 'neutral' | 'green' | 'amber' | 'red' | 'blue' | 'outline' {
  if (['報名中', '正式', '出席', '已結清', '可以'].includes(status)) return 'green';
  if (['候補', '待確認', '待核對', '可能', '逾期退出申請', '遲到', '早退'].includes(status)) return 'amber';
  if (['已取消', '缺席', '已退出', '失敗'].includes(status)) return 'red';
  if (['進行中'].includes(status)) return 'blue';
  return 'neutral';
}
