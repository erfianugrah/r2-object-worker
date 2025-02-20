export function getContentTypeFromKey(key) {
  const extensions = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
  };
  const ext = key.split(".").pop()?.toLowerCase() || "";
  return extensions[ext] || "application/octet-stream";
}
