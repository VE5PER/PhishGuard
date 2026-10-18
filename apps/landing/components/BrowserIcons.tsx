import React from "react";

export function ChromeIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="12" cy="12" r="10" fill="#1e293b" />
      <path
        d="M12 2C7.58 2 3.84 5.04 2.87 9.15L8.06 14.34C8.02 13.91 8 13.46 8 13C8 10.79 9.79 9 12 9H21.8C20.67 4.96 16.73 2 12 2Z"
        fill="#EA4335"
      />
      <path
        d="M21.8 9H12C11.54 9 11.09 9.02 10.66 9.06L5.47 3.87C7.38 2.69 9.61 2 12 2C17.52 2 22 6.48 22 12C22 12.34 21.98 12.67 21.95 13H17C17 11.9 16.55 10.9 15.83 10.17L21.8 9Z"
        fill="#4285F4"
        opacity="0.9"
      />
      <path
        d="M12 17C9.79 17 8 15.21 8 13C8 12.54 8.02 12.09 8.06 11.66L2.87 6.47C2.32 8.13 2 9.9 2 12C2 17.52 6.48 22 12 22C15.65 22 18.84 20.04 20.58 17.1L15.39 11.91C14.66 14.86 12 17 12 17Z"
        fill="#34A853"
      />
      <path
        d="M12 22C16.42 22 20.16 18.96 21.13 14.85L15.94 9.66C15.98 10.09 16 10.54 16 11C16 13.21 14.21 15 12 15H2.2C3.33 19.04 7.27 22 12 22Z"
        fill="#FBBC05"
      />
      <circle cx="12" cy="12" r="4" fill="#FFFFFF" />
      <circle cx="12" cy="12" r="3" fill="#1A73E8" />
    </svg>
  );
}

export function BraveIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 2L3 6.5V11.5C3 17 6.8 22.1 12 23.5C17.2 22.1 21 17 21 11.5V6.5L12 2Z"
        fill="#FB542B"
      />
      <path
        d="M12 5.5L6 8.5V12C6 15.8 8.6 19.3 12 20.5C15.4 19.3 18 15.8 18 12V8.5L12 5.5Z"
        fill="#FF7654"
      />
      <path
        d="M12 8.5L8.5 10.2V12.3C8.5 14.5 10 16.5 12 17.2C14 16.5 15.5 14.5 15.5 12.3V10.2L12 8.5Z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

export function EdgeIcon({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M21.9 15.8C21.4 19.3 18.2 22 14.4 22C9.8 22 6 18.2 6 13.6C6 10.7 7.5 8.1 9.8 6.6C9.2 7.6 8.8 8.8 8.8 10.1C8.8 13.4 11.5 16.1 14.8 16.1C17.2 16.1 19.3 14.7 20.3 12.7C20.8 13.6 21.2 14.6 21.9 15.8Z"
        fill="#0078D7"
      />
      <path
        d="M14.4 2C18.6 2 22 5.4 22 9.6C22 10.8 21.7 12 21.2 13C20.2 10.5 17.6 8.7 14.6 8.7C10.9 8.7 7.9 11.7 7.9 15.4C7.9 15.9 8 16.4 8.1 16.9C5.6 15.2 4 12.3 4 9C4 5.1 7.1 2 11 2H14.4Z"
        fill="#00BCF2"
      />
    </svg>
  );
}

export function WebStoreBadge({ className = "w-4 h-4" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
    </svg>
  );
}
