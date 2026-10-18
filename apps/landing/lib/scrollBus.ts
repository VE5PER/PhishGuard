export interface ScrollState {
  y: number;
  vh: number;
}

type ScrollListener = (state: ScrollState) => void;
type Measurer = () => void;

const listeners = new Set<ScrollListener>();
const measurers = new Set<Measurer>();
const state: ScrollState = { y: 0, vh: 0 };

let nativeBound = false;
let envBound = false;
let nativeFrame = 0;
let measureFrame = 0;

function dispatch() {
  listeners.forEach((listener) => listener(state));
}

function onNativeScroll() {
  if (nativeFrame) return;
  nativeFrame = requestAnimationFrame(() => {
    nativeFrame = 0;
    state.y = window.scrollY;
    dispatch();
  });
}

function syncNativeListener() {
  const shouldBind = listeners.size > 0;
  if (shouldBind && !nativeBound) {
    window.addEventListener("scroll", onNativeScroll, { passive: true });
    nativeBound = true;
  } else if (!shouldBind && nativeBound) {
    window.removeEventListener("scroll", onNativeScroll);
    nativeBound = false;
    if (nativeFrame) {
      cancelAnimationFrame(nativeFrame);
      nativeFrame = 0;
    }
  }
}

function measureAll() {
  measureFrame = 0;
  state.vh = window.innerHeight;
  state.y = window.scrollY;
  measurers.forEach((measure) => measure());
  dispatch();
}

function scheduleMeasure() {
  if (!measureFrame) measureFrame = requestAnimationFrame(measureAll);
}

function bindEnvironment() {
  if (envBound) return;
  envBound = true;
  window.addEventListener("resize", scheduleMeasure, { passive: true });
  new ResizeObserver(scheduleMeasure).observe(document.documentElement);
  document.fonts?.ready.then(scheduleMeasure);
}

export function getScrollState(): ScrollState {
  return state;
}

export function subscribe(listener: ScrollListener): () => void {
  bindEnvironment();
  listeners.add(listener);
  syncNativeListener();
  return () => {
    listeners.delete(listener);
    syncNativeListener();
  };
}

export function registerMeasure(measure: Measurer): () => void {
  bindEnvironment();
  measurers.add(measure);
  state.vh = window.innerHeight;
  state.y = window.scrollY;
  measure();
  return () => {
    measurers.delete(measure);
  };
}

export function requestMeasure() {
  scheduleMeasure();
}
