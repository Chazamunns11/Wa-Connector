import type { ReactNode } from "react";

/**
 * A phone for sample messages: bezel, island, status bar, an app header, the
 * thread, a composer and a home bar. The SMS variant is a plain text-message
 * app (white thread, centred contact, grey bubble). The chat variant is a
 * WhatsApp-style chat: dark header with an avatar and call icons, a wallpaper
 * pattern behind the thread, and a pill composer. It borrows none of
 * WhatsApp's colours or its logo. Decorative: the figure that holds it
 * carries the description.
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
  const initial = title.slice(0, 1).toUpperCase();
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
        {sms ? (
          <div className="phone-head phone-head-sms">
            <svg className="phone-back" width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2 2 8l6 6" />
            </svg>
            <span className="phone-avatar phone-avatar-sms">{initial}</span>
            <span className="phone-title">{title}</span>
          </div>
        ) : (
          <div className="phone-head phone-head-chat">
            <svg className="phone-back" width="10" height="16" viewBox="0 0 10 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 2 2 8l6 6" />
            </svg>
            <span className="phone-avatar">{initial}</span>
            <span className="phone-who">
              <span className="phone-title">{title}</span>
              <span className="phone-sub">online</span>
            </span>
            <svg className="phone-tools" width="46" height="16" viewBox="0 0 46 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="3" width="10" height="10" rx="2" />
              <path d="m11 7 4-2.5v7L11 9" />
              <path d="M30 3.5c0 5.5 4 9.5 9.5 9.5l1.3-2.6-2.7-1.4-1 1.1c-1.3-.6-2.3-1.7-2.9-2.9l1.1-1-1.4-2.7z" />
            </svg>
          </div>
        )}
        <div className={`phone-body ${sms ? "" : "chat-wallpaper"} ${bodyClassName}`}>{children}</div>
        {sms ? (
          <div className="phone-composer phone-composer-sms">
            <span className="phone-plus">+</span>
            <span className="phone-field">{composer}</span>
            <svg width="12" height="16" viewBox="0 0 12 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <rect x="3.5" y="1" width="5" height="9" rx="2.5" />
              <path d="M1 8a5 5 0 0 0 10 0M6 13v2" />
            </svg>
          </div>
        ) : (
          <div className="phone-composer phone-composer-chat">
            <span className="phone-field">
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M5.2 9.6c.7 1.1 1.7 1.7 2.8 1.7s2.1-.6 2.8-1.7M5.8 6h.01M10.2 6h.01" />
              </svg>
              <span>{composer}</span>
            </span>
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none" className="phone-mic">
              <circle cx="13" cy="13" r="13" fill="#2D3345" />
              <rect x="10.5" y="6.5" width="5" height="9" rx="2.5" fill="#fff" />
              <path d="M8.3 12.5a4.7 4.7 0 0 0 9.4 0M13 17.5v2.3" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        )}
        <span className="phone-home" />
      </div>
    </div>
  );
}
