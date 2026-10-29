import { Component, type ButtonHTMLAttributes, type ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { ChevronLeft, Minus, Plus } from 'lucide-preact';
import { engine } from '../audio/engine';
import { clock } from '../lib/format';
import { reportError } from '../lib/log';

export const ICON = { size: 20, strokeWidth: 1.75, 'aria-hidden': true } as const;

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'quiet';
  size?: 'lg' | 'md' | 'sm';
};

export function Button({ variant = 'secondary', size = 'md', class: cls, children, ...rest }: ButtonProps) {
  return (
    <button type="button" class={`btn btn-${variant} btn-${size} ${cls ?? ''}`} {...rest}>
      {children}
    </button>
  );
}

export function IconButton({
  label,
  class: cls,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" class={`icon-btn ${cls ?? ''}`} aria-label={label} title={label} {...rest}>
      {children}
    </button>
  );
}

export function TopBar({ title, onBack, right }: { title?: string; onBack: () => void; right?: ComponentChildren }) {
  return (
    <header class="topbar">
      <button type="button" class="topbar-back" onClick={onBack}>
        <ChevronLeft {...ICON} />
        <span>Меню</span>
      </button>
      {title && <h1 class="topbar-title">{title}</h1>}
      <div class="topbar-right">{right}</div>
    </header>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: ComponentChildren;
}) {
  return (
    <label class="row switch-row">
      <span class="row-text">
        <span class="row-label">{label}</span>
        {hint && <span class="row-hint">{hint}</span>}
      </span>
      <input type="checkbox" role="switch" class="switch" checked={checked} onChange={(e) => onChange(e.currentTarget.checked)} />
    </label>
  );
}

export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  unit,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
  label: string;
  unit: string;
  disabled?: boolean;
}) {
  const set = (v: number) => onChange(Math.min(max, Math.max(min, v)));
  return (
    <div class={`stepper ${disabled ? 'is-disabled' : ''}`} role="group" aria-label={label}>
      <IconButton label="Меньше" disabled={disabled || value <= min} onClick={() => set(value - 1)}>
        <Minus {...ICON} />
      </IconButton>
      <input
        type="range"
        class="stepper-range"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={`${value} ${unit}`}
        onInput={(e) => set(Number(e.currentTarget.value))}
      />
      <IconButton label="Больше" disabled={disabled || value >= max} onClick={() => set(value + 1)}>
        <Plus {...ICON} />
      </IconButton>
      <output class="stepper-value" aria-live="polite">
        {value} {unit}
      </output>
    </div>
  );
}

export function Seekbar({ fallbackDuration }: { fallbackDuration: number }) {
  const fill = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const cur = useRef<HTMLSpanElement>(null);
  const total = useRef<HTMLSpanElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const slider = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const status = engine.status.value;

  useEffect(() => {
    let raf = 0;
    let base = 0;
    let baseT = 0;
    let lastRaw = -1;
    let shownText = '';
    let totalText = '';
    const frame = (now: number) => {
      const d = engine.duration.value || fallbackDuration;
      const raw = engine.position;
      let shown = raw;
      if (engine.playing) {
        if (raw !== lastRaw) {
          base = raw;
          baseT = now;
          lastRaw = raw;
        }
        shown = Math.min(base + (now - baseT) / 1000, raw + 0.3);
      } else {
        lastRaw = raw;
      }
      if (drag.current !== null) shown = drag.current;
      const p = d > 0 ? Math.min(1, Math.max(0, shown / d)) : 0;
      if (fill.current) fill.current.style.transform = `scaleX(${p})`;
      if (thumb.current) thumb.current.style.transform = `translateX(${p * (track.current?.clientWidth ?? 0)}px)`;
      const t = clock(shown);
      if (t !== shownText && cur.current) {
        shownText = t;
        cur.current.textContent = t;
      }
      const tt = clock(d);
      if (tt !== totalText && total.current) {
        totalText = tt;
        total.current.textContent = tt;
      }
      if (slider.current) {
        slider.current.setAttribute('aria-valuenow', String(Math.floor(shown)));
        slider.current.setAttribute('aria-valuemax', String(Math.floor(d)));
        slider.current.setAttribute('aria-valuetext', `${t} из ${tt}`);
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [fallbackDuration]);

  const at = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    const d = engine.duration.value || fallbackDuration;
    if (!r || r.width === 0) return 0;
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * d;
  };

  const onDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = at(e.clientX);
  };
  const onMove = (e: PointerEvent) => {
    if (drag.current !== null) drag.current = at(e.clientX);
  };
  const onUp = (e: PointerEvent) => {
    if (drag.current === null) return;
    const t = at(e.clientX);
    drag.current = null;
    engine.seek(t);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 5;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') engine.seek(engine.position - step);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') engine.seek(engine.position + step);
    else if (e.key === 'Home') engine.seek(0);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const loading = status === 'loading';
  return (
    <div class={`seek ${loading ? 'is-loading' : ''}`}>
      <div
        ref={slider}
        class="seek-hit"
        role="slider"
        tabIndex={0}
        aria-label="Позиция воспроизведения"
        aria-valuemin={0}
        aria-busy={loading}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={() => (drag.current = null)}
        onKeyDown={onKey}
      >
        <div ref={track} class="seek-track">
          <div ref={fill} class="seek-fill" />
          <div ref={thumb} class="seek-thumb" />
        </div>
      </div>
      <div class="seek-times">
        <span ref={cur} class="tabular">00:00</span>
        <span class="seek-state" aria-live="polite">
          {loading ? 'Загрузка…' : ''}
        </span>
        <span ref={total} class="tabular">
          {clock(fallbackDuration)}
        </span>
      </div>
    </div>
  );
}

export function Dialog({
  open,
  title,
  children,
  onClose,
  actions,
}: {
  open: boolean;
  title: string;
  children?: ComponentChildren;
  onClose: () => void;
  actions: ComponentChildren;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', '');
      }
    } else if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby="dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {open && (
        <div class="dialog-body">
          <h2 id="dialog-title" class="dialog-title">
            {title}
          </h2>
          {children && <div class="dialog-text">{children}</div>}
          <div class="dialog-actions">{actions}</div>
        </div>
      )}
    </dialog>
  );
}

interface BoundaryProps {
  children: ComponentChildren;
  onHome: () => void;
  name: string;
}

export class Boundary extends Component<BoundaryProps, { failed: boolean; key: number }> {
  override state = { failed: false, key: 0 };

  override componentDidCatch(error: unknown): void {
    reportError(error, `ui.${this.props.name}`);
    this.setState({ failed: true });
  }

  render() {
    if (this.state.failed) {
      return (
        <div class="crash" role="alert">
          <p class="crash-title">Этот раздел не открылся из-за ошибки</p>
          <p class="crash-text">Остальной сайт работает. Попробуйте ещё раз или вернитесь в меню.</p>
          <div class="crash-actions">
            <Button variant="primary" onClick={() => this.setState((s) => ({ failed: false, key: s.key + 1 }))}>
              Повторить
            </Button>
            <Button
              onClick={() => {
                this.setState((s) => ({ failed: false, key: s.key + 1 }));
                this.props.onHome();
              }}
            >
              В меню
            </Button>
          </div>
        </div>
      );
    }
    return <div key={this.state.key} class="boundary">{this.props.children}</div>;
  }
}
