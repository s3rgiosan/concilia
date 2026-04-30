import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Drawer } from './Drawer';

interface Props {
  url: string;
  filename: string;
  onClose: () => void;
  header?: React.ReactNode;
}

export function SidePanel({ url, filename, onClose, header }: Props) {
  const { t } = useTranslation();
  const isPdf = url.toLowerCase().includes('.pdf') || url.toLowerCase().endsWith('/pdf');
  const ext = url.split('.').pop()?.toLowerCase();
  const isImage = ext === 'jpg' || ext === 'jpeg' || ext === 'png';

  return (
    <Drawer onClose={onClose} width="w-[55vw]" minWidth="min-w-[400px]" maxWidth="max-w-[860px]">
      <div className="flex items-center justify-end px-4 py-2 border-b border-base-200 flex-shrink-0">
        <button onClick={onClose} className="btn btn-ghost btn-xs btn-circle" aria-label={t('common.cancel')}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {header && (
        <div className="flex-shrink-0 border-b border-base-200 bg-base-200/40 px-4 py-3">
          {header}
        </div>
      )}

      <div className="flex-1 overflow-hidden">
        {isPdf && <iframe src={`${url}#navpanes=0`} title={filename} className="w-full h-full border-0" />}
        {isImage && (
          <div className="h-full overflow-auto p-4">
            <img src={url} alt={filename} className="w-full h-auto rounded-box" />
          </div>
        )}
        {!isPdf && !isImage && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-base-content/60">
            <p className="text-sm">{t('preview.unavailable')}</p>
            <a href={url} target="_blank" rel="noreferrer" className="link link-primary text-sm font-medium">
              {t('preview.openNewTab')}
            </a>
          </div>
        )}
      </div>
    </Drawer>
  );
}
