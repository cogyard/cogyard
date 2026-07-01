// jsdom lacks ResizeObserver; PrimeNG's TabList (shell nav) requires it.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver ??= ResizeObserverStub;
