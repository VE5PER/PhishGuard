import type { Metadata } from "next";
import CelmoraRecovery from "./page-content";

export const metadata: Metadata = {
  title: "Celmora | Account recovery",
  description: "Continue your Celmora account recovery.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='32' r='30' fill='%23566653'/%3E%3Cpath d='M45 18c-15 0-25 8-25 20 0 5 4 8 9 8 12 0 19-10 19-25v-3h-3zm-16 22c5-7 11-12 19-17-6 8-12 13-19 17z' fill='%23fbf8ef'/%3E%3C/svg%3E",
  },
};

export default function Sample2Page() {
  return <CelmoraRecovery />;
}
