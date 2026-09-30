// Emulator is available only in the local Vite development build, never in production.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("testxr")) {
  const { XRDevice, metaQuest3 } = await import("iwer");
  const device = new XRDevice(metaQuest3, { stereoEnabled: true });
  device.installRuntime({ forceInstall: true });
  window.__xrTestDevice = device;
}
