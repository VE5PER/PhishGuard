"use client";

import React, { createContext, useCallback, useContext, useMemo, useState } from "react";
import { InstallModal } from "@/components/InstallModal";

interface InstallContextValue {
  openInstall: () => void;
}

const InstallContext = createContext<InstallContextValue | null>(null);

export function InstallProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const openInstall = useCallback(() => setIsOpen(true), []);
  const closeInstall = useCallback(() => setIsOpen(false), []);
  const value = useMemo(() => ({ openInstall }), [openInstall]);

  return (
    <InstallContext.Provider value={value}>
      {children}
      <InstallModal isOpen={isOpen} onClose={closeInstall} />
    </InstallContext.Provider>
  );
}

export function useInstall(): InstallContextValue {
  const ctx = useContext(InstallContext);
  if (!ctx) throw new Error("useInstall must be used within InstallProvider");
  return ctx;
}
