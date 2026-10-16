import type { ReactNode } from "react";

/**
 * A phone-shaped frame for sample messages. Decorative: the figure that holds
 * it carries the accessible description, so the frame is hidden from
 * assistive tech.
 */
export function PhoneFrame({
  title,
  variant,
  children,
  className = "",
}: {
  title: string;
  variant: "sms" | "whatsapp";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div aria-hidden="true" className={`phone ${variant === "sms" ? "phone-sms" : ""} ${className}`}>
      <p className="phone-title">{title}</p>
      {children}
    </div>
  );
}
