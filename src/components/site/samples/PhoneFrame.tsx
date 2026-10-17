import type { ReactNode } from "react";

/**
 * A phone for sample messages, drawn as a real handset screenshot: bezel,
 * island, status bar, an app header, a bottom-anchored thread, a composer and
 * a home bar. Every inner size is in cqw (see .phone in globals.css), so the
 * phone is the same object at 165px and 300px wide.
 *
 * Variants: "sms" is a plain messages app (white thread, centred contact);
 * "whatsapp" and "group" are WhatsApp-style chats (Ink header, wallpaper,
 * pill composer). Neither borrows WhatsApp's colours or logo. `subline` is the
 * number (chat) or the member list (group); no presence word is ever shown.
 * Decorative: the figure that holds it carries the description.
 */
export type PhoneVariant = "sms" | "whatsapp" | "group";

function Back() {
  return (
    <svg className="phone-back" viewBox="0 0 10 17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 1.5 2 8.5l6.5 7" />
    </svg>
  );
}

export function PhoneFrame({
  title,
  variant,
  subline,
  composer,
  children,
  className = "",
  bodyClassName = "",
}: {
  title: string;
  variant: PhoneVariant;
  subline?: string;
  composer: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  const sms = variant === "sms";
  const group = variant === "group";
  const initials = group ? "SC" : title.slice(0, 1).toUpperCase();
  return (
    <div aria-hidden="true" className={`phone ${sms ? "phone-sms" : "phone-chat"} ${group ? "phone-group" : ""} ${className}`}>
      <span className="phone-bezel" />
      <div className="phone-screen">
        <span className="phone-island" />
        <div className="phone-status">
          <span className="phone-time">10:24</span>
          <svg className="phone-signals" viewBox="0 0 48 12" fill="currentColor">
            <rect x="0" y="8" width="3" height="4" rx="0.8" />
            <rect x="4.5" y="5.5" width="3" height="6.5" rx="0.8" />
            <rect x="9" y="3" width="3" height="9" rx="0.8" />
            <rect x="13.5" y="0" width="3" height="12" rx="0.8" />
            <path d="M24.5 3.2c2.2 0 4.2.9 5.7 2.3l-1.3 1.4a6.2 6.2 0 0 0-8.8 0l-1.3-1.4a8.3 8.3 0 0 1 5.7-2.3Zm0 3.6c1.2 0 2.3.5 3.1 1.3l-1.4 1.4a2.7 2.7 0 0 0-3.4 0L21.4 8.1c.8-.8 1.9-1.3 3.1-1.3Zm0 3.6 1.4 1.5h-2.8z" />
            <rect x="33" y="0.5" width="13" height="11" rx="3.2" fill="none" stroke="currentColor" strokeOpacity="0.45" />
            <rect x="34.5" y="2" width="10" height="8" rx="1.9" />
            <rect x="46.8" y="4" width="1.2" height="4" rx="0.6" fillOpacity="0.5" />
          </svg>
        </div>
        {sms ? (
          <div className="phone-head phone-head-sms">
            <Back />
            <span className="phone-avatar phone-avatar-sms">{initials}</span>
            <span className="phone-title">{title}</span>
          </div>
        ) : (
          <div className="phone-head phone-head-chat">
            <Back />
            <span className={`phone-avatar ${group ? "phone-avatar-group" : ""}`}>{initials}</span>
            <span className="phone-who">
              <span className="phone-title">{title}</span>
              {subline ? <span className="phone-subline">{subline}</span> : null}
            </span>
            <svg className="phone-tools" viewBox="0 0 44 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <rect x="1" y="3" width="11" height="10" rx="2.4" />
              <path d="m12 7 4.5-2.6v7.2L12 9" />
              <path d="M32.5 3.6c0 5.2 3.8 9 9 9l1.2-2.5-2.6-1.3-1 1c-1.2-.6-2.2-1.6-2.8-2.8l1-1-1.3-2.6z" />
            </svg>
          </div>
        )}
        <div className={`phone-body ${sms ? "" : "chat-wallpaper"} ${bodyClassName}`}>{children}</div>
        {sms ? (
          <div className="phone-composer phone-composer-sms">
            <span className="phone-plus">
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
                <path d="M6 1.5v9M1.5 6h9" />
              </svg>
            </span>
            <span className="phone-field">
              <span>{composer}</span>
              <svg viewBox="0 0 12 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <rect x="3.5" y="1" width="5" height="9" rx="2.5" />
                <path d="M1 8a5 5 0 0 0 10 0M6 13v2" />
              </svg>
            </span>
          </div>
        ) : (
          <div className="phone-composer phone-composer-chat">
            <span className="phone-field">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M5.2 9.6c.7 1.1 1.7 1.7 2.8 1.7s2.1-.6 2.8-1.7M5.8 6h.01M10.2 6h.01" />
              </svg>
              <span>{composer}</span>
            </span>
            <span className="phone-mic">
              <svg viewBox="0 0 16 16" fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round">
                <rect x="5.5" y="1.5" width="5" height="8" rx="2.5" fill="#fff" stroke="none" />
                <path d="M3.4 7.6a4.6 4.6 0 0 0 9.2 0M8 12.2v2.2" />
              </svg>
            </span>
          </div>
        )}
        <span className="phone-home" />
      </div>
    </div>
  );
}
