// Anonymous device-based identity for v1. A UUID minted in the browser and kept
// in localStorage; sent as the x-device-id header on every entries request.
// No login, no provider. Data is tied to the device, not a person.
const KEY = "canlog-device-id";

export function getDeviceId(): string {
  if (typeof window === "undefined") return "";
  let id = window.localStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.localStorage.setItem(KEY, id);
  }
  return id;
}
