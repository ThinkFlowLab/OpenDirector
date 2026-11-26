import { createHash } from "node:crypto";

/** Decode a frame from the actual downloaded file, independently of the editor preview. */
export async function playDownloadedMp4(page, button) {
  const pending = page.waitForEvent("download");
  await button.click();
  const stream = await (await pending).createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const playback = await page.evaluate(async encoded => {
    const video = document.createElement("video");
    video.muted = true;
    video.src = "data:video/mp4;base64," + encoded;
    let timer;
    try {
      const frame = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Downloaded MP4 produced no frame")), 10000);
        video.requestVideoFrameCallback(resolve);
      });
      await Promise.all([frame, video.play()]);
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      context.drawImage(video, 0, 0, 1, 1);
      return { width: video.videoWidth, height: video.videoHeight, duration: video.duration,
        pixel: [...context.getImageData(0, 0, 1, 1).data] };
    } finally {
      clearTimeout(timer);
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }, bytes.toString("base64"));
  return { ...playback, fingerprint: "sha256:" + createHash("sha256").update(bytes).digest("hex") };
}
