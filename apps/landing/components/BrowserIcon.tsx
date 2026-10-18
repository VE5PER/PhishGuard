import React from "react";
import { BraveIcon, ChromeIcon, EdgeIcon } from "@/components/BrowserIcons";
import type { BrowserInfo } from "@/lib/browserDetection";

export function BrowserIcon({ id, className }: { id: BrowserInfo["id"]; className?: string }) {
  switch (id) {
    case "brave":
      return <BraveIcon className={className} />;
    case "edge":
      return <EdgeIcon className={className} />;
    default:
      return <ChromeIcon className={className} />;
  }
}
