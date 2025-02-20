/**
 * Utilities for working with content types
 */
export class ContentTypeUtils {
  // Mapping of file extensions to MIME types
  static extensionMap = {
    // Images
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
    avif: "image/avif",
    ico: "image/x-icon",
    tiff: "image/tiff",
    tif: "image/tiff",
    bmp: "image/bmp",
    
    // Documents
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    txt: "text/plain",
    rtf: "application/rtf",
    
    // Web assets
    html: "text/html",
    htm: "text/html",
    css: "text/css",
    js: "text/javascript",
    json: "application/json",
    xml: "application/xml",
    
    // Archives
    zip: "application/zip",
    rar: "application/vnd.rar",
    gz: "application/gzip",
    tar: "application/x-tar",
    
    // Audio
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    m4a: "audio/m4a",
    
    // Video
    mp4: "video/mp4",
    webm: "video/webm",
    avi: "video/x-msvideo",
    mov: "video/quicktime",
    wmv: "video/x-ms-wmv",
    
    // Fonts
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    eot: "application/vnd.ms-fontobject",
  };

  /**
   * Get content type from file extension
   */
  static getContentTypeFromKey(key) {
    const ext = key.split(".").pop()?.toLowerCase() || "";
    return this.extensionMap[ext] || "application/octet-stream";
  }

  /**
   * Get object type category based on content type
   */
  static getObjectTypeFromContentType(contentType) {
    if (contentType.startsWith("image/")) {
      return "image";
    } else if (contentType.startsWith("video/")) {
      return "video";
    } else if (contentType.startsWith("audio/")) {
      return "audio";
    } else if (contentType.startsWith("font/") || contentType === "application/vnd.ms-fontobject") {
      return "font";
    } else if (
      contentType === "text/html" || 
      contentType === "application/pdf" || 
      contentType.includes("document") || 
      contentType.includes("presentation")
    ) {
      return "document";
    } else if (
      contentType === "text/css" || 
      contentType === "text/javascript" || 
      contentType === "application/json"
    ) {
      return "static";
    } else if (contentType.includes("archive") || contentType === "application/zip") {
      return "archive";
    }
    
    return "binary";
  }

  /**
   * Get object type category based on key
   */
  static getObjectTypeFromKey(key) {
    const contentType = this.getContentTypeFromKey(key);
    return this.getObjectTypeFromContentType(contentType);
  }
}