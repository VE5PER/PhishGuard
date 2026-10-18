import { TelemetryCollector } from './telemetry-collector.js';

type CollectorWindow = Window & { __PHISHGUARD_COLLECTOR__?: TelemetryCollector };
const collectorWindow = window as CollectorWindow;

// Guard against double injection (manifest + re-injection after update): keep a live collector,
// replace one whose extension context was invalidated.
const existing = collectorWindow.__PHISHGUARD_COLLECTOR__;
if (existing && !existing.isOrphaned()) {
  void existing.dispatchTelemetryEvaluation(true, true);
  console.debug('[PhishGuard] Telemetry collector already active on:', window.location.hostname);
} else {
  existing?.destroy();
  // Initialize passive telemetry collector upon document idle
  const collector = new TelemetryCollector();
  collectorWindow.__PHISHGUARD_COLLECTOR__ = collector;

  console.debug('[PhishGuard] Telemetry collector active on:', window.location.hostname);
}
