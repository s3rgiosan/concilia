import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  onClose: () => void;
  children: ReactNode;
  width?: string;
  minWidth?: string;
  maxWidth?: string;
}

export function Drawer({ onClose, children, width = 'w-[480px]', minWidth = 'min-w-[320px]', maxWidth = '' }: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} aria-hidden="true" />
      <div className={`fixed top-0 right-0 z-50 h-screen ${width} ${minWidth} ${maxWidth} flex flex-col bg-base-100 border-l border-base-200 shadow-2xl`}>
        {children}
      </div>
    </>,
    document.body,
  );
}
