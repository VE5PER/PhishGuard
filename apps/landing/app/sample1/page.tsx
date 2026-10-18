import type { Metadata } from "next";
import MerenvaleWorkspace from "./page-content";

export const metadata: Metadata = {
  title: "Merenvale Workspace | Sign in",
  description: "Sign in to your Merenvale workspace.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%23245b4b'/%3E%3Cpath d='M17 46V18h8l7 10 7-10h8v28h-8V31l-7 9-7-9v15z' fill='%23fff'/%3E%3C/svg%3E",
  },
};

export default function Sample1Page() {
  return <MerenvaleWorkspace />;
}
