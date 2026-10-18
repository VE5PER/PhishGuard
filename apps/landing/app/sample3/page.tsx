import type { Metadata } from "next";
import VantrelAccountReview from "./page-content";

export const metadata: Metadata = {
  title: "Vantrel | Account protection",
  description: "Review your Vantrel account access.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='18' fill='%23101f32'/%3E%3Cpath d='m32 10 19 8v14c0 12-8 20-19 26-11-6-19-14-19-26V18z' fill='%23d39968'/%3E%3Cpath d='m23 32 6 6 13-14' fill='none' stroke='%23101f32' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E",
  },
};

export default function Sample3Page() {
  return <VantrelAccountReview />;
}
