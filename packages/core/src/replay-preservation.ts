import type { ReplayPreservation } from "./replay-archive";

export function preservationTitle(value: ReplayPreservation | undefined): string {
  if (!value) return "Asset preservation status unavailable";
  if (value.status === "legacy") return "Legacy replay: live assets";
  if (value.status === "disabled") return "Live assets: preservation was off";
  if (value.status === "pending") return "Asset preservation in progress";
  if (value.status === "partial") return "Some replay assets were not preserved";
  return value.total ? `${value.preserved} public ${value.preserved === 1 ? "asset" : "assets"} preserved` : "No external replay assets to preserve";
}

export function preservationDescription(value: ReplayPreservation | undefined): string {
  if (!value) return "This response did not include preservation details. It does not establish that the replay’s assets were saved.";
  if (value.status === "legacy") return "This recording predates asset preservation. Images, stylesheets, and fonts load from their current public URLs and may have changed or disappeared.";
  if (value.status === "disabled") return "Asset preservation was disabled for this recording. Images, stylesheets, and fonts depend on their current public URLs.";
  if (value.status === "pending") return "Permitted public assets are being saved. Resources that are not ready remain unavailable rather than loading a newer version from the site.";
  if (value.status === "partial") return "The replay uses saved copies where available. Missing, blocked, or quota-limited assets stay unavailable. Saved resources can still differ from the original page, especially when capture was delayed.";
  return "The replay uses saved public resources associated with this recording. Capture is bounded and does not include private or authenticated resources, video, or canvas.";
}
