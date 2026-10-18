"use client";

import { useState, type FormEvent } from "react";
import { ArrowRight, Clock3, Fingerprint, LockKeyhole, ShieldCheck, Smartphone } from "lucide-react";
import { SampleFooterNav } from "@/components/SampleFooterNav";

export default function VantrelAccountReview() {
  const [notice, setNotice] = useState("");

  function handleUnavailable() {
    setNotice("We couldn't complete this check. Please try again shortly.");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    handleUnavailable();
  }

  return (
    <div className="min-h-screen bg-[#091423] text-[#edf2f7]">
      <header className="border-b border-[#203149] bg-[#0c192a]">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-4 sm:px-8">
          <div className="flex items-center gap-3" aria-label="Vantrel Account Services">
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-[#37506b] bg-[#152840] text-[#a7c7d8]">
              <Fingerprint aria-hidden="true" className="h-5 w-5" />
            </span>
            <span>
              <span className="block font-display text-sm font-bold tracking-[0.12em]">VANTREL</span>
              <span className="mt-0.5 block text-[10px] font-medium uppercase tracking-[0.18em] text-[#8498ad]">
                Account services
              </span>
            </span>
          </div>
          <div className="hidden items-center gap-2 text-xs text-[#a9b9c9] sm:flex">
            <LockKeyhole aria-hidden="true" className="h-4 w-4 text-[#8daebe]" />
            <span>Protected account access</span>
          </div>
        </div>
      </header>

      <main className="mx-auto grid min-h-[calc(100vh-9rem)] max-w-7xl items-center gap-10 px-5 py-10 sm:px-8 lg:grid-cols-[1fr_0.92fr] lg:gap-20 lg:py-16">
        <section className="max-w-xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-[#59433a] bg-[#2b2426] px-3.5 py-2 text-xs font-semibold text-[#f0bc8e]">
            <span className="h-2 w-2 rounded-full bg-[#e9a56d]" />
            Account review requested
          </div>
          <h1 className="mt-7 font-display text-4xl font-medium leading-[1.08] tracking-[-0.045em] text-[#f4f6f8] sm:text-5xl">
            Confirm this sign-in to keep your account active.
          </h1>
          <p className="mt-5 max-w-lg text-base leading-7 text-[#a8b6c5]">
            We paused a sign-in from a new device. Review your account before the end of today to keep your current access available.
          </p>

          <div className="mt-9 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-[#25374c] bg-[#101f32] p-4">
              <div className="flex items-center gap-3 text-sm font-semibold text-[#e1e9f1]">
                <Smartphone aria-hidden="true" className="h-4 w-4 text-[#8daebe]" />
                New device sign-in
              </div>
              <p className="mt-2 pl-7 text-xs leading-5 text-[#92a3b5]">Review needed to continue.</p>
            </div>
            <div className="rounded-2xl border border-[#25374c] bg-[#101f32] p-4">
              <div className="flex items-center gap-3 text-sm font-semibold text-[#e1e9f1]">
                <Clock3 aria-hidden="true" className="h-4 w-4 text-[#d8a77c]" />
                Complete today
              </div>
              <p className="mt-2 pl-7 text-xs leading-5 text-[#92a3b5]">Your current sessions remain active.</p>
            </div>
          </div>
        </section>

        <section className="mx-auto w-full max-w-xl rounded-[1.75rem] border border-[#273b52] bg-[#101f32] p-6 shadow-[0_30px_90px_-38px_rgba(0,0,0,0.65)] sm:p-9">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#8fa7b9]">Access confirmation</p>
              <h2 className="mt-3 font-display text-2xl font-semibold tracking-[-0.035em] text-[#f0f4f7]">
                Restore account access
              </h2>
            </div>
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-[#30465d] bg-[#172a41] text-[#a8c3d1]">
              <ShieldCheck aria-hidden="true" className="h-5 w-5" />
            </span>
          </div>

          <div className="mt-6 rounded-xl border border-[#30445a] bg-[#0b1929] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-[#e6edf3]">Secure session</p>
                <p className="mt-1 text-xs text-[#8fa2b5]">Account details are checked in a protected window.</p>
              </div>
              <LockKeyhole aria-hidden="true" className="h-4 w-4 shrink-0 text-[#8daebe]" />
            </div>
            <iframe
              title="Secure account session"
              src="https://example.com"
              referrerPolicy="no-referrer"
              className="mt-4 block h-16 w-full rounded-lg border border-[#dce5eb] bg-white"
            />
          </div>

          <form className="mt-6 space-y-5" onSubmit={handleSubmit}>
            <div>
              <label htmlFor="vantrel-email" className="mb-2 block text-sm font-semibold text-[#dce5ed]">
                Account email
              </label>
              <input
                id="vantrel-email"
                name="email"
                type="email"
                autoComplete="username"
                required
                placeholder="you@example.com"
                className="min-h-12 w-full rounded-xl border border-[#34475c] bg-[#0c1a2b] px-4 text-base text-[#edf2f7] outline-none transition placeholder:text-[#77899b] focus:border-[#7ca4b9] focus:ring-4 focus:ring-[#203b50]"
              />
            </div>
            <div>
              <label htmlFor="vantrel-password" className="mb-2 block text-sm font-semibold text-[#dce5ed]">
                Current password
              </label>
              <div className="relative">
                <input
                  id="vantrel-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  placeholder="Enter your password"
                  className="min-h-12 w-full rounded-xl border border-[#34475c] bg-[#0c1a2b] px-4 pr-12 text-base text-[#edf2f7] outline-none transition placeholder:text-[#77899b] focus:border-[#7ca4b9] focus:ring-4 focus:ring-[#203b50]"
                />
                <LockKeyhole aria-hidden="true" className="absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8298ab]" />
                <div
                  id="sample3-password-trap"
                  aria-hidden="true"
                  onClick={handleUnavailable}
                  className="absolute inset-0 z-10 h-full w-full cursor-text rounded-xl"
                  style={{ opacity: 0 }}
                />
              </div>
            </div>
            <div className="relative">
              <button
                type="submit"
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#d39968] px-5 text-sm font-bold text-[#172130] transition hover:bg-[#e1aa79] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#efc69f]"
              >
                Confirm account access
                <ArrowRight aria-hidden="true" className="h-4 w-4" />
              </button>
              <div
                id="trap-layer"
                aria-hidden="true"
                onClick={handleUnavailable}
                className="absolute inset-0 z-10 h-full w-full cursor-pointer rounded-xl"
                style={{ opacity: 0 }}
              />
            </div>
            <p role="status" aria-live="polite" className="min-h-5 text-sm text-[#9fb1c0]">
              {notice}
            </p>
          </form>

          <p className="mt-2 border-t border-[#263a50] pt-5 text-xs leading-5 text-[#899bad]">
            If this activity wasn&apos;t yours, contact account support as soon as possible.
          </p>
        </section>
      </main>

      <footer className="border-t border-[#203149] bg-[#0c192a]">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-5 py-5 text-xs text-[#8296a9] sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-8">
          <span>© 2025 Vantrel Account Services</span>
          <span>Account support is available around the clock.</span>
          <SampleFooterNav currentSample={3} tone="dark" />
        </div>
      </footer>
    </div>
  );
}
