export function installFakeBunRuntime(): void {
  if (!("Bun" in globalThis)) {
    Object.defineProperty(globalThis, "Bun", {
      value: {},
      configurable: true,
      writable: true,
    });
  }
}
