/**
 * sdpBitrate.ts — pure SDP munge to cap the *received* video bitrate.
 *
 * Kite is the offerer; a `b=AS`/`b=TIAS` bandwidth attribute on the video m-line
 * of our offer signals the Xbox encoder the max bitrate we want. Per RFC 4566 the
 * `b=` line must immediately follow the media section's `c=` line. `maxKbps === null`
 * strips any cap (Auto). Never throws — on unexpected SDP it returns the input
 * unchanged (fail-open = no cap = Auto behavior).
 */
export function applyVideoBitrateCap(sdp: string, maxKbps: number | null): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r\n|\r|\n/);
  const out: string[] = [];
  let inVideo = false;
  for (const line of lines) {
    if (line.startsWith("m=")) {
      inVideo = line.startsWith("m=video");
      out.push(line);
      continue;
    }
    // Drop any existing bandwidth lines within the video section; we re-add below.
    if (inVideo && (line.startsWith("b=AS:") || line.startsWith("b=TIAS:"))) {
      continue;
    }
    out.push(line);
    // Bandwidth must immediately follow the c= line (RFC 4566 ordering).
    if (inVideo && line.startsWith("c=") && maxKbps !== null) {
      out.push(`b=AS:${maxKbps}`);
      out.push(`b=TIAS:${maxKbps * 1000}`);
    }
  }
  return out.join(eol);
}
