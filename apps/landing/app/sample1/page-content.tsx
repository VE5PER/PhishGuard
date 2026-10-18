"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, BriefcaseBusiness, Check, KeyRound } from "lucide-react";
import { SampleFooterNav } from "@/components/SampleFooterNav";

export default function MerenvaleWorkspace() {
  const [notice, setNotice] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNotice("We couldn't sign you in just now. Please try again shortly.");
  }

  return (
    <div className="min-h-screen bg-[#f4f7f5] text-[#24332d]" style={{ colorScheme: "light" }}>
      <header className="border-b border-[#e4eae6] bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3" aria-label="Merenvale Workspace">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#245b4b] text-white">
              <BriefcaseBusiness aria-hidden="true" className="h-5 w-5" />
            </span>
            <span>
              <span className="block font-display text-base font-bold tracking-tight">merenvale</span>
              <span className="block text-[10px] font-semibold uppercase tracking-[0.18em] text-[#6c7d74]">
                workspace
              </span>
            </span>
          </div>
          <a
            href="#help"
            className="rounded-full px-4 py-2 text-sm font-medium text-[#53665d] transition-colors hover:bg-[#f2f6f3] hover:text-[#245b4b] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#245b4b]"
          >
            Help
          </a>
        </div>
      </header>

      <main className="mx-auto grid min-h-[calc(100vh-9rem)] max-w-7xl items-center gap-8 px-5 py-10 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:gap-16 lg:py-16">
        <section className="relative overflow-hidden rounded-[2rem] bg-[#e8f0ec] px-7 py-9 sm:px-11 sm:py-12">
          <div aria-hidden="true" className="absolute -right-20 -top-24 h-72 w-72 rounded-full border border-[#cadbd1]" />
          <div aria-hidden="true" className="absolute -right-8 -top-12 h-48 w-48 rounded-full border border-[#cadbd1]" />
          <div className="relative">
            <p className="text-xs font-bold uppercase tracking-[0.19em] text-[#547568]">Workspace access</p>
            <h1 className="mt-6 max-w-lg font-display text-4xl font-medium leading-[1.08] tracking-[-0.045em] text-[#1c332a] sm:text-5xl">
              Make room for your best work.
            </h1>
            <p className="mt-5 max-w-md text-base leading-7 text-[#5c7066]">
              Your team&apos;s projects, notes, and plans are ready when you are.
            </p>

            <div className="mt-10 rounded-2xl border border-[#d4e2d9] bg-white/80 p-5 sm:p-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-semibold text-[#293d34]">A clear view of the week</p>
                  <p className="mt-1 text-xs text-[#73847b]">Your workspace, organized around the work.</p>
                </div>
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[#edf5ef] text-[#3e775d]">
                  <Check aria-hidden="true" className="h-5 w-5" />
                </span>
              </div>
              <div className="mt-5 space-y-3" aria-hidden="true">
                <div className="flex items-center gap-3 rounded-xl bg-[#f5f8f6] px-3 py-3">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#6da180]" />
                  <span className="h-2 w-2/5 rounded-full bg-[#cad7cf]" />
                  <span className="ml-auto h-2 w-1/5 rounded-full bg-[#e0e9e3]" />
                </div>
                <div className="flex items-center gap-3 rounded-xl bg-[#f5f8f6] px-3 py-3">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#d5b467]" />
                  <span className="h-2 w-1/3 rounded-full bg-[#cad7cf]" />
                  <span className="ml-auto h-2 w-1/4 rounded-full bg-[#e0e9e3]" />
                </div>
                <div className="flex items-center gap-3 rounded-xl bg-[#f5f8f6] px-3 py-3">
                  <span className="h-2.5 w-2.5 rounded-full bg-[#7b9eb1]" />
                  <span className="h-2 w-1/2 rounded-full bg-[#cad7cf]" />
                  <span className="ml-auto h-2 w-1/6 rounded-full bg-[#e0e9e3]" />
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-md rounded-[1.75rem] border border-[#e3e9e5] bg-white p-7 shadow-[0_24px_70px_-38px_rgba(29,54,42,0.28)] sm:p-10">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#edf5f0] text-[#36735b]">
            <KeyRound aria-hidden="true" className="h-5 w-5" />
          </div>
          <h2 className="mt-7 font-display text-2xl font-semibold tracking-[-0.035em] text-[#263a31]">
            Welcome back
          </h2>
          <p className="mt-2 text-sm leading-6 text-[#748178]">
            Sign in with your work account to continue.
          </p>

          <form className="mt-8 space-y-5" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="merenvale-email" className="mb-2 block text-sm font-semibold text-[#35483e]">
                Work email
              </label>
              <input
                id="merenvale-email"
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@company.com"
                className="min-h-12 w-full rounded-xl border border-[#dce4de] bg-white px-4 text-base text-[#263a31] outline-none transition focus:border-[#4c8a6b] focus:ring-4 focus:ring-[#dff0e5]"
              />
            </div>
            <div>
              <div className="mb-2 flex items-center justify-between gap-3">
                <label htmlFor="merenvale-password" className="text-sm font-semibold text-[#35483e]">
                  Password
                </label>
                <a href="#help" className="text-xs font-semibold text-[#3d765e] hover:text-[#245b4b]">
                  Forgot password?
                </a>
              </div>
              <input
                id="merenvale-password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                className="min-h-12 w-full rounded-xl border border-[#dce4de] bg-white px-4 text-base text-[#263a31] outline-none transition focus:border-[#4c8a6b] focus:ring-4 focus:ring-[#dff0e5]"
              />
            </div>
            <button
              type="submit"
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#245b4b] px-5 text-sm font-semibold text-white transition hover:bg-[#1e4d40] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#245b4b]"
            >
              Continue to workspace
              <ArrowRight aria-hidden="true" className="h-4 w-4" />
            </button>
            <p role="status" aria-live="polite" className="min-h-5 text-sm text-[#63776b]">
              {notice}
            </p>
          </form>

          <div className="mt-5 border-t border-[#edf0ed] pt-5 text-center">
            <p className="text-xs leading-5 text-[#89958e]">
              By continuing, you agree to your organization&apos;s access policies.
            </p>
          </div>
        </section>
      </main>

      <footer id="help" className="border-t border-[#e4eae6] bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-5 py-5 text-xs text-[#829087] sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-8">
          <span>© 2025 Merenvale Workspace</span>
          <span>Need help? Contact your workspace administrator.</span>
          <SampleFooterNav currentSample={1} tone="light" />
        </div>
      </footer>
    </div>
  );
}
