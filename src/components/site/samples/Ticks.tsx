/**
 * Two grey ticks, the "delivered" mark in a chat app. Grey on purpose: blue
 * ticks would say a message was read, which we cannot see (Ruling W25/W39).
 * Decorative; the figure's label says "Delivered".
 */
export function Ticks() {
  return (
    <svg aria-hidden="true" className="wa-ticks" width="16" height="10" viewBox="0 0 16 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 5.4 3.9 8.2 9 1.8" />
      <path d="M6.4 6.6 7.4 8.2 12.5 1.8" />
    </svg>
  );
}
