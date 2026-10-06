const normalizeContentUrl = (value) => {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
  const pathname = url.pathname.replace(/\/+$/, "");

  // A YouTube video's identity is carried in `v` for watch URLs, or in
  // the first path segment for shortened and Shorts URLs. Canonicalizing
  // those forms together prevents duplicate submissions without collapsing
  // every distinct /watch?v= link into the same value.
  const isYouTube = hostname === "youtube.com" || hostname.endsWith(".youtube.com");
  const isShortYouTube = hostname === "youtu.be" || hostname.endsWith(".youtu.be");
  let videoId = "";

  if (isYouTube && pathname === "/watch") {
    videoId = url.searchParams.get("v") || "";
  } else if (isYouTube) {
    videoId = pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] || "";
  } else if (isShortYouTube) {
    videoId = pathname.split("/").filter(Boolean)[0] || "";
  }

  if (videoId) return `https://youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  return `https://${hostname}${pathname}`;
};

module.exports = normalizeContentUrl;
