import "./Banner.css";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Icon, type IconName } from "./Icon";

export interface BannerProps {
  tone: "info" | "success" | "warn" | "error";
  icon: IconName;
  /** Shows a dismiss button that runs this. */
  onDismiss?: () => void;
  /** The dismiss button's label; "Dismiss" by default. */
  dismissLabel?: string;
  /** Buttons after the message, before the dismiss button. */
  actions?: ReactNode;
  className?: string;
  /** "alert" for errors the user must notice; "status" otherwise. */
  role?: "status" | "alert";
  children: ReactNode;
}

/** A short message with an icon, optional actions and an optional dismiss button. */
export function Banner({ tone, icon, onDismiss, dismissLabel, actions, className, role = "status", children }: BannerProps) {
  const { t } = useTranslation();
  const label = dismissLabel ?? t("common.dismiss");
  const classes = ["banner", `banner--${tone}`, className].filter(Boolean).join(" ");
  return (
    <div className={classes} role={role}>
      <Icon name={icon} size={14} className={tone === "success" ? "banner__icon--success" : undefined} />
      <span className="grow">{children}</span>
      {actions}
      {onDismiss ? (
        <button type="button" className="icon" aria-label={label} title={label} onClick={onDismiss}>
          <Icon name="xmark" size={12} />
        </button>
      ) : null}
    </div>
  );
}
