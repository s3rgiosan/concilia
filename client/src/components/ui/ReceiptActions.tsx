import { Check, X, Eye, RefreshCw, RotateCcw } from 'lucide-react';
import { useTranslation } from 'react-i18next';

type Placement = 'top' | 'bottom' | 'left' | 'right';

interface BaseProps {
  onClick: () => void;
  disabled?: boolean;
  /**
   * daisyUI tooltip placement. Default `top`. Note: any ancestor with
   * `overflow: hidden|auto|scroll` will clip a CSS-pseudo-element tooltip,
   * so avoid scroll containers in the surrounding accordion content.
   */
  placement?: Placement;
}

// Literal classes — Tailwind's JIT purge strips dynamic interpolations like
// `tooltip-${placement}`, so we look up the placement modifier explicitly.
const PLACEMENT_CLASS: Record<Placement, string> = {
  top: 'tooltip-top',
  bottom: 'tooltip-bottom',
  left: 'tooltip-left',
  right: 'tooltip-right',
};

function ActionTooltip({ tip, placement = 'top', children }: { tip: string; placement?: Placement; children: React.ReactNode }) {
  return (
    <div className={`tooltip ${PLACEMENT_CLASS[placement]} flex-shrink-0`} data-tip={tip}>
      {children}
    </div>
  );
}

export function PreviewButton({ onClick, disabled, placement }: BaseProps) {
  const { t } = useTranslation();
  return (
    <ActionTooltip tip={t('review.actions.preview')} placement={placement}>
      <button type="button" onClick={onClick} disabled={disabled} className="btn btn-outline btn-xs btn-circle">
        <Eye className="w-3 h-3" />
      </button>
    </ActionTooltip>
  );
}

export function RescanButton({ onClick, disabled, placement, spinning }: BaseProps & { spinning?: boolean }) {
  const { t } = useTranslation();
  return (
    <ActionTooltip tip={t('review.actions.rescan')} placement={placement}>
      <button type="button" onClick={onClick} disabled={disabled} className="btn btn-outline btn-xs btn-circle">
        <RefreshCw className={`w-3 h-3 ${spinning ? 'animate-spin' : ''}`} />
      </button>
    </ActionTooltip>
  );
}

export function AcceptButton({ onClick, disabled, placement }: BaseProps) {
  const { t } = useTranslation();
  return (
    <ActionTooltip tip={t('review.actions.accept')} placement={placement}>
      <button type="button" onClick={onClick} disabled={disabled} className="btn btn-outline btn-success btn-xs btn-circle hover:!text-white">
        <Check className="w-3 h-3" />
      </button>
    </ActionTooltip>
  );
}

export function RejectButton({ onClick, disabled, placement }: BaseProps) {
  const { t } = useTranslation();
  return (
    <ActionTooltip tip={t('review.actions.reject')} placement={placement}>
      <button type="button" onClick={onClick} disabled={disabled} className="btn btn-outline btn-error btn-xs btn-circle">
        <X className="w-3 h-3" />
      </button>
    </ActionTooltip>
  );
}

export function AssignButton({ onClick, disabled, placement }: BaseProps) {
  const { t } = useTranslation();
  return (
    <ActionTooltip tip={t('review.actions.assign')} placement={placement}>
      <button type="button" onClick={onClick} disabled={disabled} className="btn btn-outline btn-success btn-xs btn-circle hover:!text-white">
        <Check className="w-3 h-3" />
      </button>
    </ActionTooltip>
  );
}

export function DisputeButton({ onClick, disabled, placement }: BaseProps) {
  const { t } = useTranslation();
  return (
    <ActionTooltip tip={t('review.actions.dispute')} placement={placement}>
      <button type="button" onClick={onClick} disabled={disabled} className="btn btn-outline btn-xs btn-circle">
        <RotateCcw className="w-3 h-3" />
      </button>
    </ActionTooltip>
  );
}
