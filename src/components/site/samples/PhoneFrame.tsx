import type { ReactNode } from "react";

/**
 * A phone for sample messages: bezel, island, status bar, an app header, the
 * thread, a composer and a home bar. The SMS variant is a plain text-message
 * app (white, centred title, grey bubbles); the other is a chat app (cream
 * thread, dark header with an avatar). Neither borrows WhatsApp's colours or
 * logo. Decorative: the figure that holds it carries the description.
 */
export function PhoneFrame({
  title,
  variant,
  composer,
  children,
  className = "",
  bodyClassName = "",
}: {
  title: string;
  variant: "sms" | "whatsapp";
  composer: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const sms = variant === "sms";
  return (
    <div aria-hidden="true" className={`phone ${sms ? "phone-sms" : "phone-chat"} ${className}`}>
      <span className="phone-island" />
      <div className="phone-screen">
        <div className="phone-status">
          <span>10:24</span>
          <svg width="40" height="11" viewBox="0 0 40 11" fill="currentColor">
            <rect x="0" y="7" width="3" height="4" rx="0.5" />
            <rect x="5" y="5" width="3" height="6" rx="0.5" />
            <rect x="10" y="2.5" width="3" height="8.5" rx="0.5" />
            <rect x="15" y="0" width="3" height="11" rx="0.5" />
            <rect x="22" y="1" width="16" height="9" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1" />
            <rect x="24" y="3" width="10" height="5" rx="1" />
            <rect x="38.5" y="4" width="1.5" height="3" rx="0.5" />
          </svg>
        </div>
        <div className={`phone-head ${sms ? "phone-head-sms" : "phone-head-chat"}`}>
          <svg width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 2 2 8l6 6" />
          </svg>
          {sms ? null : <span className="phone-avatar">S</span>}
          <span>{title}</span>
        </div>
        <div className={`phone-body ${bodyClassName}`}>{children}</div>
        <div className="phone-composer">
          <span>{composer}</span>
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
            <circle cx="13" cy="13" r="13" fill="#454A57" />
            <path d="M13 19v-12M8 12l5-5 5 5" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span className="phone-home" />
      </div>
    </div>
  );
}
